// Configuration normalization for the SSE bridge.
//
// Two directions share one row of configuration:
//
//   import  SSE-ish upstream  ->  DSH model route
//   export  DSH model route   ->  OpenAI Chat Completions over SSE for local clients
//
// Everything is validated once, here, so the adapter, the export server and the
// tools can assume a complete shape.  The package deliberately has no dependency
// on @deepseek-ai/* packages: profile-local ESM packages cannot reliably resolve
// the DSH tree on Windows, so runtime services are reached through the Cordis
// context and everything else is Node built-ins.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export class SseBridgeConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SseBridgeConfigError'
    this.code = 'SSE_BRIDGE_CONFIG'
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new SseBridgeConfigError(message)
}

function asString(value, field, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function asNonEmptyString(value, field, fallback) {
  const text = asString(value, field, fallback)
  if (text.length === 0) fail(`${field} must be non-empty`)
  return text
}

function asOptionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function asBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function asInteger(value, field, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function asStringArray(value, field, fallback = []) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') fail(`${field}[${index}] must be a string`)
    return entry
  })
}

function asEnum(value, field, allowed, fallback) {
  const text = asOptionalString(value, field) ?? fallback
  if (!allowed.includes(text)) fail(`${field} must be one of ${allowed.map((item) => `"${item}"`).join(', ')}`)
  return text
}

function asHeaders(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) fail(`${field} must be an object`)
  const headers = {}
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') fail(`${field}.${name} must be a string`)
    headers[name] = header
  }
  return headers
}

/** Expand `${env:NAME}` and `${name}` placeholders against a variable table. */
export function expandString(value, vars) {
  return value.replace(/\$\{([^}]+)\}/g, (whole, expression) => {
    const expr = expression.trim()
    if (expr.startsWith('env:')) return process.env[expr.slice(4)] ?? ''
    if (Object.hasOwn(vars, expr)) return String(vars[expr] ?? '')
    return whole
  })
}

function normalizeModels(raw, field) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(`${field} must be an array`)
  const seen = new Set()
  return raw.map((entry, index) => {
    const at = `${field}[${index}]`
    if (!isPlainObject(entry)) fail(`${at} must be an object`)
    const id = asNonEmptyString(entry.id, `${at}.id`)
    if (seen.has(id)) fail(`${at}.id "${id}" is duplicated`)
    seen.add(id)
    const input = entry.input === undefined
      ? ['text']
      : asStringArray(entry.input, `${at}.input`).map((modality, position) => {
          if (modality !== 'text' && modality !== 'image') fail(`${at}.input[${position}] must be "text" or "image"`)
          return modality
        })
    if (!input.includes('text')) input.unshift('text')
    return {
      id,
      name: asOptionalString(entry.name, `${at}.name`) ?? id,
      ...(entry.description === undefined ? {} : { description: asString(entry.description, `${at}.description`) }),
      contextWindow: asInteger(entry.contextWindow, `${at}.contextWindow`, 131_072, { min: 1 }),
      maxTokens: asInteger(entry.maxTokens, `${at}.maxTokens`, 8_192, { min: 1 }),
      input,
      // `false` disables the reasoning control; an object maps a DSH effort id
      // to the exact wire value the upstream expects.
      ...(entry.reasoningEfforts === undefined ? {} : { reasoningEfforts: normalizeReasoningEfforts(entry.reasoningEfforts, `${at}.reasoningEfforts`) }),
      ...(entry.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: asString(entry.defaultReasoningEffort, `${at}.defaultReasoningEffort`) }),
    }
  })
}

function normalizeReasoningEfforts(raw, field) {
  if (raw === false) return false
  if (!isPlainObject(raw)) fail(`${field} must be an object mapping effort id to wire value, or false`)
  const out = {}
  for (const [effort, wire] of Object.entries(raw)) {
    if (!ROUTE_RE.test(effort)) fail(`${field} key "${effort}" is invalid`)
    if (typeof wire !== 'string' || wire.length === 0) fail(`${field}.${effort} must be a non-empty string`)
    out[effort] = wire
  }
  return out
}

function normalizeImport(raw, field) {
  // An absent direction is simply not configured; `false` disables it explicitly.
  if (raw === undefined) return null
  if (raw === false || raw === null) return null
  const source = raw
  if (!isPlainObject(source)) fail(`${field} must be an object or false`)

  const route = asNonEmptyString(source.route, `${field}.route`)
  if (!ROUTE_RE.test(route)) fail(`${field}.route must match ${ROUTE_RE}`)
  const baseURL = asString(source.baseURL, `${field}.baseURL`)
  if (!/^https?:\/\//i.test(baseURL)) fail(`${field}.baseURL must start with http:// or https://`)

  const requestPath = asOptionalString(source.requestPath, `${field}.requestPath`) ?? '/chat/completions'
  if (!requestPath.startsWith('/')) fail(`${field}.requestPath must start with "/"`)

  const dialect = asEnum(source.dialect, `${field}.dialect`, ['openai', 'anthropic'], 'openai')
  const maxTokensField = asEnum(source.maxTokensField, `${field}.maxTokensField`, ['max_tokens', 'max_completion_tokens'], 'max_tokens')

  return {
    route,
    displayName: asNonEmptyString(source.displayName, `${field}.displayName`, route),
    baseURL: baseURL.replace(/\/+$/, ''),
    requestPath,
    modelsURL: asOptionalString(source.modelsURL, `${field}.modelsURL`),
    dialect,
    apiKeyEnv: asOptionalString(source.apiKeyEnv, `${field}.apiKeyEnv`),
    apiKey: asOptionalString(source.apiKey, `${field}.apiKey`),
    headers: asHeaders(source.headers, `${field}.headers`),
    models: normalizeModels(source.models, `${field}.models`),
    maxTokensField,
    reasoningFields: asStringArray(source.reasoningFields, `${field}.reasoningFields`, ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking']),
    extraBody: isPlainObject(source.extraBody) ? source.extraBody : {},
    sessionHeader: asOptionalString(source.sessionHeader, `${field}.sessionHeader`),
    sendSessionHeader: asBoolean(source.sendSessionHeader, `${field}.sendSessionHeader`, true),
    discoverModels: asBoolean(source.discoverModels, `${field}.discoverModels`, true),
    connectTimeoutMs: asInteger(source.connectTimeoutMs, `${field}.connectTimeoutMs`, 30_000, { min: 100 }),
    streamIdleTimeoutMs: asInteger(source.streamIdleTimeoutMs, `${field}.streamIdleTimeoutMs`, 300_000, { min: 1_000 }),
    modelListTimeoutMs: asInteger(source.modelListTimeoutMs, `${field}.modelListTimeoutMs`, 10_000, { min: 100 }),
    trace: asEnum(source.trace, `${field}.trace`, ['off', 'summary', 'verbose'], 'summary'),
  }
}

function normalizeExport(raw, field) {
  // `export: {}` means "export with defaults"; `false` disables it.
  if (raw === false || raw === null) return null
  const source = raw
  if (!isPlainObject(source)) fail(`${field} must be an object or false`)

  const modelSource = asEnum(source.modelSource, `${field}.modelSource`, ['catalog', 'static'], 'catalog')
  const models = normalizeModels(source.models, `${field}.models`)
  if (modelSource === 'static' && models.length === 0) {
    fail(`${field}.models must list at least one model when ${field}.modelSource is "static"`)
  }

  const auth = isPlainObject(source.auth) ? source.auth : {}
  const apiKey = asOptionalString(auth.apiKey, `${field}.auth.apiKey`)
  const apiKeyEnv = asOptionalString(auth.apiKeyEnv, `${field}.auth.apiKeyEnv`)
  const allowLoopbackWithoutKey = asBoolean(auth.allowLoopbackWithoutKey, `${field}.auth.allowLoopbackWithoutKey`, true)

  return {
    enabled: asBoolean(source.enabled, `${field}.enabled`, true),
    host: asOptionalString(source.host, `${field}.host`) ?? '127.0.0.1',
    port: asInteger(source.port, `${field}.port`, 47190, { min: 0, max: 65_535 }),
    basePath: normalizeBasePath(source.basePath, `${field}.basePath`),
    modelSource,
    models,
    includeRoutes: asStringArray(source.includeRoutes, `${field}.includeRoutes`),
    defaultModel: asOptionalString(source.defaultModel, `${field}.defaultModel`),
    auth: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      allowLoopbackWithoutKey,
    },
    cors: normalizeCors(source.cors, `${field}.cors`),
    sse: {
      // Comment frames keep proxies and idle timers alive during a slow first token.
      keepAliveMs: asInteger(source.sse?.keepAliveMs, `${field}.sse.keepAliveMs`, 15_000, { min: 0 }),
      retryMs: asInteger(source.sse?.retryMs, `${field}.sse.retryMs`, 3_000, { min: 0 }),
    },
    limits: {
      maxBodyBytes: asInteger(source.limits?.maxBodyBytes, `${field}.limits.maxBodyBytes`, 8_388_608, { min: 1_024 }),
      maxConcurrent: asInteger(source.limits?.maxConcurrent, `${field}.limits.maxConcurrent`, 8, { min: 1 }),
      requestTimeoutMs: asInteger(source.limits?.requestTimeoutMs, `${field}.limits.requestTimeoutMs`, 600_000, { min: 1_000 }),
    },
    trace: asEnum(source.trace, `${field}.trace`, ['off', 'summary', 'verbose'], 'summary'),
  }
}

function normalizeBasePath(raw, field) {
  if (raw === undefined || raw === null) return '/v1'
  if (typeof raw !== 'string') fail(`${field} must be a string`)
  let text = raw.trim()
  if (text.length === 0 || text === '/') return ''
  if (!text.startsWith('/')) text = `/${text}`
  return text.replace(/\/+$/, '')
}

function normalizeCors(raw, field) {
  if (raw === false) return { enabled: false, origins: [] }
  const source = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(source)) fail(`${field} must be an object or false`)
  return {
    enabled: asBoolean(source.enabled, `${field}.enabled`, true),
    origins: asStringArray(source.origins, `${field}.origins`, ['*']),
  }
}

/**
 * Normalize the whole plugin config.
 * @param {unknown} raw raw Cordis row config.
 * @returns {{ import: object|null, export: object|null }}
 */
export function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}

  // The row is dormant until a direction is declared, which keeps the bundle's
  // own patch installable without forcing a port or an upstream on every user.
  const hasImport = source.import !== undefined || source.inbound !== undefined || source.import_ !== undefined
  const hasExport = source.export !== undefined || source.outbound !== undefined
  if (!hasImport && !hasExport) return { import: null, export: null }

  // `import` is a reserved word in some tooling, so both `import` and the
  // `inbound` alias are accepted; the docs use `import`.  A key that is present
  // but set to `false` disables that direction; a key that is absent means the
  // direction is not configured at all.
  const incoming = hasImport ? normalizeImport(source.import ?? source.inbound ?? source.import_, 'import') : null
  const outgoing = hasExport ? normalizeExport(source.export ?? source.outbound, 'export') : null
  if (incoming === null && outgoing === null) {
    fail('config disables both directions; remove the row instead of setting both to false')
  }
  return { import: incoming, export: outgoing }
}

/** True when the config carries no usable direction (used for the dormant row). */
export function isDormant(config) {
  return config.import === null && config.export === null
}
