import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Config, apply, createAdapter } from '../src/index.js'
import { createClientPlugin } from '../src/client.js'
import reference from '../src/cli-reference.json' with { type: 'json' }
import catalog from '../src/catalog.json' with { type: 'json' }

const user = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
const gpt = 'gpt-6-astra'
const claude = 'claude-sonnet-4-6'
const textEvents = [
  { choices: [{ delta: { content: 'hello' }, index: 0, finish_reason: null }] },
  { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  '[DONE]',
]
const toolEvents = [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  '[DONE]',
]
function ctxWithKey() {
  return { credentials: { resolve: async () => ({ value: 'fake-test-key' }) }, on() {}, get: () => undefined, logger: { warn() {} } }
}
async function mock(t, handler) {
  const requests = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ path: req.url, method: req.method, body, headers: req.headers })
      handler(req, res, body, requests.length)
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { url: `http://127.0.0.1:${server.address().port}/provider/v1`, requests }
}
function send(res, events, named = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`${named ? `event: ${event.type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
  res.end()
}
async function collect(adapter, model = gpt, extra = {}) {
  return Array.fromAsync(adapter.stream({ provider: 'commandcode', model, messages: user, ...extra }))
}
function assertText(chunks) {
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'hello')
  assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1)))
  assert(chunks.some(c => c.type === 'usage' && c.usage.inputTokens === 3))
}

test('schema and editor share default image/thinking support while explicit opt-outs survive', async () => {
  const helpers = createClientPlugin({}, catalog.data, reference).helpers
  for (const entry of [{ id: gpt }, { id: gpt, contextWindow: 64000 }]) {
    const profile = Config({ providers: { commandcode: { models: [entry] } } })
    const raw = profile.providers.get().commandcode
    assert.equal(raw.models[0].reasoningEfforts, undefined)
    const info = await createAdapter(ctxWithKey(), profile).resolveModel('commandcode', gpt)
    assert.deepEqual(info.inputModalities, ['text', 'image'])
    assert.deepEqual(helpers.modelDraft(raw, gpt).input, info.inputModalities)
    assert.deepEqual(info.reasoning.efforts.map(item => item.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  }
  const custom = Config({ providers: { commandcode: { modelOverrides: { [gpt]: { input: ['text'], reasoningEfforts: {} } } } } })
  const info = await createAdapter(ctxWithKey(), custom).resolveModel('commandcode', gpt)
  assert.deepEqual(info.inputModalities, ['text'])
  assert.deepEqual(helpers.modelDraft(custom.providers.get().commandcode, gpt).reasoningEfforts, {})
  const plain = 'deepseek/deepseek-v4-pro'
  assert.deepEqual(helpers.modelDraft({}, plain).input, ['text'])
})

test('registers one independent adapter and configuration entry', async () => {
  const ctx = ctxWithKey()
  const registrations = []
  ctx.fiber = { entry: { options: { id: 'llm-commandcode' } } }
  ctx.llm = {
    registerModelDiscovery: () => {},
    registerAdapter: (...args) => registrations.push(args),
    registerConfigurableProviders: entries => registrations.push(entries),
  }
  apply(ctx, Config({ providers: { commandcode: {} } }))
  assert.deepEqual(registrations[0][0], ['commandcode'])
  assert.equal((await registrations[0][1].listModels('commandcode')).length, 82)
  assert.equal(registrations[1][0].settingsNs, 'llm-commandcode')
  assert.deepEqual(registrations[1][0].settingsPath, ['providers', 'commandcode'])
})

test('UI capability edits reach model metadata and actual reasoning request payload', async t => {
  const server = await mock(t, (_req, res) => send(res, textEvents))
  const helpers = createClientPlugin({}, catalog.data, reference).helpers
  const draft = helpers.referenceDraft(gpt, helpers.modelDraft({}, gpt))
  draft.maxTokens = '16K'
  const saved = helpers.applyModelEdits({ baseURL: server.url, models: [{ id: gpt }] }, { [gpt]: draft })
  const adapter = createAdapter(ctxWithKey(), Config({ providers: { commandcode: saved } }))
  const info = await adapter.resolveModel('commandcode', gpt)
  assert.equal(info.context.contextWindow, 1050000)
  assert.equal(info.defaultMaxTokens, 16000)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assertText(await collect(adapter, gpt, { reasoningEffort: 'max', maxTokens: info.defaultMaxTokens }))
  assert.equal(server.requests[0].body.reasoning_effort, 'max')
  assert.equal(server.requests[0].body.max_tokens, 16000)
})

test('discovered unbundled model persists as custom metadata and reaches the actual request', async t => {
  const future = 'new/model-ahead-of-plugin'
  const server = await mock(t, (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: future, context_length: 256000, max_output_tokens: 4096, input_modalities: ['text', 'image'] }] }))
    } else send(res, textEvents)
  })
  const ctx = ctxWithKey()
  ctx.fiber = { entry: { options: { id: 'llm-commandcode' } } }
  let discover
  ctx.llm = { registerAdapter: () => {}, registerConfigurableProviders: () => {}, registerModelDiscovery: (ns, callback) => { assert.equal(ns, 'llm-commandcode'); discover = callback } }
  const config = Config({ providers: { commandcode: { baseURL: server.url } } })
  apply(ctx, config)
  const rows = await discover({ provider: 'commandcode', baseURL: server.url })
  assert.equal(rows[0].id, future)
  assert.equal(server.requests[0].method, 'GET')
  assert.equal(server.requests[0].path, '/provider/v1/models')
  assert.equal(server.requests[0].headers.authorization, 'Bearer fake-test-key')
  const helpers = createClientPlugin({}, catalog.data, reference).helpers
  const draft = helpers.addCustom(helpers.draftOf({}), { ...rows[0], api: 'openai-completions', input: rows[0].inputModalities })
  const saved = helpers.applyModelEdits({ baseURL: server.url, customModels: draft.customModels, models: [{ id: future }] }, { [future]: { ...helpers.modelDraft(draft, future), reasoningEfforts: { high: 'high' } } })
  const adapter = createAdapter(ctxWithKey(), Config({ providers: { commandcode: saved } }))
  const info = await adapter.resolveModel('commandcode', future)
  assert.equal(info.context.contextWindow, 256000)
  assert.equal(info.defaultMaxTokens, 4096)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assertText(await collect(adapter, future, { reasoningEffort: 'high', maxTokens: 4096 }))
  assert.equal(server.requests[1].body.model, future)
  assert.equal(server.requests[1].body.reasoning_effort, 'high')
})

test('Chat Completions request path, authentication, text and usage', async t => {
  const server = await mock(t, (_req, res) => send(res, textEvents))
  const adapter = createAdapter(ctxWithKey(), Config({ baseURL: server.url, zeroDataRetention: true }))
  assertText(await collect(adapter))
  assert.equal(server.requests[0].path, '/provider/v1/chat/completions')
  assert.equal(server.requests[0].headers.authorization, 'Bearer fake-test-key')
  assert.equal(server.requests[0].headers['x-cmd-zdr'], '1')
  assert.equal(server.requests[0].body.reasoning, undefined)
  assert.equal(server.requests[0].body.store, undefined)
})

test('streamed tool arguments and tool-result history survive the round trip', async t => {
  const server = await mock(t, (_req, res, _body, n) => send(res, n === 1 ? toolEvents : textEvents))
  const adapter = createAdapter(ctxWithKey(), Config({ baseURL: server.url }))
  const tools = [{ name: 'lookup', description: 'Look up a word', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
  const chunks = await collect(adapter, gpt, { tools })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  assert.equal(block.name, 'lookup')
  assert.deepEqual(JSON.parse(block.arguments), { q: 'hi' })
  const messages = [...user,
    { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: gpt, replayState: chunks.at(-1).replayState }, content: [block] },
    { id: 'tool-1', role: 'tool', toolCallId: block.id, source: { kind: 'tool', callId: block.id }, content: [{ type: 'text', text: 'result' }] },
  ]
  assertText(await collect(adapter, gpt, { tools, messages }))
  assert(server.requests[1].body.messages.some(message => message.role === 'tool'))
})

test('Responses removes SDK summary but preserves reasoning effort on the wire', async t => {
  const server = await mock(t, (_req, res, body) => {
    if (body.reasoning?.summary !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'json: unknown field "summary"', type: 'invalid_request_error' } }))
      return
    }
    const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
    send(res, [
      { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', model: gpt, output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', model: gpt, output: [message], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ])
  })
  const config = { baseURL: server.url, preferResponses: true, modelOverrides: { [gpt]: { reasoningEfforts: { high: 'high' } } } }
  const adapter = createAdapter(ctxWithKey(), Config(config))
  assertText(await collect(adapter, gpt, { reasoningEffort: 'high' }))
  assert.equal(server.requests[0].path, '/provider/v1/responses')
  assert.deepEqual(server.requests[0].body.reasoning, { effort: 'high' })
  const original = createAdapter(ctxWithKey(), Config({ ...config, omitReasoningSummary: false }))
  const failure = await collect(original, gpt, { reasoningEffort: 'high' })
  assert.equal(failure.at(-1).reason.kind, 'error')
  assert.match(failure.at(-1).reason.failure.message, /unknown field/)
  assert.equal(server.requests[1].body.reasoning.summary, 'auto')
  assert.equal(server.requests.length, 2, 'no invisible 400 retries')
})

test('Anthropic has exactly one /v1 and uses API key authentication', async t => {
  const server = await mock(t, (_req, res) => send(res, [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: claude, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ], true))
  const adapter = createAdapter(ctxWithKey(), Config({ baseURL: server.url }))
  assertText(await collect(adapter, claude))
  assert.equal(server.requests[0].path.split('?')[0], '/provider/v1/messages')
  assert.equal(server.requests[0].headers['x-api-key'], 'fake-test-key')
})

test('model selection retains per-model capability overrides after schema defaults', async () => {
  const adapter = createAdapter(ctxWithKey(), Config({
    models: [{ id: gpt }],
    modelOverrides: { [gpt]: { input: ['text', 'image'], reasoningEfforts: { high: 'high' } } },
  }))
  const info = await adapter.resolveModel('commandcode', gpt)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.deepEqual(info.reasoning.efforts.map(item => item.id), ['high'])
})

test('missing credential fails before network and cannot fall back to another key', async () => {
  const ctx = ctxWithKey()
  ctx.credentials.resolve = async () => undefined
  const adapter = createAdapter(ctx, Config({}))
  await assert.rejects(() => collect(adapter), error => error.code === 'MISSING_CREDENTIAL')
})

test('credentials are read per request; caller abort prevents submission', async t => {
  const server = await mock(t, (_req, res) => send(res, textEvents))
  const ctx = ctxWithKey()
  let key = 'first-fake-key'
  ctx.credentials.resolve = async () => ({ value: key })
  const adapter = createAdapter(ctx, Config({ baseURL: server.url }))
  assertText(await collect(adapter))
  key = 'second-fake-key'
  assertText(await collect(adapter))
  assert.equal(server.requests[0].headers.authorization, 'Bearer first-fake-key')
  assert.equal(server.requests[1].headers.authorization, 'Bearer second-fake-key')
  const controller = new AbortController()
  controller.abort('test')
  try {
    const aborted = await collect(adapter, gpt, { signal: controller.signal })
    assert.equal(aborted.at(-1).reason.kind, 'aborted')
  } catch (error) { assert.equal(error.code, 'ABORTED') }
  assert.equal(server.requests.length, 2)
})

test('live profile edits refresh models while prepared calls retain endpoint and credential reference', async t => {
  const first = await mock(t, (_req, res) => send(res, textEvents))
  const second = await mock(t, (_req, res) => send(res, textEvents))
  const config = Config({ providers: { commandcode: { baseURL: first.url, apiKeyEnv: 'FIRST_CMD_KEY' } } })
  let raw = config.providers.get()
  const mutable = { ...config, providers: { get: () => raw } }
  const ctx = ctxWithKey()
  ctx.credentials.resolve = async ref => ({ value: ref })
  const adapter = createAdapter(ctx, mutable)
  const prepared = await adapter.prepareCall('commandcode', gpt)
  raw = Config({ providers: { commandcode: { baseURL: second.url, apiKeyEnv: 'SECOND_CMD_KEY', models: [{ id: gpt }] } } }).providers.get()
  assert.equal((await adapter.listModels('commandcode')).length, 1)
  assertText(await Array.fromAsync(prepared.stream({ provider: 'commandcode', model: gpt, messages: user })))
  assertText(await collect(adapter))
  assert.equal(first.requests[0].headers.authorization, 'Bearer FIRST_CMD_KEY')
  assert.equal(second.requests[0].headers.authorization, 'Bearer SECOND_CMD_KEY')
})

test('empty profile is addable; saving registers a route and deleting withdraws it', () => {
  const config = Config({})
  let raw = config.providers.get()
  assert.deepEqual(raw, {})
  const events = new Map()
  const registrations = []
  const replacements = []
  const ctx = ctxWithKey()
  ctx.fiber = { entry: { options: { id: 'llm-commandcode' } } }
  ctx.on = (event, handler) => events.set(event, handler)
  ctx.llm = {
    registerModelDiscovery: () => {},
    registerAdapter: routes => { registrations.push(routes); return { replace: routes => replacements.push(routes) } },
    registerConfigurableProviders: entries => assert.deepEqual(entries[0].settingsPath, ['providers', 'commandcode']),
  }
  apply(ctx, { ...config, providers: { get: () => raw } })
  assert.equal(registrations.length, 0)
  raw = Config({ providers: { commandcode: {} } }).providers.get()
  events.get('loader/volatile-update')()
  assert.deepEqual(registrations, [['commandcode']])
  events.get('loader/volatile-update')()
  assert.equal(replacements.length, 0, 'unrelated updates do not republish unchanged profiles')
  raw = {}
  events.get('loader/volatile-update')()
  assert.deepEqual(replacements, [[]])
})
