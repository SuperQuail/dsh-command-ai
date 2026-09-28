// Dependency-free release preflight; never imports/executes the plugin itself.
import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-command-ai')
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
assert.equal(manifest.type, 'module')
assert.equal(manifest.main, manifest.exports['.'])
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.profile, undefined, 'a bundle must not declare a profile')
assert.equal(manifest.private, true)
assert.equal(manifest.license, 'UNLICENSED')
for (const script of ['prepare', 'prepack', 'postpack', 'preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[script], undefined, `${script} must not execute on user install/pack`)
for (const version of Object.values({ ...manifest.dependencies, ...manifest.peerDependencies })) assert(!/^(?:workspace:|link:|file:|[A-Za-z]:|\/)/.test(version), 'dependency must not point at a local checkout')
if (process.env.DSH_RELEASE_TAG) assert.equal(process.env.DSH_RELEASE_TAG, `v${manifest.version}`, 'release tag must match package version')
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /^- insert:/)
assert.match(patch, /\bname: dsh-command-ai\s/)
assert.match(patch, /\bid: llm-commandcode\s/)

const expected = new Set(['package.json'])
async function include(path) {
  assert(!path.includes('..') && !path.startsWith('/') && !path.includes('\\'), 'unsafe runtime path')
  const stat = await lstat(resolve(root, path))
  assert(!stat.isSymbolicLink(), `runtime file must not be a symlink: ${path}`)
  if (stat.isDirectory()) for (const child of await readdir(resolve(root, path))) await include(`${path}/${child}`)
  else { assert(stat.isFile()); expected.add(path) }
}
for (const path of manifest.files) await include(path)
for (const path of expected) {
  assert(!/(?:^|\/)(?:node_modules|tests|\.env[^/]*|\.git|\.dsh)(?:\/|$)/.test(path))
  if (!path.endsWith('.js')) continue
  execFileSync(process.execPath, ['--check', resolve(root, path)], { stdio: 'inherit' })
  const source = await readFile(resolve(root, path), 'utf8')
  for (const [, dependency] of source.matchAll(/\bfrom\s+['"](\.\/[^'"]+)['"]/g)) assert(expected.has(posix.join(posix.dirname(path), dependency)), `missing runtime import: ${dependency}`)
}
for (const value of Object.values(manifest.exports)) if (!value.includes('*')) assert(expected.has(value.replace(/^\.\//, '')), `unpackaged export: ${value}`)
console.log(`Manifest, patch, imports and ${expected.size} runtime files checked.`)

if (process.argv[2]) {
  const archive = gunzipSync(await readFile(resolve(process.argv[2])), { maxOutputLength: 16 * 1024 * 1024 })
  const actual = new Set()
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const text = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0]
    const sizeText = text(124, 136).trim()
    assert.match(sizeText, /^[0-7]+$/)
    const size = parseInt(sizeText, 8)
    const prefix = text(345, 500)
    const name = `${prefix ? prefix + '/' : ''}${text(0, 100)}`
    const type = text(156, 157)
    assert(['', '0', '5'].includes(type), `unsupported tar entry (links/extended headers are refused): ${name}`)
    assert(offset + 512 + size <= archive.length, 'truncated tarball')
    if (type !== '5') {
      assert(name.startsWith('package/'), `unexpected archive prefix: ${name}`)
      const path = name.slice(8)
      assert(expected.has(path), `unexpected packed file: ${path}`)
      assert(!actual.has(path), `duplicate packed file: ${path}`)
      const packed = archive.subarray(offset + 512, offset + 512 + size)
      // pnpm reformats/reorders package.json while packing; compare its full
      // semantics, while every other runtime file must remain byte-identical.
      if (path === 'package.json') assert.deepEqual(JSON.parse(packed.toString('utf8')), manifest, 'packed manifest differs')
      else assert.deepEqual(packed, await readFile(resolve(root, path)), `packed bytes differ: ${path}`)
      actual.add(path)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'tarball must contain every runtime file, and nothing else')
  console.log(`Tarball verified: ${actual.size} files, matching current release bytes.`)
}
