import z from '@deepseek-ai/schemastery'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import catalog from './catalog.json' with { type: 'json' }
import { BASE_URL, PROVIDER, buildModels, createProvider } from './provider.js'
import { discoverModels } from './discovery.js'

export const name = 'llm-commandcode'
export const inject = ['llm', 'credentials']
const modelFields = {
  name: z.string(),
  api: z.union(['auto', 'openai-completions', 'openai-responses', 'anthropic-messages']),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.dict(z.string(), z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).default(undefined),
}
const profileFields = {
  displayName: z.string().default('CommandCode'),
  apiKeyEnv: z.string().role('credential-ref').default('CMD_API_KEY'),
  baseURL: z.string().default(BASE_URL),
  preferResponses: z.boolean().default(false),
  omitReasoningSummary: z.boolean().default(true),
  zeroDataRetention: z.boolean().default(false),
  defaultMaxTokens: z.number().step(1).min(1).default(8192),
  timeoutMs: z.number().step(1).min(1).max(2147483647).default(120000),
  streamIdleTimeoutMs: z.number().step(1).min(1).max(2147483647).default(300000),
  models: z.array(z.object({ id: z.string().required(), ...modelFields })).default([]),
  modelOverrides: z.dict(z.object(modelFields)).default({}),
  customModels: z.array(z.object({
    ...modelFields,
    id: z.string().required(),
    api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages']).required(),
    contextWindow: z.number().step(1).min(1).required(),
  })).default([]),
}
const ProfileConfig = z.object(profileFields)
export const Config = z.object({
  ...profileFields, // Retain the old profile shape for migration and standalone adapter callers.
  // An absent dict member is dormant in the Models page, so CommandCode appears
  // in its Add provider selector. Saving the card materializes this one member.
  providers: z.dict(ProfileConfig, z.union([PROVIDER])).default({}).volatile(),
})

// This provider only authenticates with the explicitly named DSH credential.
// No OAuth, ambient OpenAI key, subprocess, or external credential files.
const auth = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => { throw new Error('CommandCode: use the DSH credential settings') },
    delete: async () => { throw new Error('CommandCode: use the DSH credential settings') },
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

function buildProfiles(config) {
  const models = buildModels(catalog, config)
  if (!models.length) throw new Error('CommandCode: no conversational models selected')
  const ref = credentialRef(config.apiKeyEnv)
  const profile = {
    provider: PROVIDER,
    displayName: config.displayName,
    apiKeyEnv: ref,
    timeoutMs: config.timeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    transport: 'sse',
    cacheRetention: 'none',
    headers: config.zeroDataRetention ? { 'x-cmd-zdr': '1' } : {},
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'CommandCode'),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(models.filter(model =>
      (config.models ?? []).some(entry => entry.id === model.id && entry.maxTokens != null)
      || config.modelOverrides?.[model.id]?.maxTokens != null
      || (config.customModels ?? []).some(entry => entry.id === model.id && entry.maxTokens != null),
    ).map(model => [model.id, model.maxTokens])),
    piProvider: createProvider(models, {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
      'anthropic-messages': anthropicMessagesApi(),
    }, config),
  }
  return new Map([[PROVIDER, profile]])
}

export function createAdapter(ctx, config) {
  let fingerprint
  let snapshot
  const profiles = () => {
    const configured = config.providers?.get() ?? {}
    const effective = configured[PROVIDER] ?? config
    const next = JSON.stringify(effective)
    if (next !== fingerprint) {
      const candidate = buildProfiles(effective)
      snapshot = candidate
      fingerprint = next
    }
    return snapshot
  }
  profiles() // Validate immediately; subsequent settings edits create new immutable snapshots.
  return new PiAiAdapter({
    profiles,
    auth,
    resolveApiKey: async (_provider, profile) => {
      // Prepared calls use their captured profile, even across a live UI edit.
      const ref = profile.apiKeyEnv
      const hit = await ctx.credentials.resolve(ref)
      if (!hit?.value) throw new LlmError(`CommandCode: configure credential ${ref} in Settings > Models`, 'MISSING_CREDENTIAL')
      return assertUsableApiKey(hit.value, 'CommandCode', ref)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, image) => resolveImageAttachmentAccess(
      attachments, path => ctx.get('fs')?.processPathFromHostPath(path), image,
    ),
    onReplayDegrade: ({ model, reason }) => ctx.logger.warn(`CommandCode ${model}: replay degraded (${reason})`),
  })
}

export function apply(ctx, config) {
  const adapter = createAdapter(ctx, config)
  // Public LLM registrations are already bound to this Cordis fiber.
  let registration
  let lastProviders
  const refresh = () => {
    const next = config.providers.get()
    if (next === lastProviders) return
    const routes = next[PROVIDER] ? [PROVIDER] : []
    if (registration) registration.replace(routes)
    else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter)
    lastProviders = next
  }
  refresh()
  // Native Loader lifecycle event (also used by the built-in PiAi adapter).
  // Replace atomically to refresh model selectors after a live settings edit;
  // removing the UI profile withdraws the route rather than reviving defaults.
  ctx.on('loader/volatile-update', refresh)
  ctx.llm.registerModelDiscovery(ctx.fiber.entry?.options.id ?? name, (request, signal) => {
    const stored = config.providers.get()[PROVIDER]
    return discoverModels(request, stored, async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value, signal)
  })
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: config.displayName,
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: ['providers', PROVIDER],
  }])
}
