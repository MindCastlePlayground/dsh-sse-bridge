// Standalone integration harness: real DSH services are not required.
//
// It wires the bridge's own two directions together over a real SSE upstream:
//
//   HTTP client -> export listener -> DSH-shaped llm.stream -> import adapter
//               -> real upstream SSE -> back out as SSE
//
// That is the same data path a profile install takes, minus DSH itself, so it is
// the right place to prove the protocol before blaming a plugin host.
//
// Usage:
//   node scripts/verify.mjs --upstream http://127.0.0.1:47180/v1 --model deepseek-v4.1-flash
//   node scripts/verify.mjs --upstream ... --model ... --serve 47190   # keep serving

import { normalizeConfig } from '../lib/config.js'
import { createImportAdapter } from '../lib/import-adapter.js'
import { SseExportServer } from '../lib/export-server.js'
import { parseSSE } from '../lib/sse.js'

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const upstream = String(argument('upstream', 'http://127.0.0.1:47180/v1'))
const model = String(argument('model', 'deepseek-v4.1-flash'))
const serve = argument('serve', undefined)
const route = 'verify-upstream'

const log = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
  trace: () => {},
}

// A minimal but real `ctx`: the import adapter only reaches for the llm and
// attachments services, and neither is needed to prove SSE framing.
const ctx = { get: () => undefined }

const config = normalizeConfig({
  import: {
    route,
    displayName: 'Verify Upstream',
    baseURL: upstream,
    discoverModels: false,
    connectTimeoutMs: 30_000,
    streamIdleTimeoutMs: 120_000,
    models: [{ id: model, contextWindow: 262_144, maxTokens: 32_768 }],
  },
  export: {
    port: serve === undefined ? 0 : Number(serve),
    modelSource: 'static',
    models: [{ id: model }],
    trace: 'summary',
  },
})

console.log(`[verify] upstream ${upstream} model ${model}`)

// ---- 1. DSH adapter surface ------------------------------------------------
const adapter = createImportAdapter({ config: config.import, ctx, log })
const info = await adapter.resolveModel(route, model)
console.log(`[verify] resolveModel -> ${info.provider}/${info.id} ctx=${info.context.contextWindow} max=${info.defaultMaxTokens}`)
const listed = await adapter.listModels(route)
console.log(`[verify] listModels -> ${listed.map((entry) => entry.id).join(', ')}`)

// ---- 2. Real SSE round trip through the import adapter ---------------------
const started = Date.now()
const text = []
let finish
let usage
let toolCalls = 0
for await (const chunk of adapter.stream({
  provider: route,
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: bridge ok' }] }],
  maxTokens: 64,
})) {
  if (chunk.type === 'text-delta') text.push(chunk.text)
  if (chunk.type === 'tool-call-delta') toolCalls += 1
  if (chunk.type === 'usage') usage = chunk.usage
  if (chunk.type === 'finish') finish = chunk.reason
}
const assembled = text.join('')
console.log(`[verify] import stream -> finish=${finish?.kind} text=${JSON.stringify(assembled)}`)
console.log(`[verify] usage -> ${JSON.stringify(usage)} (${Date.now() - started}ms)`)
if (assembled.length === 0 && toolCalls === 0) {
  console.error('[verify] FAIL: the upstream produced no content')
  process.exit(1)
}

// ---- 3. The export listener over the same route ----------------------------
const server = new SseExportServer({
  config: config.export,
  log,
  attachments: undefined,
  listModels: () => [{ id: model, provider: route, model, name: model }],
  resolveRoute: async (modelId) => (modelId === model ? { provider: route, model } : undefined),
  stream: (options) => adapter.stream(options),
})
await server.start()
console.log(`[verify] export listening on ${server.origin}`)

const response = await fetch(`${server.origin}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'Reply with exactly: bridge ok' }],
  }),
})
if (!response.ok) {
  console.error(`[verify] FAIL: HTTP ${response.status}: ${await response.text()}`)
  await server.stop()
  process.exit(1)
}

const wireText = []
let wireFinish
let wireUsage
let frames = 0
for await (const event of parseSSE(response.body)) {
  if (event.data === '[DONE]') break
  const payload = JSON.parse(event.data)
  frames += 1
  if (payload.error !== undefined) {
    console.error(`[verify] FAIL: ${payload.error.message}`)
    await server.stop()
    process.exit(1)
  }
  if (payload.usage !== undefined) wireUsage = payload.usage
  const choice = payload.choices?.[0]
  if (choice?.delta?.content) wireText.push(choice.delta.content)
  if (choice?.finish_reason) wireFinish = choice.finish_reason
}
console.log(`[verify] export stream -> finish=${wireFinish} frames=${frames} text=${JSON.stringify(wireText.join(''))}`)
console.log(`[verify] export usage -> ${JSON.stringify(wireUsage)}`)

const ok = wireText.join('').length > 0 && wireFinish === 'stop'
console.log(ok ? '[verify] PASS: the SSE bridge round-trips a real model' : '[verify] FAIL: the exported stream was empty')

if (serve !== undefined) {
  // Stay attached to the listening socket; exiting here would close the port the
  // caller intends to point a real client at.
  console.log(`[verify] serving at ${server.origin} — Ctrl+C to stop`)
  const shutdown = async () => {
    await server.stop()
    process.exit(ok ? 0 : 1)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else {
  await server.stop()
  process.exit(ok ? 0 : 1)
}
