import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BASE_URL, buildModels, createProvider, normalizeBaseURL, sanitizePayload, selectApi } from '../src/provider.js'

const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'))
const reference = JSON.parse(await readFile(new URL('../src/cli-reference.json', import.meta.url), 'utf8'))
const minimal = { data: [{ id: 'test', context_length: 32000, supported_endpoints: ['/responses', '/chat/completions'] }] }

test('official catalog defaults: Claude messages; all other models use supported chat routes', () => {
  const models = buildModels(catalog, {})
  assert.equal(models.length, catalog.data.length)
  for (const model of models) {
    const source = catalog.data.find(row => row.id === model.id)
    const defaults = reference.models[model.id] ?? {}
    assert.equal(model.contextWindow, defaults.contextWindow ?? source.context_length)
    assert.equal(model.reasoning, Object.keys(defaults.reasoningEfforts ?? {}).length > 0)
    assert.deepEqual(model.input, defaults.input ?? ['text'])
    if (source.supported_endpoints.includes('/messages')) {
      assert.equal(model.api, 'anthropic-messages')
      assert.equal(model.baseUrl, 'https://api.commandcode.ai/provider')
    } else {
      assert.equal(model.api, 'openai-completions')
      assert.equal(model.baseUrl, BASE_URL)
    }
  }
})

test('Responses is opt-in and never routes Claude or chat-only models there', () => {
  const models = buildModels(catalog, { preferResponses: true })
  assert(models.some(model => model.api === 'openai-responses'))
  assert.equal(selectApi(['/messages'], 'auto', true), 'anthropic-messages')
  assert.equal(selectApi(['/chat/completions'], 'auto', true), 'openai-completions')
  assert.throws(() => selectApi(['/messages'], 'openai-responses'), /does not support/)
  assert.equal(selectApi(['/systemone']), undefined)
})

test('only reasoning.summary is stripped; effort, replay and tool schemas remain intact', () => {
  const payload = {
    reasoning: { effort: 'high', summary: 'auto' },
    input: [{ type: 'reasoning', summary: [{ text: 'keep me' }] }],
    tools: [{ parameters: { properties: { summary: { type: 'string' } } } }],
    summary: 'keep top-level unknown data',
  }
  const clean = sanitizePayload(payload, { api: 'openai-responses' })
  assert.deepEqual(clean.reasoning, { effort: 'high' })
  assert.equal(clean.input, payload.input)
  assert.equal(clean.tools, payload.tools)
  assert.equal(clean.summary, payload.summary)
  assert.equal(payload.reasoning.summary, 'auto')
  assert.equal(sanitizePayload(payload, { api: 'openai-completions' }), payload)
  assert.equal(sanitizePayload(payload, { api: 'openai-responses' }, false), payload)
})

test('SDK hook composition preserves previous payload transforms and options', async () => {
  let observed
  const api = { streamSimple: (_model, _context, options) => { observed = options; return 'stream' } }
  const provider = createProvider([], { 'openai-responses': api }, {})
  const model = { api: 'openai-responses' }
  assert.equal(provider.streamSimple(model, {}, {
    apiKey: 'test-only', maxRetries: 0,
    onPayload: payload => ({ ...payload, extra: 42 }),
  }), 'stream')
  assert.equal(observed.apiKey, 'test-only')
  assert.equal(observed.maxRetries, 0)
  assert.deepEqual(await observed.onPayload({ reasoning: { effort: 'high', summary: 'auto' } }, model), {
    reasoning: { effort: 'high' }, extra: 42,
  })
})

test('explicit model metadata and complete reasoning capability maps', () => {
  const models = buildModels(minimal, {
    models: [{ id: 'test', input: ['text', 'image'], maxTokens: 2048 }],
    modelOverrides: { test: { reasoningEfforts: { low: 'low', high: 'high' } } },
  })
  assert.equal(models[0].maxTokens, 2048)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].thinkingLevelMap.high, 'high')
  assert.equal(models[0].thinkingLevelMap.medium, null)
  assert.equal(models[0].thinkingLevelMap.off, null)
  assert.throws(() => buildModels(minimal, { models: [{ id: 'missing' }] }), /unknown catalog/)
  assert.throws(() => buildModels(minimal, { modelOverrides: { test: { contextWindow: -1 } } }), /contextWindow/)
  assert.throws(() => buildModels(minimal, { modelOverrides: { test: { reasoningEfforts: { bogus: 'yes' } } } }), /reasoning mapping/)
})

test('endpoint validation allows HTTPS or local mock only', () => {
  assert.equal(normalizeBaseURL(`${BASE_URL}/`), BASE_URL)
  assert.equal(normalizeBaseURL('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
  for (const url of ['http://example.com/v1', 'https://key@example.com/v1', 'https://example.com/v1?key=secret']) {
    assert.throws(() => normalizeBaseURL(url))
  }
})

test('manifest and patch declare only an additive provider', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.scripts.postinstall, undefined)
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^- insert:/)
  assert.match(patch, /id: llm-commandcode/)
  assert.doesNotMatch(patch, /id: llm-pi-ai|disabled:|defaultModel/)
})
