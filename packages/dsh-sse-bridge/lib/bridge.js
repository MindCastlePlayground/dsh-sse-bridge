// Bridge runtime: owns both directions and the model catalogue they share.
//
// The import adapter registers with DSH's `llm` service; the export server calls
// `llm.stream()` for each request an external client makes.  Keeping the two in
// one runtime is what lets an exported model be an imported upstream, a
// first-party DSH route, or any other adapter-mounted provider.

import { createImportAdapter } from './import-adapter.js'
import { SseExportServer } from './export-server.js'
import { parseSSE } from './sse.js'

export class SseBridge {
  /**
   * @param {{ config: import('./config.js').normalizeConfig extends never ? never : object, ctx: object, log: object }} options
   */
  constructor({ config, ctx, log }) {
    this.config = config
    this.ctx = ctx
    this.log = log ?? {}
    this.importAdapter = undefined
    this.importHandle = undefined
    this.importError = undefined
    this.exporter = undefined
    this.exportError = undefined
    this.registered = false
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start() {
    if (this.config.import !== null) this.startImport()
    if (this.config.export !== null && this.config.export.enabled) await this.startExport()
    return this
  }

  startImport() {
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      this.importError = 'the llm service is unavailable; the imported route cannot be registered'
      this.log.warn?.(`[sse-bridge:import] ${this.importError}`)
      return
    }
    try {
      this.importAdapter = createImportAdapter({
        config: this.config.import,
        ctx: this.ctx,
        log: this.log,
      })
      this.importHandle = llm.registerAdapter([this.config.import.route], this.importAdapter)
      this.registered = true
      this.log.info?.(`[sse-bridge:import] registered model route "${this.config.import.route}" -> ${this.config.import.baseURL}`)
    } catch (error) {
      this.importError = String(error?.message ?? error)
      this.log.error?.(`[sse-bridge:import] cannot register route "${this.config.import.route}": ${this.importError}`)
    }
  }

  async startExport() {
    try {
      this.exporter = new SseExportServer({
        config: this.config.export,
        log: this.log,
        attachments: this.ctx.get('attachments'),
        listModels: () => this.listExportedModels(),
        resolveRoute: (modelId) => this.resolveRoute(modelId),
        stream: (options) => this.streamModel(options),
      })
      await this.exporter.start()
    } catch (error) {
      this.exportError = String(error?.message ?? error)
      this.log.error?.(`[sse-bridge:export] cannot start the SSE server: ${this.exportError}`)
      this.exporter = undefined
    }
  }

  async stop() {
    if (this.exporter !== undefined) {
      try { await this.exporter.stop() } catch (error) {
        this.log.warn?.(`[sse-bridge:export] stop failed: ${String(error?.message ?? error)}`)
      }
      this.exporter = undefined
    }
    if (this.importHandle !== undefined) {
      try { this.importHandle() } catch {}
      this.importHandle = undefined
      this.registered = false
    }
    this.importAdapter = undefined
  }

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------

  /**
   * Every model this bridge offers to external clients.
   *
   * `catalog` mode mirrors DSH's own providers, so an external client can reach
   * whatever the user already configured (including first-party routes);
   * `static` mode pins an explicit list with its own ids and metadata.
   */
  async listExportedModels() {
    const config = this.config.export
    if (config === null) return []
    if (config.modelSource === 'static') {
      return config.models.map((model) => ({
        id: model.id,
        provider: this.config.import?.route ?? 'dsh',
        model: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ownedBy: 'dsh-sse-bridge',
      }))
    }

    const llm = this.ctx.get('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return []
    const allowed = config.includeRoutes
    const providers = llm.listProviders()
    const models = []
    for (const provider of providers) {
      const route = typeof provider === 'string' ? provider : provider?.id
      if (typeof route !== 'string') continue
      if (allowed.length > 0 && !allowed.includes(route)) continue
      let catalog = []
      try {
        catalog = await llm.listModels(route)
      } catch (error) {
        this.log.trace?.('export-catalog-skip', { provider: route, message: String(error?.message ?? error) })
        continue
      }
      for (const model of catalog) {
        models.push({
          id: this.exportedId(route, model.id),
          provider: route,
          model: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          contextWindow: model.context?.contextWindow,
          maxTokens: model.defaultMaxTokens,
          ownedBy: route,
        })
      }
    }
    return models
  }

  /**
   * The id an external client uses for a DSH model.
   *
   * opencode and the OpenAI SDKs key models by a single string, so a route and a
   * model id are joined with `::`.  A single imported route keeps bare model ids
   * so the common one-upstream case reads naturally.
   */
  exportedId(route, model) {
    if (this.config.export?.modelSource === 'static') return model
    if (this.config.import !== null && route === this.config.import.route) return model
    return `${route}::${model}`
  }

  async resolveRoute(modelId) {
    const config = this.config.export
    if (config === null) return undefined
    if (config.modelSource === 'static') {
      const known = config.models.find((model) => model.id === modelId)
      if (known === undefined) {
        for (const candidate of await this.listExportedModels()) {
          if (candidate.id === modelId || candidate.model === modelId) {
            return { provider: candidate.provider, model: candidate.model }
          }
        }
        return undefined
      }
      return { provider: this.config.import?.route ?? 'dsh', model: known.id }
    }

    const models = await this.listExportedModels()
    const exact = models.find((model) => model.id === modelId)
    if (exact !== undefined) return { provider: exact.provider, model: exact.model }

    // A bare model id is a common client shorthand; accept it when unambiguous.
    const byModel = models.filter((model) => model.model === modelId)
    if (byModel.length === 1) return { provider: byModel[0].provider, model: byModel[0].model }
    if (byModel.length > 1) {
      this.log.warn?.(`[sse-bridge:export] model id "${modelId}" is ambiguous across ${byModel.length} routes; use "<route>::<model>"`)
      return undefined
    }
    // An unlisted but syntactically explicit route::model pair still routes;
    // DSH accepts unlisted model ids, so a bridge should not be stricter.
    const separator = modelId.indexOf('::')
    if (separator > 0) {
      return { provider: modelId.slice(0, separator), model: modelId.slice(separator + 2) }
    }
    return undefined
  }

  streamModel(options) {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('the llm service is unavailable; no model can be streamed')
    return llm.stream(options)
  }

  // -------------------------------------------------------------------------
  // Status and self-test
  // -------------------------------------------------------------------------

  status() {
    const incoming = this.config.import
    const outgoing = this.config.export
    const credentialConfigured = incoming === null
      ? false
      : incoming.apiKey !== undefined || (incoming.apiKeyEnv !== undefined && (process.env[incoming.apiKeyEnv] ?? '').length > 0)

    return {
      ok: (incoming === null || this.registered) && (outgoing === null || this.exporter !== undefined),
      ...(incoming === null ? {} : {
        import: {
          route: incoming.route,
          displayName: incoming.displayName,
          baseURL: incoming.baseURL,
          dialect: incoming.dialect,
          modelCount: incoming.models.length,
          credentialConfigured,
          registered: this.registered,
          ...(this.importError === undefined ? {} : { error: this.importError }),
        },
      }),
      ...(outgoing === null ? {} : {
        export: {
          running: this.exporter !== undefined,
          ...(this.exporter === undefined ? {} : { origin: this.exporter.origin }),
          host: outgoing.host,
          port: this.exporter?.port ?? outgoing.port,
          basePath: outgoing.basePath,
          modelSource: outgoing.modelSource,
          authRequired: outgoing.auth.apiKey !== undefined || outgoing.auth.apiKeyEnv !== undefined,
          activeRequests: this.exporter?.activeRequests ?? 0,
          requests: this.exporter?.stats.requests ?? 0,
          streams: this.exporter?.stats.streams ?? 0,
          errors: this.exporter?.stats.errors ?? 0,
          bytes: this.exporter?.stats.bytes ?? 0,
          uptimeMs: this.exporter === undefined ? 0 : Date.now() - this.exporter.stats.started,
          ...(this.exportError === undefined ? {} : { error: this.exportError }),
        },
      }),
    }
  }

  /**
   * Drive one real request through the export listener.
   *
   * The self-test deliberately uses HTTP against the listening socket instead of
   * calling the internals, so it exercises exactly what an external client does:
   * routing, auth bypass for loopback, SSE framing, and DSH streaming.
   */
  async selftest({ model, prompt } = {}) {
    if (this.exporter === undefined) {
      return { ok: false, error: this.exportError ?? 'the export server is not running' }
    }
    const requested = model ?? this.config.export.defaultModel ?? (await this.listExportedModels())[0]?.id
    if (requested === undefined) {
      return { ok: false, error: 'no exported model is available to test' }
    }
    const resolved = await this.resolveRoute(requested)
    if (resolved === undefined) {
      return { ok: false, model: requested, error: `model "${requested}" is not served by this bridge` }
    }

    const url = `${this.exporter.origin}/chat/completions`
    const started = Date.now()
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
    const key = this.config.export.auth.apiKey
      ?? (this.config.export.auth.apiKeyEnv === undefined ? undefined : process.env[this.config.export.auth.apiKeyEnv])
    if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('selftest timeout')), 120_000)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: requested,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: prompt ?? 'Reply with exactly: bridge ok' }],
        }),
      })
      if (!response.ok) {
        const text = await response.text()
        return { ok: false, model: requested, url, error: `HTTP ${response.status}: ${text.slice(0, 500)}` }
      }

      const text = []
      const reasoning = []
      let finishReason = 'unknown'
      let frames = 0
      let toolCalls = 0
      let usage
      for await (const event of parseSSE(response.body, { signal: controller.signal })) {
        if (event.data === '[DONE]') break
        let payload
        try { payload = JSON.parse(event.data) } catch { continue }
        frames += 1
        if (payload.error !== undefined) {
          return { ok: false, model: requested, url, frames, error: payload.error.message ?? JSON.stringify(payload.error) }
        }
        if (payload.usage !== undefined) usage = payload.usage
        const choice = payload.choices?.[0]
        if (choice === undefined) continue
        if (typeof choice.delta?.content === 'string') text.push(choice.delta.content)
        if (typeof choice.delta?.reasoning_content === 'string') reasoning.push(choice.delta.reasoning_content)
        if (Array.isArray(choice.delta?.tool_calls)) toolCalls += choice.delta.tool_calls.length
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      }

      const assembled = text.join('')
      return {
        ok: assembled.length > 0 || toolCalls > 0,
        model: requested,
        route: `${resolved.provider}/${resolved.model}`,
        url,
        text: assembled,
        ...(reasoning.length === 0 ? {} : { reasoning: reasoning.join('') }),
        finishReason,
        frames,
        toolCalls,
        ...(usage === undefined ? {} : { usage: `${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'}=${usage.total_tokens ?? '?'}` }),
        elapsedMs: Date.now() - started,
        ...(assembled.length === 0 && toolCalls === 0 ? { error: 'the stream carried no text and no tool calls' } : {}),
      }
    } catch (error) {
      return { ok: false, model: requested, url, error: String(error?.message ?? error), elapsedMs: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }
}
