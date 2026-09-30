// Static metadata extraction only: never import/evaluate the downloaded CLI.
import { readFile, writeFile } from 'node:fs/promises'
const source = await readFile(process.argv[2], 'utf8')
const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'))
const allowed = new Set(catalog.data.map(row => row.id))
const models = {}
for (const match of source.matchAll(/\{id:"([^"]+)",inputModalities:(\[[^\]]*\]),([\s\S]*?)(?=\},)/g)) {
  const [, id, inputs, rest] = match
  if (!allowed.has(id)) continue
  const input = JSON.parse(inputs)
  if (!input.every(item => ['text', 'image'].includes(item))) throw new Error('Invalid modalities')
  const efforts = /reasoningEfforts:(\[[^\]]*\])/.exec(rest)
  const context = /contextWindow:([\d.e+]+)/.exec(rest)
  const output = /maxOutputTokens:([\d.e+]+)/.exec(rest)
  models[id] = { input, ...(context ? { contextWindow: Number(context[1]) } : {}), ...(output ? { maxTokens: Number(output[1]) } : {}), ...(efforts ? { reasoningEfforts: Object.fromEntries(JSON.parse(efforts[1]).map(level => [level, level])) } : {}) }
}
if (models['gpt-6-astra']?.contextWindow !== 1050000 || models['deepseek/deepseek-v4-pro']?.reasoningEfforts?.max !== 'max') throw new Error('Package layout changed')
// The catalogue is fetched independently, so a declaration the CLI stopped
// emitting (moved vendor block, renamed field) must fail loudly, not silently
// drop that model's defaults.
const missing = [...allowed].filter(id => models[id] === undefined)
if (missing.length > 0) throw new Error(`Package layout changed: no declaration for ${missing.join(', ')}`)
await writeFile(new URL('../src/cli-reference.json', import.meta.url), JSON.stringify({ source: 'command-code@1.72.4', url: 'https://registry.npmjs.org/command-code/-/command-code-1.72.4.tgz', integrity: 'sha512-UFW3CmOQxJeaalEgUE81EdsMwgzt1t5GssM+pszm+t59BYXKpKPImhzxvPClp+VxEEHENuBhrXbgZKG8t2+psg==', note: 'CLI declarations, not verified Provider API capabilities. Exact-ID defaults; explicit user overrides take priority.', models }, null, 2) + '\n')
console.log(`Extracted reference metadata for ${Object.keys(models).length} exact matching model IDs.`)
