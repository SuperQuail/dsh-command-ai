import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createClientPlugin } from '../src/client.js'

const catalog = [{ id: 'gpt-6-astra', name: 'GPT' }, { id: 'claude-sonnet-4-6', name: 'Claude' }]
const helpers = createClientPlugin({}, catalog).helpers
const ns = 'llm-commandcode'
const good = value => ({ ok: true, value })
function fixture({ config = {}, configured = false, writable = true, credentialWritable = true } = {}) {
  let revision = 3
  let profile = config
  let hasKey = configured
  const calls = []
  const remote = {
    settings: {
      async describe() { return good({ writable, namespaces: [{ ns, revision, value: { providers: { commandcode: profile } } }] }) },
      async mutate(namespace, ops, expectedRevision) {
        calls.push(['mutate', namespace, ops, expectedRevision])
        if (expectedRevision !== revision) return { ok: false, error: { code: 'settings/conflict' } }
        profile = ops[0].value; revision++
        return good({ ns, revision, value: { providers: { commandcode: profile } } })
      },
    },
    credentials: {
      async describe(refs) { return good({ [refs[0]]: { configured: hasKey, writable: credentialWritable } }) },
      async set(ref, key) { calls.push(['key', ref, key]); hasKey = true; return good() },
    },
  }
  return { remote, calls, bump: () => revision++ }
}
async function save(f, key = 'fake-secret', draft) {
  const state = await helpers.load(f.remote, ns)
  return helpers.save(f.remote, ns, state, draft ?? helpers.draftOf(state.config), key)
}

test('add card stores a credential separately then materializes its settings profile', async () => {
  const f = fixture()
  const result = await save(f)
  assert.deepEqual(result, { ok: true, keyStored: true })
  assert.equal(f.calls[0][0], 'key')
  assert.equal(f.calls[0][1], 'CMD_API_KEY')
  const [, namespace, ops, revision] = f.calls[1]
  assert.equal(namespace, ns)
  assert.equal(revision, 3)
  assert.deepEqual(ops[0].path, ['providers', 'commandcode'])
  assert.equal(ops[0].value.apiKeyEnv, 'CMD_API_KEY')
  assert.equal(ops[0].value.omitReasoningSummary, true)
  assert.equal(ops[0].value.baseURL, 'https://api.commandcode.ai/provider/v1')
  assert(!JSON.stringify(ops).includes('fake-secret'))
})

test('blank key retains stored or environment credential; missing key refuses to save', async () => {
  const kept = fixture({ configured: true, credentialWritable: false })
  assert.equal((await save(kept, '')).ok, true)
  assert.equal(kept.calls.length, 1)
  assert.equal(kept.calls[0][0], 'mutate')
  const missing = fixture()
  assert.equal((await save(missing, '')).code, 'required')
  assert.equal(missing.calls.length, 0)
})

test('read-only settings and locked credential reject before writes', async () => {
  const readonly = fixture({ writable: false })
  assert.equal((await save(readonly)).code, 'readOnly')
  assert.equal(readonly.calls.length, 0)
  const locked = fixture({ credentialWritable: false })
  assert.equal((await save(locked)).code, 'locked')
  assert.equal(locked.calls.length, 0)
})

test('stale revision refuses before overwriting any credential', async () => {
  const f = fixture()
  const state = await helpers.load(f.remote, ns)
  f.bump()
  const result = await helpers.save(f.remote, ns, state, helpers.draftOf({}), 'fake-secret')
  assert.equal(result.code, 'conflict')
  assert.equal(f.calls.length, 0)
})

test('invalid URL or empty/unknown model selection never writes a credential', async () => {
  const drafts = [
    { baseURL: 'http://example.com/v1' }, { baseURL: 'https://user:pass@example.com/v1' },
    { baseURL: 'https://example.com/v1?key=secret' }, { baseURL: 'not a url' },
    { allModels: false, modelIds: [] }, { allModels: false, modelIds: ['unknown'] },
  ]
  for (const invalid of drafts) {
    const f = fixture()
    assert.equal((await save(f, 'fake-secret', { ...helpers.draftOf({}), ...invalid })).ok, false)
    assert.equal(f.calls.length, 0)
  }
})

test('editing preserves advanced metadata and selects models without duplicating ids', async () => {
  const old = { id: catalog[0].id, input: ['text', 'image'], maxTokens: 4096 }
  const f = fixture({ config: { apiKeyEnv: 'CUSTOM_CMD_KEY', models: [old], timeoutMs: 99, modelOverrides: { [catalog[0].id]: { reasoningEfforts: { high: 'high' } } } } })
  const draft = { ...helpers.draftOf({}), allModels: false, modelIds: [catalog[0].id, catalog[0].id], preferResponses: true }
  assert.equal((await save(f, 'fake-secret', draft)).ok, true)
  assert.equal(f.calls[0][1], 'CUSTOM_CMD_KEY')
  const config = f.calls[1][2][0].value
  assert.deepEqual(config.models, [old])
  assert.equal(config.timeoutMs, 99)
  assert.equal(config.preferResponses, true)
  assert.deepEqual(config.modelOverrides[catalog[0].id].reasoningEfforts, { high: 'high' })
})

test('partial failure reports stored key without leaking it or rolling back other work', async () => {
  const f = fixture()
  f.remote.settings.mutate = async () => ({ ok: false, error: { code: 'settings/conflict', message: 'fake-secret' } })
  const result = await save(f)
  assert.deepEqual(result, { ok: false, code: 'partial', keyStored: true })
  assert(!JSON.stringify(result).includes('fake-secret'))
  assert.equal(f.calls.length, 1)
})

test('credential refusal never mutates settings and does not echo remote errors', async () => {
  const f = fixture()
  f.remote.credentials.set = async () => { throw new Error('fake-secret') }
  assert.deepEqual(await save(f), { ok: false, code: 'saveFailed', keyStored: false })
  assert.equal(f.calls.length, 0)
})

test('absent or failed namespace reads fail closed', async () => {
  const remote = { settings: { describe: async () => good({ namespaces: [], writable: true }) } }
  await assert.rejects(helpers.load(remote, ns), /unavailable/)
  remote.settings.describe = async () => ({ ok: false })
  await assert.rejects(helpers.load(remote, ns), /remote-failed/)
})

test('browser artifact loads only React and registers the supported card slot with cleanup', async () => {
  let module
  let registration
  let disposed = 0
  let dictionaries
  const code = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  runInNewContext(code, { window: { __ModuleLoader__: { load: value => { module = value } } }, URL })
  assert.equal(module.id, 'dsh-command-ai')
  const client = module.factory(name => { assert.equal(name, 'react'); return {} })
  const effects = []
  const ctx = {
    effect: factory => effects.push(factory()),
    locale: { register: (_ns, dicts) => { dictionaries = dicts; return () => disposed++ }, bind: () => key => key },
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.models.provider-card'); effects.push(callback()) },
      register: (options, component) => { registration = { options, component }; return () => disposed++ },
    },
  }
  client.apply(ctx)
  assert.equal(registration.options.key, ns)
  assert.equal(typeof registration.component, 'function')
  assert.match(dictionaries.zh.save, /保存/)
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
  effects.forEach(dispose => dispose())
  assert.equal(disposed, 2)
  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.|fetch\(|console\./)
})

test('built browser artifact includes current source and every catalogue model', async () => {
  const code = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'))
  assert(code.includes(createClientPlugin.toString()), 'run npm run build after editing client source')
  for (const model of catalog.data) assert(code.includes(JSON.stringify(model.id)))
})
