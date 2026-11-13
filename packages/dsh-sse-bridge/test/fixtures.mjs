// Test fixtures: a scriptable DSH `llm` stand-in and a scriptable SSE upstream.
//
// Both are deliberately faithful to the real contracts rather than convenient:
// the llm stand-in validates adapter metadata the way LlmRuntime does, and the
// upstream speaks real SSE framing so the parser is exercised, not bypassed.

import http from 'node:http'

/** Minimal DSH `llm` service: registration, catalog, streaming. */
export function createFakeLLM({ streams = {}, catalog = {} } = {}) {
  const adapters = new Map()
  const calls = []

  return {
    calls,
    adapters,
    registerAdapter(routes, adapter) {
      for (const route of routes) {
        if (adapters.has(route)) throw new Error(`an adapter for provider "${route}" is already registered`)
        // LlmRuntime validates providerInfo exactly like this.
        const info = adapter.providerInfo(route)
        if (typeof info.id !== 'string' || info.id !== route || typeof info.name !== 'string' || info.name.length === 0) {
          throw new Error(`adapter metadata for provider "${route}" must preserve its id and have a non-empty name`)
        }
        adapters.set(route, adapter)
        void info
      }
      const handle = () => {
        for (const route of routes) adapters.delete(route)
      }
      handle.replace = (next) => {
        for (const route of routes) adapters.delete(route)
        for (const route of next) adapters.set(route, adapter)
      }
      return handle
    },
    listProviders() {
      return [...adapters.keys()].map((id) => ({ id, name: adapters.get(id).providerInfo(id).name }))
    },
    async listModels(provider) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) throw new Error(`NO_ADAPTER: ${provider}`)
      return adapter.listModels(provider)
    },
    async stream(options) {
      calls.push(options)
      const scripted = streams[`${options.provider}/${options.model}`] ?? streams[options.provider] ?? streams['*']
      if (scripted !== undefined) {
        return typeof scripted === 'function' ? scripted(options) : scripted
      }
      // No script: behave like the real runtime and dispatch to the adapter that
      // owns the route, so an import route is actually exercised end to end.
      const adapter = adapters.get(options.provider)
      if (adapter !== undefined && typeof adapter.stream === 'function') return adapter.stream(options)
      return (async function* noAdapter() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `NO_ADAPTER: ${options.provider}`, code: 'NO_ADAPTER' } } }
      })()
    },
    catalogOf(provider) {
      return catalog[provider] ?? []
    },
  }
}

/** An async generator over an array of chunks, with a controllable delay. */
export async function* fromChunks(chunks, { delayMs = 0 } = {}) {
  for (const chunk of chunks) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    yield chunk
  }
}

/** A canonical DSH stream: reasoning, text, usage, finish. */
export function textStream(text, { reasoning, usage, finish = { kind: 'stop' } } = {}) {
  return [
    { type: 'block-start', index: 0, blockType: reasoning === undefined ? 'text' : 'reasoning' },
    ...(reasoning === undefined ? [] : [
      { type: 'reasoning-delta', index: 0, text: reasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      { type: 'block-start', index: 1, blockType: 'text' },
    ]),
    ...splitDeltas(text, reasoning === undefined ? 0 : 1),
    {
      type: 'block-end',
      index: reasoning === undefined ? 0 : 1,
      block: { type: 'text', text },
    },
    ...(usage === undefined ? [] : [{ type: 'usage', usage }]),
    { type: 'finish', reason: finish },
  ]
}

function splitDeltas(text, index) {
  const out = []
  for (let position = 0; position < text.length; position += 4) {
    out.push({ type: 'text-delta', index, text: text.slice(position, position + 4) })
  }
  return out
}

/** A DSH stream that ends in a tool call. */
export function toolStream({ id = 'call_1', name = 'read', args = '{"path":"a.txt"}', usage } = {}) {
  const parts = []
  for (const piece of args.match(/.{1,5}/gs) ?? []) {
    parts.push({ type: 'tool-call-delta', index: 0, id, name, argumentsDelta: piece })
  }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    ...parts,
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    ...(usage === undefined ? [] : [{ type: 'usage', usage }]),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * A scriptable OpenAI-compatible SSE upstream.
 *
 * `respond(request, body)` returns either { frames: string[] } for SSE or
 * { json } for a non-streaming reply, or { status, body } for an error.
 */
export async function startUpstream(respond) {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = raw.length === 0 ? undefined : JSON.parse(raw) } catch { body = raw }
    requests.push({ method: request.method, url: request.url, headers: request.headers, body })

    if (request.method === 'GET' && request.url.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'discovered-a' }, { id: 'discovered-b' }] }))
      return
    }

    const outcome = await respond(request, body)
    if (outcome.status !== undefined) {
      response.writeHead(outcome.status, { 'content-type': 'application/json', ...outcome.headers })
      response.end(outcome.body ?? '{}')
      return
    }
    if (outcome.json !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(outcome.json))
      return
    }
    response.writeHead(200, {
      'content-type': outcome.contentType ?? 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    for (const frame of outcome.frames) {
      response.write(frame)
      if (outcome.delayMs) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs))
    }
    response.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
    },
  }
}

/** Build one OpenAI SSE frame from a chunk payload. */
export function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Collect an async iterable into an array. */
export async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** A fake Cordis context with the services the bridge touches. */
export function createFakeCtx({ llm, attachments, tools } = {}) {
  const registered = []
  return {
    registered,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'attachments') return attachments
      if (name === 'tools') return tools
      return undefined
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {
          const index = registered.indexOf(tool)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(factory) {
      const dispose = factory()
      return dispose
    },
  }
}
