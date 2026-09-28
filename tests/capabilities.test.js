import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientPlugin } from '../src/client.js'
import reference from '../src/cli-reference.json' with { type: 'json' }
import catalog from '../src/catalog.json' with { type: 'json' }
import { buildModels } from '../src/provider.js'
const id = 'gpt-6-astra'
const helpers = createClientPlugin({}, catalog.data, reference).helpers
const fresh = () => helpers.modelDraft({}, id)

test('CLI references are enabled by default for exact catalogue ids', () => {
  assert.deepEqual(fresh().reasoningEfforts, reference.models[id].reasoningEfforts)
  const draft = helpers.referenceDraft(id, fresh())
  assert.equal(draft.contextWindow, '1050000')
  assert.deepEqual(draft.input, ['text', 'image'])
  assert.deepEqual(Object.keys(draft.reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(draft.maxTokens, '', 'unknown output limit is not invented')
  const ids = new Set(catalog.data.map(row => row.id))
  for (const [id, value] of Object.entries(reference.models)) {
    assert(ids.has(id))
    for (const field of ['contextWindow', 'maxTokens']) if (value[field] !== undefined) assert(Number.isSafeInteger(value[field]) && value[field] > 0)
  }
  assert.deepEqual(reference.models['deepseek/deepseek-v4-pro'].input, ['text'])
  assert.deepEqual(Object.keys(reference.models['deepseek/deepseek-v4-pro'].reasoningEfforts), ['high', 'max'])
})

test('K/M token inputs are strict, positive safe integers', () => {
  for (const [text, number] of [['1M', 1000000], ['256K', 256000], ['1.05m', 1050000], ['4096', 4096], ['', undefined]]) assert.equal(helpers.tokenCount(text), number)
  for (const text of ['-1', '0', '1.2', 'Infinity', '1e6', '3KK', '9007199254740992']) assert.throws(() => helpers.tokenCount(text))
})

test('capability save overrides selected-model metadata without mutating originals', () => {
  const config = { models: [{ id, name: 'custom', api: 'auto', contextWindow: 2000, input: ['text'], reasoningEfforts: { low: 'low' } }], modelOverrides: { [id]: { maxTokens: 99 } } }
  const original = structuredClone(config)
  const draft = { ...fresh(), contextWindow: '1M', maxTokens: '64K', input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }
  const next = helpers.applyModelEdits(config, { [id]: draft })
  assert.deepEqual(config, original)
  assert.deepEqual(next.models, [{ id, name: 'custom', api: 'auto' }])
  const model = buildModels(catalog, next)[0]
  assert.equal(model.contextWindow, 1000000)
  assert.equal(model.maxTokens, 64000)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.thinkingLevelMap.high, 'high')
  assert.equal(model.thinkingLevelMap.low, null)
})

test('clearing levels really removes reasoning controls and blank limits inherit', () => {
  const config = { models: [{ id, contextWindow: 2000, reasoningEfforts: { high: 'high' } }], modelOverrides: { [id]: { input: ['text', 'image'], maxTokens: 999 } } }
  const next = helpers.applyModelEdits(config, { [id]: { contextWindow: '', maxTokens: '', input: ['text'], reasoningEfforts: {} } })
  const model = buildModels(catalog, next)[0]
  assert.equal(model.reasoning, false)
  assert.equal(model.thinkingLevelMap, undefined)
  assert.deepEqual(model.input, ['text'])
  assert.equal(model.maxTokens, 8192)
  assert.equal(model.contextWindow, catalog.data.find(row => row.id === id).context_length)
})

test('explicit empty reasoning maps win over defaults and older overrides', () => {
  const config = { models: [{ id, input: [], reasoningEfforts: {} }], modelOverrides: { [id]: { input: ['text', 'image'], reasoningEfforts: { high: 'high' } } } }
  const draft = helpers.modelDraft(config, id)
  assert.deepEqual(draft.input, ['text', 'image'])
  assert.deepEqual(draft.reasoningEfforts, {})
  assert.equal(buildModels(catalog, config)[0].reasoning, false)
})

test('resetting overrides restores CLI defaults without leaving explicit empty maps', () => {
  const config = { models: [{ id, input: ['text'], reasoningEfforts: {} }], modelOverrides: { [id]: { contextWindow: 999 } } }
  const reset = helpers.applyModelEdits(config, { [id]: null })
  const model = buildModels(catalog, reset)[0]
  assert.equal(model.contextWindow, 1050000)
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(helpers.modelDraft(reset, id), fresh())
})

test('editing other settings never discards model overrides', () => {
  const config = { modelOverrides: { [id]: { maxTokens: 99, api: 'openai-responses' } } }
  assert.deepEqual(helpers.applyModelEdits(config).modelOverrides, config.modelOverrides)
  assert.equal(helpers.referenceDraft(id, { ...fresh(), maxTokens: '999' }).maxTokens, '999')
})

test('switching to all models preserves older selected-model capabilities in overrides', async () => {
  const config = { models: [{ id, contextWindow: 500000, input: ['text', 'image'], reasoningEfforts: { high: 'high' } }] }
  let saved
  const state = { writable: true, view: { revision: 1 }, config }
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'llm-commandcode', revision: 1, value: { providers: { commandcode: config } } }] } }),
      mutate: async (_ns, ops) => { saved = ops[0].value; return { ok: true } },
    },
    credentials: { describe: async () => ({ ok: true, value: { CMD_API_KEY: { writable: true, configured: true } } }) },
  }
  const result = await helpers.save(remote, 'llm-commandcode', state, { ...helpers.draftOf(config), allModels: true }, '')
  assert.equal(result.ok, true)
  assert.deepEqual(saved.models, [])
  assert.equal(saved.modelOverrides[id].contextWindow, 500000)
  assert.deepEqual(saved.modelOverrides[id].reasoningEfforts, { high: 'high' })
})

test('invalid capability draft fails before credential or settings writes', async () => {
  const state = { writable: true, view: { revision: 1 }, config: {} }
  const remote = {
    settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'llm-commandcode', revision: 1, value: {} }] } }), mutate: () => assert.fail('must not write settings') },
    credentials: { describe: async () => ({ ok: true, value: { CMD_API_KEY: { writable: true, configured: false } } }), set: () => assert.fail('must not store credential') },
  }
  for (const invalid of [{ contextWindow: '0' }, { input: [] }, { reasoningEfforts: { high: '' } }, { reasoningEfforts: { unknown: 'high' } }]) {
    const draft = { ...helpers.draftOf({}), modelEdits: { [id]: { ...fresh(), ...invalid } } }
    const result = await helpers.save(remote, 'llm-commandcode', state, draft, 'fake-key')
    assert.equal(result.code, 'invalidCapabilities')
    assert.equal(result.keyStored, false)
  }
})
