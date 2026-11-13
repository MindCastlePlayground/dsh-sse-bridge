// Export direction: DSH model routes become a local OpenAI-compatible SSE server.
//
// The server is deliberately thin.  It owns HTTP concerns — routing, CORS,
// auth, backpressure, disconnects, keepalives, byte accounting — and delegates
// every model call to an injected `llm.stream()`-shaped function.  That split is
// what makes the whole thing testable without DSH and usable from opencode, the
// OpenAI SDKs, curl, or any EventSource client.

import http from 'node:http'
import { finishReasonFromDSH, sseComment, sseFrame } from './sse.js'

const MAX_ERROR_BODY = 2_048

export class SseExportServer {
  /**
   * @param {{
   *   config: object,
   *   log: { trace?: Function, warn?: Function, info?: Function, error?: Function },
   *   listModels: () => Promise<Array<object>> | Array<object>,
   *   resolveRoute: (modelId: string) => { provider: string, model: string } | Promise<{ provider: string, model: string }>,
   *   stream: (request: object) => AsyncIterable<object>,
   * }} options
   */
  constructor(options) {
    this.options = options
    this.config = options.config
    this.log = options.log ?? {}
    this.listModels = options.listModels
    this.resolveRoute = options.resolveRoute
    this.stream = options.stream
    this.server = undefined
    this.port = undefined
    this.activeRequests = 0
    this.closing = false
    this.stats = { requests: 0, streams: 0, errors: 0, active: 0, bytes: 0, started: 0 }
  }

  get basePath() {
    return this.config.basePath
  }

  get origin() {
    const host = this.config.host === '0.0.0.0' || this.config.host === '::' ? '127.0.0.1' : this.config.host
    const formatted = host.includes(':') ? `[${host}]` : host
    return `http://${formatted}:${this.port ?? this.config.port}${this.basePath}`
  }

  async start() {
    if (this.server !== undefined) return this
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log.error?.(`[sse-bridge:export] unhandled request failure: ${String(error?.message ?? error)}`)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'internal bridge error', type: 'internal_error' } }))
        } else {
          response.destroy()
        }
      })
    })
    server.keepAliveTimeout = 72_000
    server.headersTimeout = 75_000
    // Streaming replies outlive the default request timeout by design.
    server.requestTimeout = 0

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.port, this.config.host)
    })

    this.server = server
    this.port = server.address().port
    this.stats.started = Date.now()
    this.log.info?.(`[sse-bridge:export] listening on ${this.origin}`)
    return this
  }

  async stop() {
    if (this.server === undefined) return
    this.closing = true
    const server = this.server
    this.server = undefined
    await new Promise((resolve) => {
      server.close(() => resolve())
      // `close()` waits for keep-alive sockets; SSE responses are long-lived, so
      // destroy whatever is still attached instead of hanging the unload path.
      server.closeAllConnections?.()
      setTimeout(() => server.closeAllConnections?.(), 250).unref?.()
    })
    this.log.info?.('[sse-bridge:export] stopped')
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  async handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    if (this.applyCors(request, response)) {
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end()
        return
      }
    }

    const route = this.matchRoute(path)
    if (route === null) {
      this.writeJSON(response, 404, {
        error: { message: `unknown endpoint ${path}; expected ${this.basePath}/chat/completions, ${this.basePath}/models, ${this.basePath}/health`, type: 'not_found', code: 'not_found' },
      })
      return
    }

    const auth = this.checkAuth(request)
    if (auth !== null) {
      this.stats.errors += 1
      this.writeJSON(response, 401, {
        error: { message: auth, type: 'invalid_request_error', code: 'invalid_api_key' },
      })
      return
    }

    try {
      switch (route) {
        case 'health':
          this.writeJSON(response, 200, {
            ok: true,
            service: 'dsh-sse-bridge',
            version: 1,
            basePath: this.basePath,
            stats: { ...this.stats, active: this.activeRequests },
            uptimeMs: Date.now() - this.stats.started,
          })
          return
        case 'models':
          await this.handleModels(response)
          return
        case 'chat':
          await this.handleChat(request, response)
          return
        default:
          this.writeJSON(response, 404, { error: { message: 'not found', type: 'not_found' } })
      }
    } catch (error) {
      this.stats.errors += 1
      this.log.error?.(`[sse-bridge:export] ${route} failed: ${String(error?.message ?? error)}`)
      if (!response.headersSent) {
        this.writeJSON(response, 500, { error: { message: String(error?.message ?? error), type: 'internal_error' } })
      } else {
        response.destroy()
      }
    }
  }

  matchRoute(path) {
    const base = this.basePath
    if (path === `${base}/health` || path === `${base}/healthz`) return 'health'
    if (path === `${base}/models`) return 'models'
    if (path === `${base}/chat/completions`) return 'chat'
    // OpenAI clients configured with a bare origin often probe `/v1/models`.
    if (base !== '' && path === '/models') return 'models'
    return null
  }

  applyCors(request, response) {
    if (!this.config.cors.enabled) return false
    const origin = request.headers.origin
    const allowAny = this.config.cors.origins.includes('*')
    if (origin !== undefined) {
      if (!allowAny && !this.config.cors.origins.includes(origin)) return false
      response.setHeader('access-control-allow-origin', allowAny ? '*' : origin)
      response.setHeader('vary', 'origin')
    } else if (allowAny) {
      response.setHeader('access-control-allow-origin', '*')
    }
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    response.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, x-stainless-lang, x-stainless-package-version')
    response.setHeader('access-control-max-age', '600')
    return true
  }

  /** @returns {string|null} an error message, or null when the request is authorized. */
  checkAuth(request) {
    const { apiKey, apiKeyEnv, allowLoopbackWithoutKey } = this.config.auth
    const expected = apiKey ?? (apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv])
    if (expected === undefined || expected.length === 0) {
      if (allowLoopbackWithoutKey) return null
      return 'this bridge requires an API key, but none is configured'
    }
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
    const apiKeyHeader = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'].trim() : undefined
    const presented = bearer ?? apiKeyHeader
    if (presented === undefined) return 'missing credentials: send Authorization: Bearer <key>'
    if (!timingSafeEqual(presented, expected)) return 'invalid API key'
    return null
  }

  writeJSON(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    })
    response.end(payload)
  }

  async handleModels(response) {
    const models = await this.listModels()
    this.writeJSON(response, 200, {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created: Math.floor((this.stats.started || Date.now()) / 1000),
        owned_by: model.ownedBy ?? 'dsh-sse-bridge',
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens }),
      })),
    })
  }

  async readJSONBody(request) {
    const limit = this.config.limits.maxBodyBytes
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`request body exceeds ${limit} bytes`)
        error.status = 413
        throw error
      }
      chunks.push(chunk)
    }
    if (size === 0) {
      const error = new Error('request body is empty')
      error.status = 400
      throw error
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      const wrapped = new Error(`request body is not valid JSON: ${String(error?.message ?? error)}`)
      wrapped.status = 400
      throw wrapped
    }
  }

  // -------------------------------------------------------------------------
  // Chat completions
  // -------------------------------------------------------------------------

  async handleChat(request, response) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, OPTIONS')
      this.writeJSON(response, 405, { error: { message: 'use POST', type: 'invalid_request_error' } })
      return
    }
    if (this.activeRequests >= this.config.limits.maxConcurrent) {
      this.stats.errors += 1
      this.writeJSON(response, 429, {
        error: { message: `bridge concurrency limit (${this.config.limits.maxConcurrent}) reached`, type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      })
      return
    }

    let body
    try {
      body = await this.readJSONBody(request)
    } catch (error) {
      this.stats.errors += 1
      this.writeJSON(response, error.status ?? 400, {
        error: { message: String(error.message), type: 'invalid_request_error', code: 'invalid_body' },
      })
      return
    }

    const requestedModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined
    const resolved = requestedModel === undefined
      ? this.config.defaultModel === undefined
        ? { provider: undefined, model: undefined }
        : await this.resolveRoute(this.config.defaultModel)
      : await this.resolveRoute(requestedModel)

    if (resolved === undefined || resolved === null || typeof resolved.provider !== 'string' || resolved.provider.length === 0) {
      this.writeJSON(response, 404, {
        error: {
          message: `model "${requestedModel ?? ''}" is not served by this bridge`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'model',
        },
      })
      return
    }

    const stream = body.stream !== false
    const includeUsage = body.stream_options?.include_usage !== false
    const wireModel = requestedModel ?? resolved.model
    const requestId = `breq-${Math.random().toString(36).slice(2, 12)}`

    this.activeRequests += 1
    this.stats.requests += 1
    this.stats.active = this.activeRequests

    const controller = new AbortController()
    const clientGone = () => {
      controller.abort(Object.assign(new Error('client disconnected'), { code: 'CLIENT_DISCONNECT' }))
    }
    response.once('close', () => {
      if (!response.writableEnded) clientGone()
    })

    const timeout = setTimeout(() => {
      controller.abort(Object.assign(new Error(`request timeout after ${this.config.limits.requestTimeoutMs}ms`), { code: 'TIMEOUT' }))
    }, this.config.limits.requestTimeoutMs)
    timeout.unref?.()

    let options
    try {
      options = await this.toLLMOptions(body, resolved, controller.signal, requestId)
    } catch (error) {
      clearTimeout(timeout)
      this.activeRequests -= 1
      this.stats.active = this.activeRequests
      this.stats.errors += 1
      this.writeJSON(response, 400, {
        error: { message: String(error?.message ?? error), type: 'invalid_request_error', code: error?.code ?? 'invalid_request' },
      })
      return
    }

    if (this.config.trace !== 'off') {
      this.log.trace?.('export-request', {
        requestId,
        model: wireModel,
        provider: resolved.provider,
        stream,
        messages: options.messages.length,
        tools: options.tools?.length ?? 0,
      })
    }

    let chunks
    try {
      // A route may hand back an async iterable (DSH's own adapters), a promise
      // for one, or a plain array of chunks. Normalizing here keeps the writers
      // simple and stops a shape mismatch from looking like a provider error.
      chunks = toAsyncIterable(await this.stream(options))
    } catch (error) {
      clearTimeout(timeout)
      this.activeRequests -= 1
      this.stats.active = this.activeRequests
      this.stats.errors += 1
      this.writeJSON(response, 500, { error: { message: String(error?.message ?? error), type: 'provider_error' } })
      return
    }

    try {
      if (stream) await this.writeStream(response, chunks, { model: wireModel, includeUsage })
      else await this.writeCompletion(response, chunks, { model: wireModel })
    } finally {
      clearTimeout(timeout)
      this.activeRequests -= 1
      this.stats.active = this.activeRequests
    }
  }

  /**
   * Translate an OpenAI Chat Completions request into `ctx.llm.stream()` options.
   *
   * Tool definitions, tool-call history and tool results are mapped onto DSH's
   * content blocks so a tool-using client (opencode) sees real tool calls rather
   * than text.  Inline `data:` images are admitted into the durable attachment
   * store first, because a DSH `ImageBlock` carries an attachment reference
   * rather than bytes.
   */
  async toLLMOptions(body, resolved, signal, requestId) {
    if (!Array.isArray(body.messages)) {
      const error = new Error('"messages" must be an array')
      error.code = 'invalid_messages'
      throw error
    }
    if (body.messages.length === 0) {
      const error = new Error('"messages" must not be empty')
      error.code = 'invalid_messages'
      throw error
    }

    const messages = []
    let system
    for (const [position, entry] of body.messages.entries()) {
      if (entry === null || typeof entry !== 'object') {
        const error = new Error(`messages[${position}] must be an object`)
        error.code = 'invalid_messages'
        throw error
      }
      const content = toContentBlocks(entry.content, `messages[${position}].content`)
      if (entry.role === 'system' || entry.role === 'developer') {
        const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
        system = system === undefined ? text : `${system}\n\n${text}`
        continue
      }
      if (entry.role === 'user') {
        messages.push({ role: 'user', content: await this.admitImages(content) })
        continue
      }
      if (entry.role === 'assistant') {
        const blocks = [...content]
        for (const [callIndex, call] of (Array.isArray(entry.tool_calls) ? entry.tool_calls : []).entries()) {
          if (call?.function?.name === undefined) {
            const error = new Error(`messages[${position}].tool_calls[${callIndex}].function.name is required`)
            error.code = 'invalid_messages'
            throw error
          }
          blocks.push({
            type: 'tool-call',
            id: call.id ?? `call_${position}_${callIndex}`,
            name: call.function.name,
            arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
          })
        }
        if (blocks.length === 0) continue
        // DSH's `llm` layer dereferences `source` on every assistant message
        // (`forAdapter` strips replay state per adapter), so a bare
        // `{role:'assistant'}` crashes the next turn. The route that produced the
        // historical text is not known here, and no replay state is being
        // replayed, so an explicit model-sourced message without `replayState` is
        // the honest shape.
        messages.push({
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: resolved.provider, model: resolved.model },
        })
        continue
      }
      if (entry.role === 'tool') {
        if (typeof entry.tool_call_id !== 'string' || entry.tool_call_id.length === 0) {
          const error = new Error(`messages[${position}].tool_call_id is required for tool results`)
          error.code = 'invalid_messages'
          throw error
        }
        messages.push({
          role: 'tool',
          source: { kind: 'tool', callId: entry.tool_call_id },
          toolCallId: entry.tool_call_id,
          content,
          isError: entry.is_error === true,
        })
        continue
      }
      const error = new Error(`messages[${position}].role "${String(entry.role)}" is not supported`)
      error.code = 'invalid_messages'
      throw error
    }

    const tools = Array.isArray(body.tools) && body.tools.length > 0
      ? body.tools.map((tool, position) => {
          if (tool?.function?.name === undefined) {
            const error = new Error(`tools[${position}].function.name is required`)
            error.code = 'invalid_tools'
            throw error
          }
          return {
            name: tool.function.name,
            ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
            parameters: tool.function.parameters ?? { type: 'object', properties: {} },
          }
        })
      : undefined

    const options = {
      provider: resolved.provider,
      model: resolved.model ?? body.model,
      messages,
      signal,
      ...(system === undefined ? {} : { system }),
      ...(body.max_completion_tokens !== undefined ? { maxTokens: body.max_completion_tokens }
        : body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(body.stop === undefined ? {} : { stop: typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined }),
      ...(tools === undefined ? {} : { tools }),
      ...(typeof body.reasoning_effort === 'string' ? { reasoningEffort: body.reasoning_effort } : {}),
      sessionId: typeof body.user === 'string' ? body.user : requestId,
    }
    if (options.stop === undefined) delete options.stop
    return options
  }

  /**
   * Turn `image-data` blocks into durable DSH `image` blocks.
   *
   * Without an attachment store an inline image cannot become a real block, so
   * it degrades to text naming the image rather than failing the whole request:
   * a client should never lose a turn because a deployment lacked a feature.
   */
  async admitImages(content) {
    const images = content.filter((block) => block.type === 'image-data')
    if (images.length === 0) return content
    const attachments = this.options.attachments
    if (attachments === undefined || typeof attachments.saveImages !== 'function') {
      this.log.trace?.('export-image-degraded', { count: images.length, reason: 'no attachment store' })
      return content.map((block) => block.type === 'image-data'
        ? { type: 'text', text: `[image ${block.mediaType}, ${Buffer.from(block.data, 'base64').byteLength} bytes: not forwarded because no attachment store is mounted]` }
        : block)
    }
    const refs = await attachments.saveImages(images.map((block) => ({
      data: Buffer.from(block.data, 'base64'),
      mediaType: block.mediaType,
    })))
    let next = 0
    this.log.trace?.('export-images-admitted', { count: refs.length })
    return content.map((block) => block.type === 'image-data'
      ? { type: 'image', attachment: refs[next++] }
      : block)
  }

  async writeStream(response, chunks, { model, includeUsage }) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Flush headers immediately so the client's header timeout stops ticking.
    response.flushHeaders?.()
    this.stats.streams += 1

    const writer = new FrameWriter(response, this)
    const keepAlive = this.config.sse.keepAliveMs > 0
      ? setInterval(() => writer.comment('keep-alive'), this.config.sse.keepAliveMs)
      : undefined
    keepAlive?.unref?.()

    let roleSent = false
    const reasoningField = 'reasoning_content'
    let usage
    let finishKind = 'stop'
    let sawContent = false
    const toolPositions = new Map()
    let nextToolPosition = 0
    const envelope = (delta, finishReason) => ({
      id: writer.id,
      object: 'chat.completion.chunk',
      created: writer.created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    })

    try {
      for await (const chunk of chunks) {
        if (chunk?.type === 'finish') {
          finishKind = chunk.reason?.kind ?? 'stop'
          if (finishKind === 'error') {
            const failure = chunk.reason.failure ?? {}
            throw Object.assign(new Error(failure.message ?? 'model call failed'), { code: failure.code ?? 'PROVIDER_ERROR' })
          }
          if (finishKind === 'aborted') {
            const failure = chunk.reason.failure ?? {}
            throw Object.assign(new Error(failure.message ?? 'model call aborted'), { code: failure.code ?? 'ABORTED', aborted: true })
          }
          break
        }
        if (chunk?.type === 'usage') {
          usage = chunk.usage
          continue
        }
        if (!roleSent) {
          roleSent = true
          await writer.frame(envelope({ role: 'assistant', content: '' }))
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          sawContent = true
          await writer.frame(envelope({ content: chunk.text }))
          continue
        }
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          sawContent = true
          await writer.frame(envelope({ [reasoningField]: chunk.text }))
          continue
        }
        if (chunk?.type === 'tool-call-delta') {
          sawContent = true
          if (!toolPositions.has(chunk.index)) toolPositions.set(chunk.index, nextToolPosition++)
          const call = { index: toolPositions.get(chunk.index), type: 'function', function: {} }
          if (chunk.id !== undefined) call.id = chunk.id
          if (typeof chunk.name === 'string' && chunk.name.length > 0) call.function.name = chunk.name
          if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) call.function.arguments = chunk.argumentsDelta
          await writer.frame(envelope({ tool_calls: [call] }))
          continue
        }
      }

      if (!roleSent) await writer.frame(envelope({ role: 'assistant', content: '' }))
      await writer.frame(envelope({}, finishReasonFromDSH({ kind: finishKind })))
      void sawContent

      const wireUsage = includeUsage ? usageToWireUsage(usage) : undefined
      if (wireUsage !== undefined) {
        await writer.frame({
          id: writer.id,
          object: 'chat.completion.chunk',
          created: writer.created,
          model,
          choices: [],
          usage: wireUsage,
        })
      }
      writer.raw('data: [DONE]\n\n')
      await writer.end()
    } catch (error) {
      this.stats.errors += 1
      clearInterval(keepAlive)
      if (writer.closed) {
        this.log.trace?.('export-client-gone', { message: String(error?.message ?? error) })
        return
      }
      const aborted = error?.aborted === true || error?.code === 'ABORTED'
      const payload = {
        error: {
          message: String(error?.message ?? error),
          type: aborted ? 'aborted' : 'provider_error',
          code: error?.code ?? 'PROVIDER_ERROR',
        },
      }
      if (error?.code === 'CLIENT_DISCONNECT' || response.destroyed) {
        this.log.trace?.('export-client-disconnect', { message: payload.error.message })
        return
      }
      // The headers are already out, so the only in-band way to report a failure
      // is an SSE error frame the client's parser can surface, followed by [DONE].
      try {
        writer.raw(sseFrame(JSON.stringify(payload)))
        writer.raw('data: [DONE]\n\n')
        await writer.end()
      } catch {}
      this.log.trace?.('export-stream-error', payload.error)
      return
    }
    if (keepAlive !== undefined) clearInterval(keepAlive)
  }

  async writeCompletion(response, chunks, { model }) {
    const text = []
    const reasoning = []
    const calls = []
    let usage
    let finishKind = 'stop'
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta') text.push(chunk.text)
      else if (chunk?.type === 'reasoning-delta') reasoning.push(chunk.text)
      else if (chunk?.type === 'tool-call-delta') {
        const slot = (calls[chunk.index] ??= { id: chunk.id, name: '', arguments: '' })
        if (typeof chunk.id === 'string' && chunk.id.length > 0) slot.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name.length > 0) slot.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') slot.arguments += chunk.argumentsDelta
      } else if (chunk?.type === 'usage') usage = chunk.usage
      else if (chunk?.type === 'finish') {
        finishKind = chunk.reason?.kind ?? 'stop'
        if (finishKind === 'error' || finishKind === 'aborted') {
          const failure = chunk.reason?.failure ?? {}
          throw Object.assign(new Error(failure.message ?? 'model call failed'), { code: failure.code ?? 'PROVIDER_ERROR' })
        }
      }
    }

    const message = { role: 'assistant', content: text.length > 0 ? text.join('') : null }
    const joinedReasoning = reasoning.join('')
    if (joinedReasoning.length > 0) message.reasoning_content = joinedReasoning
    const toolCalls = calls.filter(Boolean).map((call, position) => ({
      id: call.id ?? `call_${position}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
    }))
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
      if (message.content === null) delete message.content
    }
    const wireUsage = usageToWireUsage(usage)
    this.writeJSON(response, 200, {
      id: `chatcmpl-${Math.random().toString(36).slice(2, 14)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishKind === 'tool-calls' ? 'tool_calls' : finishKind === 'max-tokens' ? 'length' : 'stop',
      }],
      ...(wireUsage === undefined ? {} : { usage: wireUsage }),
    })
  }
}

/**
 * One SSE response writer with byte accounting, backpressure and idempotent end.
 *
 * Node's `response.write()` returns false when the socket buffer is full; an SSE
 * producer must await `drain` or a slow client turns into unbounded memory.
 */
class FrameWriter {
  constructor(response, server) {
    this.response = response
    this.server = server
    this.closed = false
    this.id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
    this.created = Math.floor(Date.now() / 1000)
    response.once('close', () => { this.closed = true })
    response.on('error', () => { this.closed = true })
  }

  raw(text) {
    if (this.closed) return
    this.server.stats.bytes += Buffer.byteLength(text)
    this.response.write(text)
  }

  frame(payload) {
    return this.write(sseFrame(JSON.stringify(payload)))
  }

  comment(text) {
    return this.write(sseComment(text))
  }

  write(text) {
    if (this.closed) return Promise.resolve()
    this.server.stats.bytes += Buffer.byteLength(text)
    if (this.response.write(text)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        this.response.removeListener('drain', done)
        this.response.removeListener('close', done)
        resolve()
      }
      this.response.once('drain', done)
      this.response.once('close', done)
    })
  }

  end() {
    if (this.closed) return Promise.resolve()
    this.closed = true
    return new Promise((resolve) => {
      this.response.end(() => resolve())
      setTimeout(resolve, 1_000).unref?.()
    })
  }
}

const SUPPORTED_IMAGE_PREFIXES = ['data:image/']

function toContentBlocks(content, field) {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    const error = new Error(`${field} must be a string, an array of parts, or null`)
    error.code = 'invalid_content'
    throw error
  }
  const blocks = []
  for (const [position, part] of content.entries()) {
    if (part === null || typeof part !== 'object') {
      const error = new Error(`${field}[${position}] must be an object`)
      error.code = 'invalid_content'
      throw error
    }
    if (part.type === 'text' || part.type === 'input_text') {
      if (typeof part.text !== 'string') {
        const error = new Error(`${field}[${position}].text must be a string`)
        error.code = 'invalid_content'
        throw error
      }
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url !== 'string') {
        const error = new Error(`${field}[${position}].image_url.url must be a string`)
        error.code = 'invalid_content'
        throw error
      }
      // Remote images cannot be turned into a DSH attachment without a fetch and
      // a durable store, so only data: URLs become real image blocks; anything
      // else is preserved as text so the model still learns what was attached.
      if (!SUPPORTED_IMAGE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        blocks.push({ type: 'text', text: `[image: ${url.slice(0, 2_000)}]` })
        continue
      }
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
      if (match === null) {
        blocks.push({ type: 'text', text: '[image: unsupported data URL encoding]' })
        continue
      }
      blocks.push({
        type: 'image-data',
        mediaType: match[1],
        data: match[2],
      })
      continue
    }
    const error = new Error(`${field}[${position}].type "${String(part.type)}" is not supported`)
    error.code = 'invalid_content'
    throw error
  }
  return blocks
}

function usageToWireUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : undefined
  const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : undefined
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const promptTokens = (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const completionTokens = outputTokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cacheRead === undefined ? {} : { prompt_tokens_details: { cached_tokens: cacheRead } }),
    ...(Number.isFinite(usage.reasoningTokens) ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  }
}

/**
 * Accept every shape a model route can produce for a stream.
 *
 * DSH adapters yield an async generator, some wrappers resolve to one, and a
 * cached or fixture route may hold a plain array.  Anything else is a
 * programming error worth naming precisely.
 */
function toAsyncIterable(value) {
  if (value === undefined || value === null) {
    throw Object.assign(new Error('the model route produced no stream'), { code: 'NO_STREAM' })
  }
  if (typeof value[Symbol.asyncIterator] === 'function') return value
  if (typeof value[Symbol.iterator] === 'function' || Array.isArray(value)) {
    return (async function* fromArray() { yield* value })()
  }
  throw Object.assign(new Error(`the model route produced a ${typeof value} instead of a stream`), { code: 'NO_STREAM' })
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index]
  return diff === 0
}

export { MAX_ERROR_BODY, usageToWireUsage }
