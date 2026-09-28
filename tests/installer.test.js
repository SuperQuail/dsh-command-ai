// Exercise the real script with fake package/DSH commands; never change a real profile.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')
const installer = join(source, 'install.ps1')
const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
const supported = powershell.status === 0 && Number(powershell.stdout.trim()) >= 7
const options = { skip: !supported }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'commandcode-archive-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'test-dsh-home')
  const profile = join(home, 'profiles', 'web')
  const archive = join(root, 'archive cache')
  const log = join(root, 'calls.jsonl')
  const pnpm = join(root, 'fake-pnpm.ps1')
  const dsh = join(root, 'fake-dsh.ps1')
  writeFileSync(pnpm, `
@{tool='pnpm'; argv=@($args); cwd=(Get-Location).Path; home=$env:DSH_HOME; files=@(Get-ChildItem -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath((Get-Location).Path, $_.FullName) })} | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $env:TEST_INSTALL_LOG
if ($env:TEST_PACK_EXIT) { exit [int]$env:TEST_PACK_EXIT }
if ($env:TEST_PACK_EMPTY -ne '1') {
  if ($args[0] -ne 'pack' -or $args[1] -ne '--pack-destination') { throw 'Only pack is permitted' }
  $p = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
  'mock tarball' | Set-Content -LiteralPath (Join-Path $args[2] ($p.name + '-' + $p.version + '.tgz'))
}
exit 0
`)
  writeFileSync(dsh, `@{tool='dsh'; argv=@($args); cwd=(Get-Location).Path; home=$env:DSH_HOME} | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $env:TEST_INSTALL_LOG\nif ($env:TEST_DSH_EXIT) { exit [int]$env:TEST_DSH_EXIT }\nexit 0\n`)
  return {
    root, home, profile, archive, log, pnpm, dsh,
    run(extra = [], overrides = {}, supplied = {}) {
      const args = ['-NoProfile', '-File', installer, '-PackageDir', supplied.archive ?? archive, '-PnpmCommand', pnpm, '-DshCli', supplied.dsh ?? dsh]
      if (!supplied.omitHome) args.push('-DshHome', home)
      return spawnSync('pwsh', [...args, ...extra], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, TEST_INSTALL_LOG: log, TEST_PACK_EXIT: '', TEST_PACK_EMPTY: '', TEST_DSH_EXIT: '', ...overrides },
      })
    },
    calls() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)) : [] },
  }
}
function assertSuccess(result) { assert.equal(result.status, 0, result.stdout + '\n' + result.stderr) }
function assertFailure(result, expression) {
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, expression)
}
function packageFile(result) {
  const match = result.stdout.match(/^PACKAGE_FILE=(.+)$/m)
  assert(match, result.stdout)
  return match[1].trim()
}

test('requires an explicit profile unless pack-only; refusal has no side effects', options, t => {
  const f = fixture(t)
  assertFailure(f.run(), /Specify -Profile or -ProfileDir/)
  assert.equal(existsSync(f.archive), false)
  assert.equal(existsSync(f.home), false)
  assert.deepEqual(f.calls(), [])
})

test('pack-only stages an allowlist, never installs dependencies or registers DSH', options, t => {
  const f = fixture(t)
  const result = f.run(['-PackOnly'])
  assertSuccess(result)
  assert.match(result.stdout, /NOT registered or enabled/)
  const [pack] = f.calls()
  assert.equal(f.calls().length, 1)
  assert.deepEqual(pack.argv.slice(0, 2), ['pack', '--pack-destination'])
  const files = pack.files.map(file => file.replaceAll('\\', '/'))
  assert(files.includes('src/index.js'))
  assert(files.includes('src/provider.js'))
  assert(files.includes('client.js'))
  assert(files.includes('src/cli-reference.json'))
  assert(files.includes('src/discovery.js'))
  assert(!files.includes('PUBLISHING.md'))
  assert(files.includes('src/client.js'))
  for (const file of pack.files) assert.doesNotMatch(file, /node_modules|tests[\\/]|\.env|pnpm-lock/)
  assert.notEqual(pack.cwd, source)
  assert.equal(existsSync(pack.cwd), false, 'scratch staging is cleaned')
  assert.equal(existsSync(packageFile(result)), true, 'archive is retained for reinstall')
  assert.equal(existsSync(f.home), false)
})

test('registration passes an absolute tarball, NOT a directory or link', options, t => {
  const f = fixture(t)
  const result = f.run(['-Profile', 'web'])
  assertSuccess(result)
  const [pack, dsh] = f.calls()
  const tarball = packageFile(result)
  assert.deepEqual(dsh.argv, ['plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts'])
  assert.match(tarball, /\.tgz$/)
  assert.equal(dsh.home, f.home)
  assert(!dsh.argv.includes(source))
  assert(!dsh.argv.includes(pack.cwd))
  assert(!dsh.argv.includes(f.profile))
  assert.equal(existsSync(f.home), false, 'the script itself does not create profile files')
})

test('explicit existing profile directory is accepted and not overwritten', options, t => {
  const f = fixture(t)
  mkdirSync(f.profile, { recursive: true })
  const original = '{"name":"keep-profile-config"}'
  writeFileSync(join(f.profile, 'package.json'), original)
  const result = f.run(['-ProfileDir', f.profile])
  assertSuccess(result)
  assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), original)
  assert.deepEqual(readdirSync(f.profile), ['package.json'])
  assert.equal(f.calls()[1].home, f.home)
})

test('legacy InstallDir accepts a profile path and overrides ambient home explicitly', options, t => {
  const f = fixture(t)
  assertSuccess(f.run(['-InstallDir', f.profile], { DSH_HOME: join(f.root, 'wrong-ambient-home') }, { omitHome: true }))
  assert.equal(f.calls()[1].home, f.home)
})

test('conflicting profile/home arguments and source directory are refused before pack', options, t => {
  const f = fixture(t)
  for (const args of [
    ['-ProfileDir', f.profile, '-Profile', 'another-profile'],
    ['-ProfileDir', join(f.root, 'another-home', 'profiles', 'web')],
    ['-InstallDir', source],
    ['-ProfileDir', 'relative/profiles/web'],
  ]) assertFailure(f.run(args), /different profiles|different homes|must name a DSH profile|absolute path/)
  assert.deepEqual(f.calls(), [])
})

test('JavaScript DSH entry is run by node with the correct argument boundaries', options, t => {
  const f = fixture(t)
  const entry = join(f.root, 'fake cli.mjs')
  writeFileSync(entry, `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.TEST_INSTALL_LOG, JSON.stringify({tool:'dsh-js',argv:process.argv.slice(2),home:process.env.DSH_HOME})+'\\n');`)
  const result = f.run(['-Profile', 'web'], {}, { dsh: entry })
  assertSuccess(result)
  assert.equal(f.calls()[1].tool, 'dsh-js')
  assert.deepEqual(f.calls()[1].argv, ['plugin', '--profile', 'web', 'add', packageFile(result), '--ignore-scripts'])
})

test('pack failure stops before DSH and cleans scratch staging', options, t => {
  const f = fixture(t)
  const result = f.run(['-Profile', 'web'], { TEST_PACK_EXIT: '23' })
  assertFailure(result, /Failed during pack:.*exit 23/)
  assert.doesNotMatch(result.stdout, /succeeded|Packed successfully/)
  assert.deepEqual(f.calls().map(row => row.tool), ['pnpm'])
  assert.equal(existsSync(f.calls()[0].cwd), false)
})

test('missing tarball is an error even when pnpm returns zero', options, t => {
  const f = fixture(t)
  assertFailure(f.run(['-Profile', 'web'], { TEST_PACK_EMPTY: '1' }), /expected nonempty tarball/)
  assert.equal(f.calls().length, 1)
})

test('DSH failure is reported while the tarball is retained for retry', options, t => {
  const f = fixture(t)
  const result = f.run(['-Profile', 'web'], { TEST_DSH_EXIT: '24' })
  assertFailure(result, /Failed during DSH registration:.*exit 24/)
  assert.doesNotMatch(result.stdout, /registration command succeeded/)
  assert.equal(existsSync(packageFile(result)), true)
  assert.equal(existsSync(f.calls()[0].cwd), false)
})

test('WhatIf neither packs nor touches any profile', options, t => {
  const f = fixture(t)
  assertSuccess(f.run(['-Profile', 'web', '-WhatIf']))
  assert.equal(existsSync(f.archive), false)
  assert.equal(existsSync(f.home), false)
  assert.deepEqual(f.calls(), [])
})

test('missing DSH command fails before making an archive', options, t => {
  const f = fixture(t)
  rmSync(f.dsh)
  assertFailure(f.run(['-Profile', 'web']), /Command not found/)
  assert.equal(existsSync(f.archive), false)
})

test('archive cache cannot be under DSH_HOME or source', options, t => {
  const f = fixture(t)
  for (const archive of [join(f.home, 'packages'), source, join(source, 'packages')]) {
    assertFailure(f.run(['-PackOnly'], {}, { archive }), /PackageDir must be separate/)
  }
  assert.deepEqual(f.calls(), [])
})

test('repeated packs retain independent archives and PrepareOnly aliases PackOnly', options, t => {
  const f = fixture(t)
  const first = f.run(['-PackOnly'])
  const second = f.run(['-PrepareOnly'])
  assertSuccess(first)
  assertSuccess(second)
  assert.notEqual(packageFile(first), packageFile(second))
  assert.equal(existsSync(packageFile(first)), true)
  assert.equal(existsSync(packageFile(second)), true)
  assert.equal(f.calls().some(call => call.tool === 'dsh'), false)
})

test('manifest exposes a manual installer, never an install lifecycle', () => {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  assert.match(manifest.scripts['install:plugin'], /install\.ps1/)
  for (const field of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[field], undefined)
})
