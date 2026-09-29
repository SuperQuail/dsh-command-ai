// Pure provider policy. No global fetch patches and no changes to other routes.
import cliReference from './cli-reference.json' with { type: 'json' }
export const PROVIDER = 'commandcode'
export const BASE_URL = 'https://api.commandcode.ai/provider/v1'
export const ENDPOINTS = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
}
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function validModelId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id)
}

export function combinedCatalog(catalog, customModels = []) {
  const ids = new Set(catalog.data.map(row => row.id))
  const additions = []
  for (const model of customModels) {
    if (!validModelId(model.id) || ids.has(model.id)) throw new Error('CommandCode: invalid or duplicate custom model ID')
    if (!Object.hasOwn(ENDPOINTS, model.api)) throw new Error('CommandCode: choose a protocol for the custom model')
    positiveInteger(model.contextWindow, `${model.id} contextWindow`)
    if (model.maxTokens != null) positiveInteger(model.maxTokens, `${model.id} maxTokens`)
    ids.add(model.id)
    additions.push({ id: model.id, name: model.name || model.id, context_length: model.contextWindow, supported_endpoints: [ENDPOINTS[model.api]] })
  }
  return [...catalog.data, ...additions]
}

export function normalizeBaseURL(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('CommandCode: baseURL must use HTTPS (HTTP is allowed only for loopback tests)')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('CommandCode: baseURL cannot contain credentials, a query, or a fragment')
  return url.href.replace(/\/+$/, '')
}

export function selectApi(endpoints, preferred, preferResponses = false) {
  if (!Array.isArray(endpoints)) throw new Error('CommandCode: supported_endpoints is missing')
  if (preferred && preferred !== 'auto') {
    if (!ENDPOINTS[preferred] || !endpoints.includes(ENDPOINTS[preferred])) {
      throw new Error(`CommandCode: model does not support ${preferred}`)
    }
    return preferred
  }
  if (endpoints.includes('/messages')) return 'anthropic-messages'
  if (preferResponses && endpoints.includes('/responses')) return 'openai-responses'
  if (endpoints.includes('/chat/completions')) return 'openai-completions'
  if (endpoints.includes('/responses')) return 'openai-responses'
  return undefined // e.g. /systemone is not a conversational model.
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`CommandCode: invalid ${label}`)
  return value
}

/** Exact-ID CLI declarations supply defaults; explicit user fields always win. */
export function buildModels(catalog, config) {
  if (!Array.isArray(catalog?.data)) throw new Error('CommandCode: malformed model catalog')
  const baseURL = normalizeBaseURL(config.baseURL ?? BASE_URL)
  const overrides = config.modelOverrides ?? {}
  const selected = config.models?.length ? new Set(config.models.map(item => item.id)) : undefined
  const listed = new Map((config.models ?? []).map(item => [item.id, item]))
  const custom = new Map((config.customModels ?? []).map(model => [model.id, model]))
  const rows = combinedCatalog(catalog, config.customModels)
  const ids = new Set(rows.map(row => row.id))
  for (const id of [...Object.keys(overrides), ...listed.keys()]) {
    if (!ids.has(id)) throw new Error(`CommandCode: unknown catalog model ${id}; refresh the catalog first`)
  }
  const seen = new Set()
  return rows.flatMap(row => {
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw new Error('CommandCode: invalid or duplicate model id')
    seen.add(row.id)
    if (selected && !selected.has(row.id)) return []
    // Missing reasoning maps inherit; an explicitly empty map disables advertised
    // levels. Config must not materialize an omitted reasoning map into {}.
    const defined = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key, value]) =>
      value != null && !(key === 'input' && Array.isArray(value) && value.length === 0)))
    const override = { ...cliReference.models[row.id], ...defined(custom.get(row.id)), ...defined(overrides[row.id]), ...defined(listed.get(row.id)) }
    const api = selectApi(row.supported_endpoints, override.api, config.preferResponses)
    if (!api) {
      if (selected?.has(row.id) || overrides[row.id]) throw new Error(`CommandCode: ${row.id} has no supported chat endpoint`)
      return []
    }
    const input = override.input?.length ? override.input : ['text']
    if (input.some(value => !['text', 'image'].includes(value))) throw new Error(`CommandCode: unsupported modality for ${row.id}`)
    const efforts = override.reasoningEfforts
    const reasoning = efforts && efforts !== false && Object.keys(efforts).length > 0
    const thinkingLevelMap = reasoning ? Object.fromEntries(LEVELS.map(level => [level, null])) : undefined
    if (reasoning) {
      for (const [level, wire] of Object.entries(efforts)) {
        if (!LEVELS.includes(level) || typeof wire !== 'string' || !wire) throw new Error(`CommandCode: invalid reasoning mapping for ${row.id}`)
        thinkingLevelMap[level] = wire
      }
    }
    return [{
      id: row.id,
      name: override.name || row.name || row.id,
      provider: PROVIDER,
      api,
      // Anthropic's SDK appends /v1/messages itself, unlike the OpenAI endpoints.
      baseUrl: api === 'anthropic-messages' ? baseURL.replace(/\/v1$/, '') : baseURL,
      input: [...input],
      reasoning: Boolean(reasoning),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      contextWindow: positiveInteger(override.contextWindow ?? row.context_length, `${row.id} contextWindow`),
      maxTokens: positiveInteger(override.maxTokens ?? config.defaultMaxTokens ?? 8192, `${row.id} maxTokens`),
      // Not price claims: PiAiAdapter exposes usage counts, not monetary cost.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(api === 'openai-completions' ? { compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        supportsReasoningEffort: Boolean(reasoning),
        maxTokensField: 'max_tokens',
        supportsStrictMode: false,
      } } : {}),
    }]
  })
}

/**
 * Accept either prompt-context shape and hand the APIs a transcript.
 *
 * pi-ai 0.87 replaced the flat context (`systemPrompt` and `tools` beside
 * `messages`) with a transcript whose leading system message carries both, so
 * its collection folds a flat context before dispatching. This provider calls
 * the APIs directly, and a host on the older adapter lineage still hands a flat
 * context over: fold it exactly as the collection does. An already-folded
 * transcript passes through untouched, which keeps the current host on its own
 * normalization path.
 * @param context - the prompt context a host handed to a provider stream.
 * @returns the transcript this build's APIs expect.
 */
export function toTranscript(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return context
  const systemPrompt = typeof context.systemPrompt === 'string' ? context.systemPrompt : ''
  const tools = Array.isArray(context.tools) ? context.tools : []
  if (systemPrompt.length === 0 && tools.length === 0) return context
  return {
    messages: [
      // An omitted `toolsAdded` is what the collection's own fold produces for
      // an empty tool list; a present-but-empty one would redeclare nothing.
      { role: 'system', content: systemPrompt, ...(tools.length > 0 ? { toolsAdded: tools } : {}), timestamp: 0 },
      ...(Array.isArray(context.messages) ? context.messages : []),
    ],
  }
}

/** Remove only the request-control field, never input[].summary or a tool's summary property. */
export function sanitizePayload(payload, model, omitSummary = true) {
  if (!omitSummary || model.api !== 'openai-responses' || !payload || typeof payload !== 'object') return payload
  if (!payload.reasoning || typeof payload.reasoning !== 'object' || !Object.hasOwn(payload.reasoning, 'summary')) return payload
  const { summary: _summary, ...reasoning } = payload.reasoning
  return { ...payload, reasoning }
}

export function createProvider(models, apis, config) {
  const dispatch = (method, model, context, options = {}) => {
    const originalHook = options.onPayload
    return apis[model.api][method](model, toTranscript(context), {
      ...options,
      onPayload: async (payload, resolvedModel) => {
        const previous = await originalHook?.(payload, resolvedModel)
        return sanitizePayload(previous ?? payload, model, config.omitReasoningSummary !== false)
      },
    })
  }
  return {
    id: PROVIDER,
    name: config.displayName || 'CommandCode',
    baseUrl: normalizeBaseURL(config.baseURL ?? BASE_URL),
    auth: { apiKey: {
      name: 'CommandCode API key',
      resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'DSH credentials' }),
    } },
    getModels: () => models,
    stream: (model, context, options) => dispatch('stream', model, context, options),
    streamSimple: (model, context, options) => dispatch('streamSimple', model, context, options),
  }
}
