import { BASE_URL, normalizeBaseURL, validModelId } from './provider.js'

const LIMIT = 3 * 1024 * 1024
const positive = value => Number.isSafeInteger(value) && value > 0

// Only documented metadata crosses the discovery seam. No executable content,
// endpoint-provided URLs, prompts, headers or credentials are returned.
export function parseDiscoveredModels(payload) {
  if (!Array.isArray(payload?.data) || payload.data.length > 5000) throw new Error('CommandCode: invalid model directory')
  const result = new Map()
  for (const row of payload.data) {
    if (!row || !validModelId(row.id) || result.has(row.id)) continue
    if (Array.isArray(row.supported_endpoints) && !row.supported_endpoints.some(path => ['/chat/completions', '/responses', '/messages'].includes(path))) continue
    const context = row.context_length ?? row.context_window
    const output = row.max_output_tokens
    const modalities = row.input_modalities
    result.set(row.id, {
      id: row.id,
      ...(typeof row.name === 'string' && row.name.length <= 512 ? { name: row.name } : {}),
      ...(positive(context) ? { contextWindow: context } : {}),
      ...(positive(output) ? { maxTokens: output } : {}),
      ...(Array.isArray(modalities) && modalities.length && modalities.every(value => ['text', 'image'].includes(value)) ? { inputModalities: [...new Set(modalities)] } : {}),
    })
  }
  return [...result.values()]
}

export async function discoverModels(request, stored, resolveKey, signal, fetcher = fetch) {
  if (request.provider && request.provider !== 'commandcode') throw new Error('CommandCode: invalid discovery provider')
  const baseURL = normalizeBaseURL(request.baseURL ?? stored?.baseURL ?? BASE_URL)
  // A stored credential is bound to its saved endpoint. An unsaved endpoint
  // change must never send the existing key to a different destination.
  let apiKey = request.apiKey?.trim()
  if (!apiKey && stored && baseURL === normalizeBaseURL(stored.baseURL ?? BASE_URL)) {
    try { apiKey = await resolveKey(stored.apiKeyEnv ?? 'CMD_API_KEY') }
    catch { throw new Error('CommandCode: cannot resolve discovery credential') }
  }
  if (apiKey && /[\r\n]/.test(apiKey)) throw new Error('CommandCode: invalid credential')
  const timeout = AbortSignal.timeout(15000)
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetcher(`${baseURL}/models`, {
      method: 'GET', redirect: 'error', signal: lifetime,
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    })
    if (!response.ok) throw new Error('failed')
    if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('too-large')
    const chunks = []
    let bytes = 0
    if (!response.body) throw new Error('empty')
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > LIMIT) throw new Error('too-large')
      chunks.push(chunk)
    }
    return parseDiscoveredModels(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    // Never echo response bodies, fetch errors or URL/credential contents.
    throw new Error(lifetime.aborted ? 'CommandCode: model discovery cancelled or timed out' : 'CommandCode: model discovery failed; check the endpoint and credential')
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {})
  }
}
