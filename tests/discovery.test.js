import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverModels, parseDiscoveredModels } from '../src/discovery.js'
import { buildModels } from '../src/provider.js'
import { createClientPlugin } from '../src/client.js'
import catalog from '../src/catalog.json' with { type: 'json' }
import reference from '../src/cli-reference.json' with { type: 'json' }
const helpers = createClientPlugin({}, catalog.data, reference).helpers
const endpoint = 'https://api.commandcode.ai/provider/v1'
const id = 'future/model-not-yet-bundled'
const input = { id, api: 'openai-completions', contextWindow: '256K', maxTokens: '8K', input: ['text', 'image'] }
const payload = { data: [{ id, name: 'New model', context_length: 256000, max_output_tokens: 8000, input_modalities: ['text', 'image'], supported_endpoints: ['/chat/completions'] }] }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

test('directory parser only adopts bounded, deduplicated model metadata', () => {
  const rows = parseDiscoveredModels({ data: [...payload.data, ...payload.data, { id: 'only-id' }, { id: '__proto__' }, { id: 'bad id' }, { id: 'non-chat', supported_endpoints: ['/systemone'] }] })
  assert.deepEqual(rows, [{ id, name: 'New model', contextWindow: 256000, maxTokens: 8000, inputModalities: ['text', 'image'] }, { id: 'only-id' }])
  assert.throws(() => parseDiscoveredModels({ error: 'private upstream data' }), /invalid model directory/)
  assert.throws(() => parseDiscoveredModels({ data: Array(5001).fill({ id }) }))
})

test('discovery GET uses saved endpoint credential without writing or returning it', async () => {
  const rows = await discoverModels({ provider: 'commandcode', baseURL: endpoint + '/' }, { baseURL: endpoint, apiKeyEnv: 'TEST_KEY' }, async ref => { assert.equal(ref, 'TEST_KEY'); return 'fake-secret' }, undefined, async (url, options) => {
    assert.equal(url, endpoint + '/models')
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer fake-secret')
    assert(options.signal instanceof AbortSignal)
    return json(payload)
  })
  assert.equal(rows[0].id, id)
  assert(!JSON.stringify(rows).includes('fake-secret'))
})

test('changed endpoint never receives saved credentials; explicit draft key is one-shot', async () => {
  for (const apiKey of [undefined, 'one-shot']) {
    await discoverModels({ baseURL: 'https://other.invalid/v1', ...(apiKey ? { apiKey } : {}) }, { baseURL: endpoint }, () => assert.fail('must not read original key'), undefined, async (_url, options) => {
      assert.equal(options.headers.authorization, apiKey ? 'Bearer one-shot' : undefined)
      return json(payload)
    })
  }
})

test('discovery fails closed for errors, redirects, oversized bodies and cancellation', async () => {
  for (const fake of [
    async () => new Response('fake-secret', { status: 401 }),
    async () => new Response('fake-secret', { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
    async () => new Response('fake-secret', { headers: { 'content-length': '4000000' } }),
    async () => new Response('x'.repeat(3 * 1024 * 1024 + 1)),
    async () => { throw new Error('fake-secret') },
  ]) await assert.rejects(discoverModels({ baseURL: endpoint, apiKey: 'fake-secret' }, undefined, () => {}, undefined, fake), error => !error.message.includes('fake-secret') && /discovery failed/.test(error.message))
  await assert.rejects(discoverModels({ baseURL: endpoint }, { baseURL: endpoint }, () => { throw new Error('fake-secret') }), /cannot resolve discovery credential/)
  const abort = AbortSignal.abort()
  await assert.rejects(discoverModels({ baseURL: endpoint }, undefined, () => {}, abort, async (_url, options) => { options.signal.throwIfAborted() }), /cancelled or timed out/)
})

test('manual model addition accepts new IDs, requires protocol/capacity and retains selections', () => {
  const initial = helpers.draftOf({ models: [{ id: 'gpt-6-astra' }] })
  const draft = helpers.addCustom(initial, input)
  assert.deepEqual(draft.modelIds, ['gpt-6-astra', id])
  assert.deepEqual(initial.customModels, [])
  assert(helpers.directory(draft).some(row => row.id === id))
  const models = buildModels(catalog, { customModels: draft.customModels, models: [{ id }] })
  assert.equal(models[0].id, id)
  assert.equal(models[0].contextWindow, 256000)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].reasoning, false, 'unknown models do not guess reasoning levels')
  for (const invalid of [{ id: 'gpt-6-astra' }, { id: '__proto__' }, { id: 'bad id' }, { api: '' }, { contextWindow: '' }, { maxTokens: '0' }]) assert.throws(() => helpers.addCustom(initial, { ...input, ...invalid }))
  assert.throws(() => helpers.addCustom(draft, input))
  assert.throws(() => buildModels(catalog, { customModels: [{ ...draft.customModels[0], api: 'auto' }] }))
})

test('fetch action returns candidates only, never writes credentials or settings', async () => {
  const remote = { llm: { discoverModels: async (ns, request) => {
    assert.equal(ns, 'llm-commandcode')
    assert.deepEqual(request, { provider: 'commandcode', baseURL: endpoint, apiKey: 'temporary' })
    return { ok: true, value: parseDiscoveredModels(payload) }
  } } }
  assert.equal((await helpers.fetchDirectory(remote, 'llm-commandcode', endpoint + '/', 'temporary'))[0].id, id)
  await assert.rejects(helpers.fetchDirectory(remote, 'llm-commandcode', 'https://user:pass@example.invalid', ''), /invalidURL/)
})

function saveFixture(config) {
  let saved
  const state = { writable: true, view: { revision: 1 }, config }
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'llm-commandcode', revision: 1, value: { providers: { commandcode: config } } }] } }),
      mutate: async (_ns, ops) => { saved = ops[0].value; return { ok: true } },
    },
    credentials: { describe: async () => ({ ok: true, value: { CMD_API_KEY: { writable: true, configured: true } } }), set: () => assert.fail('must preserve credential') },
  }
  return { save: draft => helpers.save(remote, 'llm-commandcode', state, draft, ''), saved: () => saved }
}

test('adding, editing and removing custom models persists without dropping unrelated overrides', async () => {
  const config = { models: [{ id: 'gpt-6-astra' }], modelOverrides: { 'gpt-6-astra': { input: ['text'] } } }
  const draft = helpers.addCustom(helpers.draftOf(config), input)
  draft.modelEdits[id] = { ...helpers.modelDraft(draft, id), reasoningEfforts: { high: 'high' } }
  const add = saveFixture(config)
  assert.equal((await add.save(draft)).ok, true)
  const saved = add.saved()
  assert.deepEqual(saved.modelOverrides['gpt-6-astra'], config.modelOverrides['gpt-6-astra'])
  assert.equal(buildModels(catalog, saved).find(row => row.id === id).thinkingLevelMap.high, 'high')
  const remove = saveFixture(saved)
  assert.equal((await remove.save(helpers.removeCustom(helpers.draftOf(saved), id))).ok, true)
  assert.deepEqual(remove.saved().customModels, [])
  assert.equal(remove.saved().modelOverrides[id], undefined)
  assert.equal(buildModels(catalog, remove.saved()).length, 1)
})
