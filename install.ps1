#requires -Version 7.0
<#
.SYNOPSIS
Pack CommandCode and let DSH install the tarball into the selected profile.
.EXAMPLE
pwsh -File ./install.ps1 -Profile web
.EXAMPLE
pwsh -File ./install.ps1 -ProfileDir 'C:\Users\admin\.dsh\profiles\web' -DshCli 'F:\Develop\deepseek-harness\apps\cli\lib\bin.js'
.EXAMPLE
pwsh -File ./install.ps1 -PackOnly
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string] $Profile,
    [Alias('InstallDir')]
    [string] $ProfileDir,
    [string] $DshCli = 'dsh',
    [string] $DshHome,
    [string] $PackageDir,
    [string] $PnpmCommand = 'pnpm',
    [Alias('PrepareOnly')]
    [switch] $PackOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$staging = $null
$stage = 'preflight'

function Get-PhysicalPath([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) }
    if ($full -eq $root) { return $full }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $resolved = $item.ResolveLinkTarget($true)
            if ($null -eq $resolved) { throw "Cannot resolve link: $full" }
            return Get-PhysicalPath $resolved.FullName
        }
    }
    $parent = [IO.Path]::GetDirectoryName($full)
    if ([string]::IsNullOrEmpty($parent)) { return $full }
    return [IO.Path]::Combine((Get-PhysicalPath $parent), [IO.Path]::GetFileName($full))
}
function Test-InTree([string] $Child, [string] $Parent) {
    $parentPath = $Parent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $Child.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Absolute-Path([string] $Path, [string] $Label) {
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw "$Label must be an absolute path." }
    return Get-PhysicalPath $Path
}
function Resolve-Program([string] $Name) {
    $found = Get-Command -Name $Name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $found) { throw "Command not found: $Name. Provide its path, or use -PackOnly without DSH registration." }
    return $found.Source
}
function Invoke-Checked([string] $Program, [string[]] $Arguments) {
    $global:LASTEXITCODE = 0
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Program" }
}

try {
    $source = Get-PhysicalPath $PSScriptRoot
    $homeValue = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    $effectiveHome = Absolute-Path $homeValue 'DshHome/DSH_HOME'
    if ($ProfileDir) {
        $profilePath = Absolute-Path $ProfileDir 'ProfileDir/InstallDir'
        $profilesPath = Split-Path -Parent $profilePath
        if ((Split-Path -Leaf $profilesPath) -ine 'profiles') { throw 'ProfileDir/InstallDir must name a DSH profile: <DSH_HOME>\profiles\<name>, not the source directory.' }
        $inferredProfile = Split-Path -Leaf $profilePath
        $inferredHome = Split-Path -Parent $profilesPath
        if ($Profile -and $Profile -cne $inferredProfile) { throw 'Profile and ProfileDir refer to different profiles.' }
        if ($DshHome -and -not $effectiveHome.Equals($inferredHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'DshHome and ProfileDir refer to different homes.' }
        $Profile = $inferredProfile
        # An explicit profile directory takes precedence over the ambient DSH_HOME.
        $effectiveHome = $inferredHome
    }
    if (-not $PackOnly -or $Profile) {
        if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]*$') { throw 'Specify -Profile or -ProfileDir explicitly (for example: -Profile web).' }
        if ($Profile -ieq 'desktop' -and -not $PackOnly) { throw 'Use -PackOnly and install the tarball through the Desktop plugin manager.' }
    }
    $profilePath = if ($Profile) { Get-PhysicalPath (Join-Path (Join-Path $effectiveHome 'profiles') $Profile) } else { $null }
    if ($profilePath) {
        if ((Test-InTree $profilePath $source) -or (Test-InTree $source $profilePath)) { throw 'The DSH profile and source directory must not overlap.' }
        if ((Test-Path -LiteralPath $profilePath) -and -not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw 'ProfileDir is not a directory.' }
    }
    $cache = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $cache) { $cache = Join-Path $HOME '.cache' }
    $archiveBase = if ($PackageDir) { Absolute-Path $PackageDir 'PackageDir' } else { Get-PhysicalPath (Join-Path $cache 'DSH-Plugin-Packages\commandcode') }
    if ((Test-InTree $archiveBase $source) -or (Test-InTree $source $archiveBase) -or (Test-InTree $archiveBase $effectiveHome)) {
        throw 'PackageDir must be separate from the source directory and outside DSH_HOME. Only DSH may write the profile.'
    }
    if ((Test-Path -LiteralPath $archiveBase) -and -not (Test-Path -LiteralPath $archiveBase -PathType Container)) { throw 'PackageDir is not a directory.' }

    # Use the manifest's runtime allowlist, expanding directories such as src.
    $manifest = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
    $files = @('package.json')
    foreach ($entry in $manifest.files) {
        $target = Join-Path $source $entry
        if (-not (Test-Path -LiteralPath $target)) { throw "Missing plugin path: $entry" }
        if (-not (Test-InTree (Get-PhysicalPath $target) $source)) { throw "Runtime path links outside the plugin: $entry" }
        if (Test-Path -LiteralPath $target -PathType Container) {
            $files += @(Get-ChildItem -LiteralPath $target -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($source, $_.FullName) })
        } else { $files += $entry }
    }
    $files = @($files | Select-Object -Unique)
    foreach ($relative in $files) {
        $file = Join-Path $source $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing plugin file: $relative" }
        if (-not (Test-InTree (Get-PhysicalPath $file) $source)) { throw "Source file links outside the plugin: $relative" }
    }
    if ($manifest.name -ne 'dsh-command-ai' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Invalid CommandCode package manifest.' }
    foreach ($hook in @('preinstall', 'install', 'postinstall', 'prepack', 'prepare', 'postpack', 'prepublish', 'prepublishOnly')) {
        if ($manifest.scripts.PSObject.Properties.Name -contains $hook) { throw "Unexpected package lifecycle script: $hook. Review it before packaging." }
    }
    Write-Host "Source:       $source"
    Write-Host "DSH home:     $effectiveHome"
    if ($PackOnly) { Write-Host 'Mode:         pack only; do not change any DSH profile' }
    else { Write-Host "Profile:      $profilePath"; Write-Host "Install into: $(Join-Path $profilePath 'node_modules\dsh-command-ai') (DSH-managed)" }
    Write-Host "Archive cache: $archiveBase"
    $operationTarget = if ($PackOnly) { $archiveBase } else { $profilePath }
    if (-not $PSCmdlet.ShouldProcess($operationTarget, 'Pack a tarball and optionally install it through the official DSH plugin manager')) { return }

    # Resolve executables before creating files; never guess another DSH installation.
    $pnpm = Resolve-Program $PnpmCommand
    $node = Resolve-Program 'node'
    $dshProgram = $null
    $dshPrefix = @()
    if (-not $PackOnly) {
        if ([IO.Path]::GetExtension($DshCli) -in @('.js', '.mjs', '.cjs')) {
            if (-not (Test-Path -LiteralPath $DshCli -PathType Leaf)) { throw "DSH CLI entry does not exist: $DshCli" }
            $dshProgram = $node
            $dshPrefix = @((Resolve-Path -LiteralPath $DshCli).Path)
        } else { $dshProgram = Resolve-Program $DshCli }
    }
    Invoke-Checked $node @('-e', 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19)){console.error("Node >=22.19 is required");process.exit(1)}')

    $stage = 'pack'
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('commandcode-pack-' + [guid]::NewGuid().ToString('N'))
    $archiveDir = Join-Path $archiveBase ($manifest.version + '-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging, $archiveDir | Out-Null
    foreach ($relative in $files) {
        $destination = Join-Path $staging $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
    }
    @'
packages:
  - '.'
autoInstallPeers: false
ignoreScripts: true
'@ | Set-Content -LiteralPath (Join-Path $staging 'pnpm-workspace.yaml') -Encoding utf8
    Push-Location -LiteralPath $staging
    try {
        foreach ($file in $files) {
            if ([IO.Path]::GetExtension($file) -eq '.js') { Invoke-Checked $node @('--check', $file) }
        }
        # No local install or link: dependencies are installed by DSH for the packed package.
        Invoke-Checked $pnpm @('pack', '--pack-destination', $archiveDir)
    } finally { Pop-Location }
    $tarball = Join-Path $archiveDir ($manifest.name + '-' + $manifest.version + '.tgz')
    if (-not (Test-Path -LiteralPath $tarball -PathType Leaf) -or (Get-Item -LiteralPath $tarball).Length -eq 0) { throw 'pnpm did not produce the expected nonempty tarball.' }
    Write-Host "PACKAGE_FILE=$tarball"

    if ($PackOnly) {
        Write-Host 'Packed successfully. NOT registered or enabled in DSH.'
        Write-Host (ConvertTo-Json -InputObject @{ action = 'install_bundle'; target = $tarball } -Compress)
    } else {
        $stage = 'DSH registration'
        $previousHome = $env:DSH_HOME
        Push-Location -LiteralPath $archiveDir
        try {
            $env:DSH_HOME = $effectiveHome
            Invoke-Checked $dshProgram ($dshPrefix + @('plugin', '--profile', $Profile, 'add', $tarball, '--ignore-scripts'))
        } finally { $env:DSH_HOME = $previousHome; Pop-Location }
        Write-Host "DSH registration command succeeded for profile '$Profile'."
        Write-Host 'The installed package lives in the profile node_modules; it is NOT a link to the source or staging directory.'
        Write-Host 'Restart the intended DSH instance and check that CommandCode is enabled. Previously disabled bundles require explicit enablement.'
    }
    Write-Host 'Keep the cached .tgz for future dependency reinstalls. Runtime does not depend on the original source directory.'
} catch {
    Write-Error -Message ("Failed during ${stage}: " + $_.Exception.Message + ' No successful installation is implied.') -ErrorAction Continue
    exit 1
} finally {
    # Delete only the scratch directory created by this invocation, never a profile or archive.
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
