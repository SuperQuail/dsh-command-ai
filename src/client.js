// Built into client.js. React is supplied by the Harness browser module table.
export function createClientPlugin(React, catalog, reference = { models: {} }) {
  const h = React.createElement
  const NS = 'commandcode.settings'
  const ROUTE = 'commandcode'
  const BASE = 'https://api.commandcode.ai/provider/v1'
  const dictionaries = {
    en: {
      title: 'CommandCode settings', help: 'Configure this provider here, then use Save CommandCode below. The generic editor above only supports built-in adapters.',
      loading: 'Loading configuration…', key: 'API key', stored: 'Stored securely; leave blank to keep it', missing: 'Enter your CommandCode API key',
      locked: 'This credential is supplied by the environment and cannot be changed here.', endpoint: 'API base URL',
      advanced: 'Advanced settings', responses: 'Prefer Responses (otherwise Chat Completions; Claude uses Messages)',
      summary: 'Omit reasoning.summary for gateway compatibility', zdr: 'Require zero data retention (may affect availability and pricing)',
      all: 'Use all bundled models', models: 'Enabled models', choose: 'Select one or more models (Ctrl/Command for multiple)',
      save: 'Save CommandCode', saving: 'Saving…', refresh: 'Reload settings', saved: 'Saved. Select a CommandCode model in the chat model picker.',
      loadFailed: 'Could not load settings. Reload and try again.', saveFailed: 'Save failed. Reload settings and try again.',
      conflict: 'Settings changed in another window. Reload before saving.', required: 'An API key is required.',
      invalidURL: 'Use an HTTPS base URL without credentials, query, or fragment.', invalidModels: 'Select at least one valid model.',
      partial: 'The key was stored, but settings were not saved. Reload and retry; the key does not need to be entered again.',
      readOnly: 'These settings are read-only.', unavailable: 'CommandCode settings are unavailable; restart DSH after upgrading.',
      catalogue: 'Models come from the bundled official catalogue; saving does not call a paid API.',
    },
    zh: {
      title: 'CommandCode 配置', help: '在此填写后点击下方“保存 CommandCode”。上方通用编辑器仅适用于内置适配器。',
      loading: '正在加载配置…', key: 'API 密钥', stored: '已安全保存；留空保留现有密钥', missing: '输入 CommandCode API Key',
      locked: '此密钥由环境变量提供，不能在这里修改。', endpoint: 'API 基地址',
      advanced: '自定义设置', responses: '优先使用 Responses（否则使用 Chat Completions；Claude 始终走 Messages）',
      summary: '省略 reasoning.summary，兼容不支持此字段的中转', zdr: '要求零数据保留（可能影响模型可用性和价格）',
      all: '启用所有内置模型', models: '启用的模型', choose: '选择一个或多个模型（按住 Ctrl/Command 多选）',
      save: '保存 CommandCode', saving: '正在保存…', refresh: '重新加载配置', saved: '已保存。现在可在聊天模型选择器中选择 CommandCode 模型。',
      loadFailed: '读取配置失败，请重新加载后重试。', saveFailed: '保存失败，请重新加载配置后重试。',
      conflict: '配置已在其他窗口修改，请重新加载后再保存。', required: '请填写 API Key。',
      invalidURL: '请使用 HTTPS 基地址，不要包含用户名、密码、查询参数或片段。', invalidModels: '请至少选择一个有效模型。',
      partial: '密钥已保存，但配置未保存。请重新加载后重试，无需再次输入密钥。',
      readOnly: '当前设置为只读。', unavailable: '找不到 CommandCode 配置；升级后请重启 DSH。',
      catalogue: '模型来自内置官方目录；保存配置不会调用收费 API。',
    },
  }
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const capabilityFields = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']
  Object.assign(dictionaries.en, {
    capabilities: 'Model capabilities', context: 'Context window', output: 'Maximum output tokens',
    sizes: 'Blank inherits defaults. Accepts integers, K or M (1K = 1000).', text: 'Text', image: 'Images',
    thinking: 'Supported thinking levels', wire: 'Upstream value',
    capabilityHint: 'Enable only capabilities supported by your upstream. Unchecked levels are unavailable, not “thinking off”. Selecting a level happens in the chat model picker after saving.',
    noThinking: 'No levels advertised; requests use upstream defaults.', invalidCapabilities: 'Check model limits and thinking mappings: use positive integer limits and non-empty upstream values.',
  })
  Object.assign(dictionaries.zh, {
    capabilities: '模型能力配置', context: '上下文窗口', output: '最大输出 token 数',
    sizes: '留空继承默认值；支持整数、K、M（1K = 1000）。', text: '文本', image: '图片',
    thinking: '支持的思考档位', wire: '上游值',
    capabilityHint: '只启用上游实际支持的能力。未勾选的档位不可选，不代表关闭思考。保存后在聊天模型选择器中选择思考等级。',
    noThinking: '未声明档位，请求使用上游默认行为。', invalidCapabilities: '请检查模型容量和思考映射：容量必须是正整数，上游值不能为空。',
  })
  Object.assign(dictionaries.en, { useReference: 'Apply official CLI reference', referenceHint: 'Defaults follow command-code@1.66.0 for exact matching model IDs; your explicit settings take priority. CLI declarations are not Provider API test results.', inherit: 'Restore inherited capabilities', unknown: 'Unknown', unsupported: 'No CLI reference for this model' })
  Object.assign(dictionaries.zh, { useReference: '应用官方 CLI 参考值', referenceHint: '同名模型默认采用 command-code@1.66.0 声明的能力，手动设置优先。这是 CLI 声明，不是 Provider API 实测结果。', inherit: '恢复继承的能力', unknown: '未知', unsupported: '此模型暂无 CLI 参考数据' })
  Object.assign(dictionaries.en, {
    addModel: 'Add model', modelId: 'Model ID', modelName: 'Display name (optional)', protocol: 'API protocol', chooseProtocol: 'Choose a protocol',
    fetchModels: 'Fetch model directory', fetching: 'Fetching…', fetched: 'Directory fetched. Select a new model, verify its protocol and limits, then add it.',
    fetchFailed: 'Could not fetch the directory. Check the base URL/key or add a model manually.', chooseFetched: 'Choose from fetched models',
    addHint: 'Add an exact model ID even before the built-in catalogue updates. Context size and protocol must be confirmed; saving does not test a paid model call.',
    invalidCustom: 'Check the model ID (unique, no spaces), protocol and positive context size.', added: 'Added to draft. Save CommandCode to activate.',
    removeModel: 'Remove custom model', removed: 'Removed from draft; save to apply.', noNew: 'No new models in this directory.',
    all: 'Use all directory models (including custom models)', catalogue: 'Built-in and saved custom models. Fetch is a manual GET /models request; no automatic polling or paid generation.',
  })
  Object.assign(dictionaries.zh, {
    addModel: '添加模型', modelId: '模型 ID', modelName: '显示名称（可选）', protocol: 'API 协议', chooseProtocol: '请选择协议',
    fetchModels: '拉取模型目录', fetching: '正在拉取…', fetched: '已拉取目录。请选择新模型，确认协议和容量后添加。',
    fetchFailed: '拉取失败，请检查基地址和密钥；也可以直接手动添加模型。', chooseFetched: '从拉取结果中选择',
    addHint: '内置目录尚未更新也可按准确 ID 添加。需确认上下文容量与协议；保存不会发送收费模型请求。',
    invalidCustom: '请检查模型 ID（唯一且不含空格）、协议及正整数上下文容量。', added: '已加入草稿，点击“保存 CommandCode”后生效。',
    removeModel: '移除自定义模型', removed: '已从草稿移除，保存后生效。', noNew: '目录中暂无新模型。',
    all: '启用全部目录模型（含自定义模型）', catalogue: '包含内置及已保存的自定义模型。拉取仅手动请求 GET /models，不自动轮询、不调用收费生成。',
  })
  const ids = new Set(catalog.map(model => model.id))
  const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages']
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id)
  function validateCustom(models) {
    const known = new Set(ids)
    for (const model of models) {
      if (!validId(model.id) || known.has(model.id) || !protocols.includes(model.api)
        || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
        || (model.maxTokens != null && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0))
        || (model.input?.length && model.input.some(item => !['text', 'image'].includes(item)))) throw new Error('invalidCustom')
      known.add(model.id)
    }
    return known
  }
  function directory(config) {
    return [...catalog, ...(config.customModels ?? []).map(model => ({ ...model, name: model.name || model.id }))]
  }
  function addCustom(draft, input) {
    const contextWindow = tokenCount(input.contextWindow)
    const maxTokens = tokenCount(input.maxTokens ?? '')
    const row = { id: input.id.trim(), name: input.name?.trim() || input.id.trim(), api: input.api, contextWindow,
      ...(maxTokens ? { maxTokens } : {}), input: input.input?.length ? [...input.input] : ['text'] }
    const customModels = [...(draft.customModels ?? []), row]
    validateCustom(customModels)
    return { ...draft, customModels, modelIds: draft.allModels ? draft.modelIds : [...new Set([...draft.modelIds, row.id])] }
  }
  function removeCustom(draft, id) {
    const modelEdits = { ...draft.modelEdits }
    delete modelEdits[id]
    return { ...draft, customModels: draft.customModels.filter(model => model.id !== id), modelIds: draft.modelIds.filter(value => value !== id), modelEdits }
  }
  async function fetchDirectory(remote, ns, baseURL, key) {
    const url = new URL(baseURL.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalidURL')
    const result = unwrap(await remote.llm.discoverModels(ns, { provider: ROUTE, baseURL: url.href.replace(/\/+$/, ''), ...(key.trim() ? { apiKey: key.trim() } : {}) }))
    return result.filter(row => validId(row.id))
  }
  function referenceDraft(id, base) {
    const row = reference.models[id]
    if (!row) return base
    return { ...base,
      ...(row.contextWindow ? { contextWindow: String(row.contextWindow) } : {}),
      ...(row.maxTokens ? { maxTokens: String(row.maxTokens) } : {}),
      ...(row.input ? { input: [...row.input] } : {}),
      ...(row.reasoningEfforts ? { reasoningEfforts: { ...row.reasoningEfforts } } : {}),
    }
  }
  function modelDraft(config, id) {
    const listed = (config.models ?? []).find(model => model.id === id) ?? {}
    const explicit = Object.fromEntries(Object.entries(listed).filter(([field, value]) =>
      value != null && !(field === 'input' && !value.length)))
    const overrides = Object.fromEntries(Object.entries(config.modelOverrides?.[id] ?? {}).filter(([field, value]) => value != null && !(field === 'input' && !value.length)))
    const value = { ...reference.models[id], ...(config.customModels ?? []).find(model => model.id === id), ...overrides, ...explicit }
    return {
      contextWindow: String(value.contextWindow ?? ''), maxTokens: String(value.maxTokens ?? ''),
      input: value.input?.length ? [...value.input] : ['text'],
      reasoningEfforts: { ...value.reasoningEfforts },
    }
  }
  function tokenCount(value) {
    if (String(value).trim() === '') return undefined
    const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(String(value).trim())
    const count = match ? Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] ?? 1) : NaN
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('invalidCapabilities')
    return count
  }
  function applyModelEdits(config, edits = {}) {
    const availableIds = validateCustom(config.customModels ?? [])
    const result = { ...config, models: (config.models ?? []).map(model => ({ ...model })), modelOverrides: { ...config.modelOverrides } }
    for (const [id, draft] of Object.entries(edits)) {
      if (!availableIds.has(id)) throw new Error('invalidCapabilities')
      const value = { ...result.modelOverrides[id] }
      for (const field of capabilityFields) delete value[field]
      if (draft === null) {
        result.modelOverrides[id] = value
        for (const model of result.models) if (model.id === id) for (const field of capabilityFields) delete model[field]
        continue
      }
      for (const field of ['contextWindow', 'maxTokens']) {
        const count = tokenCount(draft[field])
        if (count !== undefined) value[field] = count
      }
      if (!draft.input?.length || draft.input.some(input => !['text', 'image'].includes(input))) throw new Error('invalidCapabilities')
      value.input = [...new Set(draft.input)]
      value.reasoningEfforts = {}
      for (const [level, wire] of Object.entries(draft.reasoningEfforts ?? {})) {
        if (!levels.includes(level) || typeof wire !== 'string' || !wire.trim()) throw new Error('invalidCapabilities')
        value.reasoningEfforts[level] = wire.trim()
      }
      result.modelOverrides[id] = value
      // Selected-model metadata has higher precedence than overrides. Move only
      // the edited capability fields so old entries cannot silently undo a save.
      for (const model of result.models) if (model.id === id) for (const field of capabilityFields) delete model[field]
    }
    return result
  }
  function unwrap(result) {
    if (!result?.ok) throw new Error('remote-failed')
    return result.value
  }
  async function load(remote, ns) {
    const description = unwrap(await remote.settings.describe())
    const view = description.namespaces.find(item => item.ns === ns)
    if (!view) throw new Error('unavailable')
    const config = view.value.providers?.[ROUTE] ?? {}
    const ref = config.apiKeyEnv || 'CMD_API_KEY'
    const credentials = unwrap(await remote.credentials.describe([ref]))
    return { view, writable: description.writable, config, ref, credential: credentials[ref] ?? { configured: false, writable: false } }
  }
  function draftOf(config) {
    return {
      baseURL: config.baseURL || BASE,
      preferResponses: config.preferResponses === true,
      omitReasoningSummary: config.omitReasoningSummary !== false,
      zeroDataRetention: config.zeroDataRetention === true,
      allModels: !config.models?.length,
      modelIds: (config.models ?? []).map(item => item.id),
      modelEdits: {},
      customModels: (config.customModels ?? []).map(model => ({ ...model })),
    }
  }
  async function save(remote, ns, state, draft, key) {
    // Return only fixed error codes: remote errors must never echo a submitted secret.
    let keyStored = false
    try {
      if (!state.writable) return { ok: false, code: 'readOnly', keyStored }
      let url
      try { url = new URL(draft.baseURL.trim()) } catch { return { ok: false, code: 'invalidURL', keyStored } }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return { ok: false, code: 'invalidURL', keyStored }
      let availableIds
      try { availableIds = validateCustom(draft.customModels ?? []) }
      catch { return { ok: false, code: 'invalidCustom', keyStored } }
      if (!draft.allModels && (!draft.modelIds.length || draft.modelIds.some(id => !availableIds.has(id)))) return { ok: false, code: 'invalidModels', keyStored }
      const current = await load(remote, ns)
      if (!current.writable) return { ok: false, code: 'readOnly', keyStored }
      if (current.view.revision !== state.view.revision) return { ok: false, code: 'conflict', keyStored }
      const removed = new Set((current.config.customModels ?? []).filter(model => !availableIds.has(model.id)).map(model => model.id))
      const candidate = { ...current.config, customModels: draft.customModels ?? [],
        models: (current.config.models ?? []).filter(model => !removed.has(model.id)),
        modelOverrides: Object.fromEntries(Object.entries(current.config.modelOverrides ?? {}).filter(([id]) => !removed.has(id))),
      }
      let edited
      try { edited = applyModelEdits(candidate, draft.modelEdits) }
      catch { return { ok: false, code: 'invalidCapabilities', keyStored } }
      if (!key.trim() && !current.credential.configured) return { ok: false, code: 'required', keyStored }
      if (key.trim()) {
        if (!current.credential.writable) return { ok: false, code: 'locked', keyStored }
        unwrap(await remote.credentials.set(current.ref, key.trim()))
        keyStored = true
      }
      // Model selection changes must not erase saved capabilities for rows that
      // move out of the explicit selection (including switching to all models).
      for (const model of edited.models) if (draft.allModels || !draft.modelIds.includes(model.id)) {
        const metadata = Object.fromEntries(Object.entries(model).filter(([field, value]) => field !== 'id' && value != null
          && !(field === 'input' && !value.length)))
        if (Object.keys(metadata).length) edited.modelOverrides[model.id] = { ...edited.modelOverrides[model.id], ...metadata }
      }
      const previousModels = new Map((edited.models ?? []).map(model => [model.id, model]))
      const config = {
        ...edited,
        apiKeyEnv: current.ref,
        baseURL: url.href.replace(/\/+$/, ''),
        preferResponses: draft.preferResponses,
        omitReasoningSummary: draft.omitReasoningSummary,
        zeroDataRetention: draft.zeroDataRetention,
        models: draft.allModels ? [] : [...new Set(draft.modelIds)].map(id => previousModels.get(id) ?? { id }),
      }
      const response = await remote.settings.mutate(ns, [{ op: 'set', path: ['providers', ROUTE], value: config }], current.view.revision)
      if (!response?.ok) return { ok: false, code: keyStored ? 'partial' : response?.error?.code === 'settings/conflict' ? 'conflict' : 'saveFailed', keyStored }
      return { ok: true, keyStored }
    } catch { return { ok: false, code: keyStored ? 'partial' : 'saveFailed', keyStored } }
  }
  const css = `
.cc-provider {color:var(--dsw-alias-label-primary);padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font:inherit;display:flex;flex-direction:column;gap:12px}
.cc-provider h3 {font-size:14px;line-height:22px;font-weight:500;margin:0}
.cc-provider p {margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cc-provider .cc-field {display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px}
.cc-provider input[type=text],.cc-provider input[type=password],.cc-provider input[type=url],.cc-provider select {box-sizing:border-box;width:100%;min-height:32px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.cc-provider :is(input,select,button,summary):focus-visible {outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-provider :disabled {opacity:.55;cursor:not-allowed}
.cc-provider details {border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
.cc-provider summary {cursor:pointer;font-size:12px;line-height:22px}
.cc-provider .cc-advanced {display:flex;flex-direction:column;gap:12px;margin-top:10px}
.cc-provider .cc-check {display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:20px}
.cc-provider .cc-check input {accent-color:var(--dsw-alias-brand-primary)}
.cc-provider .cc-actions {display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.cc-provider button {border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.cc-provider .cc-save {font-weight:500;border-color:var(--dsw-alias-brand-primary)}
.cc-provider .cc-error {color:var(--dsw-alias-state-error-primary)}
.cc-provider .cc-success {color:var(--dsw-alias-state-success-primary)}
.cc-provider .cc-model {padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.cc-provider .cc-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.cc-provider .cc-level {display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center}
.cc-provider fieldset {border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.cc-provider legend {padding:0;margin-bottom:6px;font-size:12px}
`
  return {
    inject: ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings', 'remote.llm'],
    // Pure operations are also exposed for offline regression tests.
    helpers: { load, draftOf, save, modelDraft, referenceDraft, applyModelEdits, tokenCount, addCustom, removeCustom, directory, fetchDirectory, validateCustom },
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries))
      const t = ctx.locale.bind(NS)
      function Panel(props) {
        React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
        const ns = props.provider.settingsNs
        const [state, setState] = React.useState(null)
        const [draft, setDraft] = React.useState(draftOf({}))
        const [key, setKey] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [reload, setReload] = React.useState(0)
        const [discovering, setDiscovering] = React.useState(false)
        const [discovered, setDiscovered] = React.useState(null)
        const emptyModel = () => ({ id: '', name: '', api: '', contextWindow: '', maxTokens: '', input: ['text'] })
        const [newModel, setNewModel] = React.useState(emptyModel)
        React.useEffect(() => {
          let active = true
          setState(null); setKey(''); setNotice(null); setDiscovered(null); setNewModel(emptyModel())
          load(ctx.remote, ns).then(value => {
            if (!active) return
            setState(value); setDraft(draftOf(value.config))
          }).catch(() => { if (active) setNotice({ code: 'loadFailed', error: true }) })
          return () => { active = false }
        }, [ns, reload])
        const disabled = busy || discovering || !state || !state.writable
        const workingConfig = { ...state?.config, customModels: draft.customModels }
        const allModels = directory(workingConfig)
        const newRows = (discovered ?? []).filter(row => !allModels.some(model => model.id === row.id))
        const fetchModels = async () => {
          setDiscovering(true); setNotice(null); setDiscovered(null)
          try {
            const rows = await fetchDirectory(ctx.remote, ns, draft.baseURL, key)
            setDiscovered(rows); setNotice({ code: rows.some(row => !allModels.some(model => model.id === row.id)) ? 'fetched' : 'noNew', error: false })
          } catch { setNotice({ code: 'fetchFailed', error: true }) }
          finally { setDiscovering(false) }
        }
        const addModel = () => {
          try { setDraft(addCustom(draft, newModel)); setNewModel(emptyModel()); setNotice({ code: 'added', error: false }) }
          catch { setNotice({ code: 'invalidCustom', error: true }) }
        }
        const patch = update => setDraft(previous => ({ ...previous, ...update }))
        const check = (field, label) => h('label', { className: 'cc-check' },
          h('input', { type: 'checkbox', checked: draft[field], disabled, onChange: event => patch({ [field]: event.target.checked }) }), t(label))
        const modelCard = model => {
          const value = draft.modelEdits[model.id] === null ? modelDraft({ customModels: draft.customModels }, model.id) : draft.modelEdits[model.id] ?? modelDraft(workingConfig, model.id)
          const update = changes => setDraft(previous => ({ ...previous, modelEdits: { ...previous.modelEdits, [model.id]: changes === null ? null : { ...(previous.modelEdits[model.id] === null ? modelDraft({ customModels: draft.customModels }, model.id) : previous.modelEdits[model.id] ?? modelDraft(workingConfig, model.id)), ...changes } } }))
          const field = (name, label, placeholder) => h('label', { className: 'cc-field' }, t(label), h('input', { type: 'text', value: value[name], placeholder: String(placeholder ?? t('unknown')), disabled, onChange: event => update({ [name]: event.target.value }), 'aria-label': `${model.id} ${t(label)}` }))
          return h('details', { key: model.id, className: 'cc-model' },
            h('summary', null, `${model.name} · ${model.id}`),
            h('div', { className: 'cc-advanced' },
              h('div', { className: 'cc-grid' }, field('contextWindow', 'context', model.contextWindow), field('maxTokens', 'output', state.config.defaultMaxTokens ?? 8192)),
              h('p', null, t('sizes')),
              h('div', { className: 'cc-grid' }, ['text', 'image'].map(input => h('label', { className: 'cc-check', key: input },
                h('input', { type: 'checkbox', disabled, checked: value.input.includes(input), onChange: event => update({ input: event.target.checked ? [...new Set([...value.input, input])] : value.input.filter(item => item !== input) }) }), t(input)))),
              h('fieldset', { disabled }, h('legend', null, t('thinking')),
                levels.map(level => h('div', { key: level, className: 'cc-level' },
                  h('label', { className: 'cc-check' }, h('input', { type: 'checkbox', checked: Object.hasOwn(value.reasoningEfforts, level), onChange: event => {
                    const next = { ...value.reasoningEfforts }
                    if (event.target.checked) next[level] = level === 'off' ? 'none' : level
                    else delete next[level]
                    update({ reasoningEfforts: next })
                  } }), level),
                  h('input', { type: 'text', value: value.reasoningEfforts[level] ?? '', disabled: disabled || !Object.hasOwn(value.reasoningEfforts, level), 'aria-label': `${model.id} ${level} ${t('wire')}`, placeholder: t('wire'), onChange: event => update({ reasoningEfforts: { ...value.reasoningEfforts, [level]: event.target.value } }) }),
                )),
              ),
              h('p', null, t(Object.keys(value.reasoningEfforts).length ? 'capabilityHint' : 'noThinking')),
              h('p', null, t('referenceHint')),
              h('div', { className: 'cc-actions' },
                h('button', { type: 'button', disabled: disabled || !reference.models[model.id], onClick: () => update(referenceDraft(model.id, value)) }, t('useReference')),
                h('button', { type: 'button', disabled, onClick: () => update(null) }, t('inherit')),
                draft.customModels.some(row => row.id === model.id) ? h('button', { type: 'button', disabled, onClick: () => { setDraft(previous => removeCustom(previous, model.id)); setNotice({ code: 'removed', error: false }) } }, t('removeModel')) : null,
              ),
            ),
          )
        }
        const submit = async event => {
          event.preventDefault()
          if (disabled) return
          setBusy(true); setNotice(null)
          try {
            const result = await save(ctx.remote, ns, state, draft, key)
            if (result.keyStored || result.ok) setKey('')
            setNotice({ code: result.ok ? 'saved' : result.code, error: !result.ok })
            if (result.ok) {
              const fresh = await load(ctx.remote, ns)
              setState(fresh); setDraft(draftOf(fresh.config))
            }
          } catch { setNotice({ code: 'loadFailed', error: true }) }
          finally { setBusy(false) }
        }
        return h('form', { className: 'cc-provider', onSubmit: submit, 'aria-label': t('title'), 'aria-busy': busy },
          h('style', null, css), h('h3', null, t('title')), h('p', null, t('help')),
          !state && !notice ? h('p', { role: 'status' }, t('loading')) : null,
          state ? h(React.Fragment, null,
            !state.writable ? h('p', null, t('readOnly')) : null,
            h('label', { className: 'cc-field' }, t('key'), h('input', {
              type: 'password', autoComplete: 'new-password', value: key,
              disabled: disabled || !state.credential.writable,
              placeholder: t(state.credential.configured ? 'stored' : 'missing'),
              onChange: event => setKey(event.target.value),
            })),
            !state.credential.writable ? h('p', null, t('locked')) : null,
            h('details', null, h('summary', null, t('advanced')), h('div', { className: 'cc-advanced' },
              h('label', { className: 'cc-field' }, t('endpoint'), h('input', { type: 'url', value: draft.baseURL, disabled, onChange: event => patch({ baseURL: event.target.value }) })),
              check('preferResponses', 'responses'), check('omitReasoningSummary', 'summary'), check('zeroDataRetention', 'zdr'), check('allModels', 'all'),
              !draft.allModels ? h('label', { className: 'cc-field' }, t('models'), h('select', {
                multiple: true, size: 7, value: draft.modelIds, disabled,
                onChange: event => patch({ modelIds: Array.from(event.target.selectedOptions, option => option.value) }),
              }, allModels.map(model => h('option', { key: model.id, value: model.id }, `${model.name} (${model.id})`))), h('span', null, t('choose'))) : null,
              h('p', null, t('catalogue')),
              h('details', null, h('summary', null, t('addModel')), h('div', { className: 'cc-advanced' },
                h('p', null, t('addHint')),
                h('button', { type: 'button', disabled, onClick: fetchModels }, t(discovering ? 'fetching' : 'fetchModels')),
                discovered !== null ? h('label', { className: 'cc-field' }, t('chooseFetched'), h('select', {
                  disabled: disabled || !newRows.length, value: newRows.some(row => row.id === newModel.id) ? newModel.id : '',
                  onChange: event => { const row = newRows.find(row => row.id === event.target.value); if (row) setNewModel({ id: row.id, name: row.name || row.id, api: '', contextWindow: String(row.contextWindow ?? ''), maxTokens: String(row.maxTokens ?? ''), input: row.inputModalities?.length ? [...row.inputModalities] : ['text'] }) },
                }, h('option', { value: '' }, t(newRows.length ? 'chooseFetched' : 'noNew')), ...newRows.map(row => h('option', { key: row.id, value: row.id }, row.name ? `${row.name} (${row.id})` : row.id)))) : null,
                ...[['id', 'modelId'], ['name', 'modelName']].map(([field, label]) => h('label', { className: 'cc-field', key: field }, t(label), h('input', { type: 'text', value: newModel[field], disabled, onChange: event => setNewModel(previous => ({ ...previous, [field]: event.target.value })) }))),
                h('label', { className: 'cc-field' }, t('protocol'), h('select', { value: newModel.api, disabled, onChange: event => setNewModel(previous => ({ ...previous, api: event.target.value })) }, h('option', { value: '' }, t('chooseProtocol')), ...protocols.map(api => h('option', { key: api, value: api }, api)))),
                h('div', { className: 'cc-grid' }, ...[['contextWindow', 'context'], ['maxTokens', 'output']].map(([field, label]) => h('label', { className: 'cc-field', key: field }, t(label), h('input', { type: 'text', value: newModel[field], disabled, placeholder: field === 'maxTokens' ? String(state.config.defaultMaxTokens ?? 8192) : '', onChange: event => setNewModel(previous => ({ ...previous, [field]: event.target.value })) })))),
                h('p', null, t('sizes')),
                h('button', { type: 'button', disabled, onClick: addModel }, t('addModel')),
              )),
              h('h3', null, t('capabilities')),
              ...allModels.filter(model => draft.allModels || draft.modelIds.includes(model.id)).map(modelCard),
            )),
          ) : null,
          notice ? h('p', { className: notice.error ? 'cc-error' : 'cc-success', role: notice.error ? 'alert' : 'status' }, t(notice.code)) : null,
          h('div', { className: 'cc-actions' },
            h('button', { type: 'button', disabled: busy || discovering, onClick: () => setReload(value => value + 1) }, t('refresh')),
            h('button', { type: 'submit', className: 'cc-save', disabled: disabled || (!state?.credential.configured && !key.trim()) }, t(busy ? 'saving' : 'save')),
          ),
        )
      }
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-commandcode',
      }, Panel))
    },
  }
}
