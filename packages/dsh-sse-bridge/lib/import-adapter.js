// Import direction: an external SSE upstream becomes a DSH model route.
//
// The adapter speaks the OpenAI Chat Completions dialect (and an Anthropic
// Messages dialect, because several SSE-capable upstreams only offer that) and
// translates into DSH `StreamChunk`s.  It is a plain object rather than a
// subclass: the installed LlmRuntime validates adapters by duck typing, and this
// package must not import @deepseek-ai/* from a profile-local install.

import { randomUUID } from 'node:crypto'
import { parseSSE } from './sse.js'

const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_TOKENS = 8_192

export function bridgeError(message, code, { status, providerRetryAfterMs, requestId, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  error.failure = {
    message,
    code,
    ...(status === undefined ? {} : { status }),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  }
  return error
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

export function joinURL(baseURL, suffix) {
  if (suffix === undefined || suffix === '') return baseURL
  const base = baseURL.replace(/\/+$/, '')
  if (base.endsWith(suffix)) return base
  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call')
}

// ---------------------------------------------------------------------------
// DSH request -> OpenAI Chat Completions request
// ---------------------------------------------------------------------------

export async function buildOpenAIMessages(options, { imageDataURL } = {}) {
  const messages = []
  const systemParts = []
  if (typeof options.system === 'string' && options.system.length > 0) systemParts.push(options.system)

  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOfContent(message.content)
      if (text.length > 0) systemParts.push(text)
    }
  }
  if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })

  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue

    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: message.content })
        continue
      }
      const parts = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
        } else if (block?.type === 'image' && block.attachment !== undefined) {
          const dataURL = await imageDataURL?.({ ...block.attachment, offloaded: block.offloaded })
          if (dataURL === undefined) parts.push({ type: 'text', text: `[image ${block.attachment.name ?? block.attachment.attachmentId} unavailable to this upstream]` })
          else parts.push({ type: 'image_url', image_url: { url: dataURL } })
        } else if (block?.type === 'file' && block.file !== undefined) {
          // DSH projects file references into handle text before dispatch, so a
          // raw FileBlock here means the caller handed us one directly.
          parts.push({ type: 'text', text: `[file ${block.file.name ?? 'attachment'}]` })
        }
      }
      // A caller that sent only images must not produce an empty content array,
      // which several upstreams reject outright.
      if (parts.length === 0) parts.push({ type: 'text', text: '' })
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
      continue
    }

    if (message.role === 'assistant') {
      const text = textOfContent(message.content)
      const calls = toolCallsOf(message.content)
      if (text.length === 0 && calls.length === 0) continue
      const entry = { role: 'assistant', content: text.length > 0 ? text : null }
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: String(call.id),
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        }))
      }
      messages.push(entry)
      continue
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
        content: textOfContent(message.content),
      })
    }
  }
  return messages
}

export function buildOpenAIBody(provider, options, messages) {
  const known = provider.models.find((entry) => entry.id === options.model)
  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...provider.extraBody,
  }
  if (options.maxTokens !== undefined) body[provider.maxTokensField] = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
  }
  if (options.reasoningEffort !== undefined) {
    const mapped = known?.reasoningEfforts?.[options.reasoningEffort] ?? options.reasoningEffort
    body.reasoning_effort = mapped
  }
  return body
}

/** DSH request -> Anthropic Messages request, for SSE upstreams that speak it. */
export function buildAnthropicBody(provider, options, messages) {
  const known = provider.models.find((entry) => entry.id === options.model)
  const system = messages.filter((entry) => entry.role === 'system').map((entry) => entry.content).join('\n\n')
  const converted = []
  for (const entry of messages) {
    if (entry.role === 'system') continue
    if (entry.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: entry.tool_call_id, content: entry.content }],
      })
      continue
    }
    if (entry.role === 'assistant') {
      const blocks = []
      if (typeof entry.content === 'string' && entry.content.length > 0) blocks.push({ type: 'text', text: entry.content })
      for (const call of entry.tool_calls ?? []) {
        let input = {}
        try { input = JSON.parse(call.function.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
      if (blocks.length > 0) converted.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks = []
    if (typeof entry.content === 'string') blocks.push({ type: 'text', text: entry.content })
    else {
      for (const part of entry.content ?? []) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
        else if (part.type === 'image_url') {
          const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url)
          if (match !== null) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
          }
        }
      }
    }
    converted.push({ role: 'user', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks })
  }

  const body = {
    model: options.model,
    messages: converted,
    stream: true,
    max_tokens: options.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...provider.extraBody,
  }
  if (system.length > 0) body.system = system
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop_sequences = options.stop
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  return body
}

// ---------------------------------------------------------------------------
// Upstream response -> DSH StreamChunk
// ---------------------------------------------------------------------------

function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const details = raw.prompt_tokens_details ?? {}
  const completionDetails = raw.completion_tokens_details ?? {}
  const cacheReadTokens = Number.isFinite(details.cached_tokens) && details.cached_tokens >= 0 ? details.cached_tokens : undefined
  const aggregatePrompt = Number.isFinite(raw.prompt_tokens) ? raw.prompt_tokens
    : Number.isFinite(raw.input_tokens) ? raw.input_tokens : undefined
  const outputTokens = Number.isFinite(raw.completion_tokens) ? raw.completion_tokens
    : Number.isFinite(raw.output_tokens) ? raw.output_tokens : undefined
  // DSH token counts are disjoint: inputTokens is uncached input only.
  const inputTokens = aggregatePrompt === undefined ? undefined
    : cacheReadTokens === undefined ? aggregatePrompt
      : Math.max(0, aggregatePrompt - cacheReadTokens)
  const totalTokens = Number.isFinite(raw.total_tokens) ? raw.total_tokens
    : inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens + (cacheReadTokens ?? 0)
      : undefined
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cacheReadTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(Number.isFinite(completionDetails.reasoning_tokens) ? { reasoningTokens: completionDetails.reasoning_tokens } : {}),
  }
}

function mergeUsage(previous, next) {
  if (next === undefined) return previous
  if (previous === undefined) return next
  const merged = { ...previous, ...next }
  if (merged.inputTokens !== undefined && merged.outputTokens !== undefined) {
    merged.totalTokens = next.totalTokens ?? merged.inputTokens + merged.outputTokens + (merged.cacheReadTokens ?? 0)
  } else if (next.totalTokens === undefined) {
    delete merged.totalTokens
  }
  return merged
}

function finishReasonFrom(wire, sawToolCall) {
  switch (wire) {
    case 'length':
    case 'max_tokens':
      // An explicit output cap wins over tool deltas: the arguments may be
      // incomplete and must not reach the executor as a finished call.
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'stop':
    case 'end_turn':
    case 'content_filter':
    case 'stop_sequence':
      return { kind: 'stop' }
    default:
      break
  }
  return sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
}

function retryAfterMs(value) {
  if (value === null || value === undefined) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return Math.max(1, Math.round(Number(value) * 1_000))
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.max(1, at - Date.now())
}

function mapHTTPError(status, body, headers) {
  const detail = body.slice(0, 2_000)
  let message = detail
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error?.message ?? parsed?.message ?? detail
  } catch {}
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT'
      : status === 408 || status === 504 ? 'TIMEOUT'
        : status >= 500 ? 'SERVER'
          : status === 400 || status === 422 ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  return bridgeError(`upstream HTTP ${status}: ${String(message || 'request failed').trim()}`, code, {
    status,
    providerRetryAfterMs: retryAfterMs(headers?.get?.('retry-after')),
    requestId: headers?.get?.('x-request-id') ?? headers?.get?.('request-id') ?? undefined,
  })
}

async function readBodyLimited(response, signal, maxBytes = 8_192) {
  let reader
  try {
    reader = response.body?.getReader()
    if (reader === undefined) return ''
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    try { await reader.cancel() } catch {}
    return text.slice(0, maxBytes)
  } catch (error) {
    if (signal?.aborted) throw error
    try { await reader?.cancel() } catch {}
    return ''
  }
}

/**
 * Create the DSH adapter for one imported SSE upstream.
 *
 * @param {{ config: object, ctx: object, log: object }} input
 */
export function createImportAdapter({ config, ctx, log }) {
  const provider = config

  function providerInfo() {
    return { id: provider.route, name: provider.displayName }
  }

  function providerRetryPolicy() {
    return undefined
  }

  function imageRequestPricing() {
    return undefined
  }

  function imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  function modelConfig(model) {
    return provider.models.find((entry) => entry.id === model)
  }

  function resolveModel(providerName, model, signal) {
    // `resolveModel` is the one synchronous-looking lookup LlmRuntime may call
    // with a cancellation signal, so an already-aborted request must reject
    // rather than resolve metadata nobody will use.
    if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error('aborted'), { code: 'ABORTED' }))
    const known = modelConfig(model)
    if (known === undefined) {
      return Promise.resolve({
        provider: providerName,
        id: model,
        name: model,
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        inputModalities: ['text'],
      })
    }
    return Promise.resolve({
      provider: providerName,
      id: model,
      name: known.name,
      ...(known.description === undefined ? {} : { description: known.description }),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      inputModalities: known.input,
      ...(known.reasoningEfforts === false || known.reasoningEfforts === undefined ? {} : {
        reasoning: {
          efforts: Object.keys(known.reasoningEfforts).map((id) => ({ id, name: id })),
          ...(known.defaultReasoningEffort === undefined ? {} : { defaultEffort: known.defaultReasoningEffort }),
        },
      }),
    })
  }

  async function listModels() {
    const configured = provider.models.map((entry) => ({
      provider: provider.route,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.input,
    }))
    if (configured.length > 0 || !provider.discoverModels) return configured

    const url = provider.modelsURL ?? joinURL(provider.baseURL, '/models')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('model list timeout')), provider.modelListTimeoutMs)
    try {
      const headers = await authHeaders({}, controller.signal)
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
      const models = []
      for (const item of data) {
        const id = typeof item?.id === 'string' ? item.id : undefined
        if (id === undefined || id.length === 0) continue
        models.push({ provider: provider.route, id, name: typeof item.name === 'string' ? item.name : id })
      }
      log?.trace?.('models-discovered', { url, count: models.length })
      return models
    } catch (error) {
      log?.trace?.('models-discovery-failed', { url, message: String(error?.message ?? error) })
      return configured
    } finally {
      clearTimeout(timer)
    }
  }

  async function resolveCredential(_options, _signal) {
    if (provider.apiKey === undefined || provider.apiKey.length === 0) {
      if (provider.apiKeyEnv === undefined) return undefined
      const value = process.env[provider.apiKeyEnv]
      if (value === undefined || value.trim() === '') {
        throw bridgeError(`import "${provider.route}" requires credential ${provider.apiKeyEnv}, but it is not set`, 'MISSING_CREDENTIAL')
      }
      return value.trim()
    }
    return provider.apiKey
  }

  async function authHeaders(options, signal) {
    const headers = {
      'content-type': 'application/json',
      accept: options?.stream === false ? 'application/json' : 'text/event-stream',
      'user-agent': 'dsh-sse-bridge/0.1',
      ...provider.headers,
    }
    if (provider.dialect === 'anthropic') headers['anthropic-version'] ??= '2023-06-01'
    const credential = await resolveCredential(options, signal)
    if (credential !== undefined) {
      if (provider.dialect === 'anthropic') {
        if (headers['x-api-key'] === undefined && headers['X-Api-Key'] === undefined) headers['x-api-key'] = credential
      } else if (headers.Authorization === undefined && headers.authorization === undefined) {
        headers.Authorization = `Bearer ${credential}`
      }
    }
    if (provider.sessionHeader !== undefined && provider.sendSessionHeader && options?.sessionId !== undefined) {
      headers[provider.sessionHeader] = String(options.sessionId)
    }
    return headers
  }

  async function imageDataURL(attachment) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined || typeof attachments.readImageRequest !== 'function') return undefined
    const target = imageRequestTarget(provider.route, undefined, attachment)
    const image = await attachments.readImageRequest(attachment, target)
    const mediaType = image.mediaType ?? attachment.mediaType ?? 'image/png'
    return `data:${mediaType};base64,${Buffer.from(image.data).toString('base64')}`
  }

  function openBlock(state, chunks, blockType) {
    const index = state.nextBlock++
    state.blocks.set(index, { type: blockType, text: '', arguments: '' })
    chunks.push({ type: 'block-start', index, blockType })
    return index
  }

  function* closeBlocks(state) {
    for (const index of [...state.blocks.keys()].sort((left, right) => left - right)) {
      const entry = state.blocks.get(index)
      if (entry.type === 'tool-call') {
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.arguments },
        }
      } else {
        yield { type: 'block-end', index, block: { type: entry.type, text: entry.text } }
      }
    }
  }

  function newState() {
    return {
      nextBlock: 0,
      textIndex: -1,
      reasoningIndex: -1,
      tools: new Map(),
      blocks: new Map(),
      sawToolCall: false,
      sawContent: false,
      usage: undefined,
      finishReason: undefined,
      done: false,
    }
  }

  function emitOpenAIChunk(payload, state) {
    const chunks = []
    if (payload?.error !== undefined) {
      const message = payload.error?.message ?? JSON.stringify(payload.error)
      throw bridgeError(`upstream error: ${message}`, 'PROVIDER_ERROR', { requestId: payload.error?.request_id })
    }
    if (payload?.usage !== undefined) {
      const usage = normalizeUsage(payload.usage)
      if (usage !== undefined) state.usage = mergeUsage(state.usage, usage)
    }
    const choice = payload?.choices?.[0]
    if (choice === undefined) return chunks
    const delta = choice.delta ?? choice.message ?? {}

    const reasoning = provider.reasoningFields
      .map((field) => delta[field])
      .find((value) => typeof value === 'string' && value.length > 0)
    if (reasoning !== undefined) {
      if (state.reasoningIndex === -1) {
        state.reasoningIndex = openBlock(state, chunks, 'reasoning')
        state.textIndex = -1
      }
      state.blocks.get(state.reasoningIndex).text += reasoning
      state.sawContent = true
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning })
    }

    let text = ''
    if (typeof delta.content === 'string') text = delta.content
    else if (Array.isArray(delta.content)) {
      text = delta.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
    }
    if (text.length > 0) {
      if (state.textIndex === -1) {
        state.textIndex = openBlock(state, chunks, 'text')
        state.reasoningIndex = -1
      }
      state.blocks.get(state.textIndex).text += text
      state.sawContent = true
      chunks.push({ type: 'text-delta', index: state.textIndex, text })
    }

    for (const [position, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
      if (call === null || call === undefined) continue
      const key = Number.isInteger(call.index) ? call.index : position
      let tool = state.tools.get(key)
      if (tool === undefined) {
        const index = openBlock(state, chunks, 'tool-call')
        const entry = state.blocks.get(index)
        tool = {
          index,
          id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: typeof call.function?.name === 'string' ? call.function.name : '',
        }
        entry.id = tool.id
        entry.name = tool.name
        state.tools.set(key, tool)
      } else {
        if (typeof call.id === 'string' && call.id.length > 0) tool.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) tool.name = call.function.name
        const entry = state.blocks.get(tool.index)
        entry.id = tool.id
        entry.name = tool.name
      }
      const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
      state.blocks.get(tool.index).arguments += argumentsDelta
      state.sawToolCall = true
      state.sawContent = true
      chunks.push({
        type: 'tool-call-delta',
        index: tool.index,
        id: tool.id,
        ...(tool.name.length > 0 ? { name: tool.name } : {}),
        argumentsDelta,
      })
    }

    if (typeof choice.finish_reason === 'string') {
      const current = state.finishReason
      const truncated = current === 'length' || current === 'max_tokens'
      const incomingTruncated = choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens'
      if (incomingTruncated || !truncated) state.finishReason = choice.finish_reason
    }
    return chunks
  }

  /** Anthropic Messages SSE event -> DSH chunks. */
  function emitAnthropicEvent(event, payload, state) {
    const chunks = []
    const type = payload?.type ?? event
    switch (type) {
      case 'message_start': {
        const usage = normalizeUsage(payload?.message?.usage)
        if (usage !== undefined) state.usage = mergeUsage(state.usage, usage)
        return chunks
      }
      case 'content_block_start': {
        const block = payload?.content_block ?? {}
        if (block.type === 'tool_use') {
          const index = openBlock(state, chunks, 'tool-call')
          const entry = state.blocks.get(index)
          entry.id = typeof block.id === 'string' ? block.id : `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          entry.name = typeof block.name === 'string' ? block.name : ''
          state.tools.set(payload.index ?? state.tools.size, { index, id: entry.id, name: entry.name })
          state.sawToolCall = true
          state.sawContent = true
          chunks.push({ type: 'tool-call-delta', index, id: entry.id, name: entry.name, argumentsDelta: '' })
        } else if (block.type === 'thinking') {
          state.reasoningIndex = openBlock(state, chunks, 'reasoning')
          state.textIndex = -1
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          state.textIndex = openBlock(state, chunks, 'text')
          state.reasoningIndex = -1
          state.blocks.get(state.textIndex).text += block.text
          state.sawContent = true
          chunks.push({ type: 'text-delta', index: state.textIndex, text: block.text })
        }
        return chunks
      }
      case 'content_block_delta': {
        const delta = payload?.delta ?? {}
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          if (state.textIndex === -1) {
            state.textIndex = openBlock(state, chunks, 'text')
            state.reasoningIndex = -1
          }
          state.blocks.get(state.textIndex).text += delta.text
          state.sawContent = true
          chunks.push({ type: 'text-delta', index: state.textIndex, text: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          if (state.reasoningIndex === -1) {
            state.reasoningIndex = openBlock(state, chunks, 'reasoning')
            state.textIndex = -1
          }
          state.blocks.get(state.reasoningIndex).text += delta.thinking
          state.sawContent = true
          chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta.thinking })
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
          const tool = state.tools.get(payload.index ?? 0)
          if (tool !== undefined) {
            state.blocks.get(tool.index).arguments += delta.partial_json
            state.sawContent = true
            chunks.push({ type: 'tool-call-delta', index: tool.index, id: tool.id, argumentsDelta: delta.partial_json })
          }
        }
        return chunks
      }
      case 'message_delta': {
        const usage = normalizeUsage(payload?.usage)
        if (usage !== undefined) state.usage = mergeUsage(state.usage, usage)
        const stop = payload?.delta?.stop_reason
        if (typeof stop === 'string') state.finishReason = stop
        return chunks
      }
      case 'message_stop':
        state.done = true
        return chunks
      case 'error': {
        const message = payload?.error?.message ?? JSON.stringify(payload?.error ?? payload)
        throw bridgeError(`upstream error: ${message}`, 'PROVIDER_ERROR')
      }
      default:
        return chunks
    }
  }

  async function* stream(options) {
    const signal = options.signal
    // An already-cancelled request must not reach the network at all; the
    // terminal chunk is the caller's cancellation, not a transport failure.
    if (signal?.aborted) {
      throw bridgeError('upstream request aborted before dispatch', 'ABORTED', { cause: signal.reason })
    }

    const started = Date.now()
    const messages = await buildOpenAIMessages(options, { imageDataURL })
    const body = provider.dialect === 'anthropic'
      ? buildAnthropicBody(provider, options, messages)
      : buildOpenAIBody(provider, options, messages)
    const url = joinURL(provider.baseURL, provider.requestPath)

    let headers
    try {
      headers = await authHeaders(options, signal)
    } catch (error) {
      log?.trace?.('request-preflight-error', { url, message: String(error?.message ?? error) })
      throw error
    }
    if (provider.dialect === 'anthropic') {
      headers['anthropic-beta'] ??= 'interleaved-thinking-2025-05-14'
    }

    if (provider.trace !== 'off') {
      log?.trace?.('request', {
        url,
        dialect: provider.dialect,
        model: options.model,
        messageCount: messages.length,
        toolCount: body.tools?.length ?? 0,
      })
    }
    if (provider.trace === 'verbose') log?.trace?.('request-body', body)

    const controller = new AbortController()
    let abortedBy
    const onAbort = () => {
      abortedBy = 'caller'
      try { controller.abort(signal.reason ?? new Error('aborted')) } catch { controller.abort() }
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    const connectTimer = setTimeout(() => {
      abortedBy = 'timeout'
      controller.abort(new Error(`connect timeout after ${provider.connectTimeoutMs}ms`))
    }, provider.connectTimeoutMs)

    let idleTimer
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    const resetIdle = () => {
      clearIdle()
      idleTimer = setTimeout(() => {
        abortedBy = 'idle-timeout'
        controller.abort(new Error(`stream idle timeout after ${provider.streamIdleTimeoutMs}ms`))
      }, provider.streamIdleTimeoutMs)
      idleTimer.unref?.()
    }
    // Idle means "no bytes from upstream", not "no completed event": a keepalive
    // comment is real progress.  Disarm while the consumer holds the iterator
    // so consumer latency is not charged to the provider.
    const guarded = function* guarded(chunks) {
      for (const chunk of chunks) {
        clearIdle()
        yield chunk
        resetIdle()
      }
    }

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', onAbort)
      if (isAbortError(error) || controller.signal.aborted) {
        const timedOut = abortedBy === 'timeout' || abortedBy === 'idle-timeout'
        throw bridgeError(
          timedOut ? `upstream request timed out after ${provider.connectTimeoutMs}ms` : 'upstream request aborted',
          timedOut ? 'TIMEOUT' : 'ABORTED',
          { cause: error },
        )
      }
      log?.trace?.('transport-error', { url, message: String(error?.message ?? error), code: error?.code })
      throw bridgeError(`upstream transport error: ${String(error?.message ?? error)}`, 'TRANSPORT', { cause: error })
    }
    clearTimeout(connectTimer)
    resetIdle()

    const state = newState()
    let usageSent = false
    const usageChunk = () => {
      if (usageSent || state.usage === undefined) return []
      if (state.usage.inputTokens === undefined || state.usage.outputTokens === undefined) return []
      usageSent = true
      return [{ type: 'usage', usage: state.usage }]
    }

    try {
      if (!response.ok) {
        const text = await readBodyLimited(response, controller.signal)
        const error = mapHTTPError(response.status, text, response.headers)
        log?.trace?.('http-error', { status: response.status, code: error.code, message: error.message })
        throw error
      }
      log?.trace?.('response', {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        elapsedMs: Date.now() - started,
      })

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('application/json')) {
        // A non-streaming upstream (or an error envelope with 200) still has to
        // produce a full DSH stream: parse one completion and emit it once.
        const raw = await response.text()
        let payload
        try { payload = JSON.parse(raw) } catch {
          throw bridgeError(`upstream returned invalid JSON: ${raw.slice(0, 300)}`, 'INVALID_RESPONSE')
        }
        yield* guarded(emitOpenAIChunk(payload, state))
        if (!state.sawContent) throw bridgeError('upstream returned an empty response', 'EMPTY_RESPONSE')
        yield* guarded(closeBlocks(state))
        yield* guarded(usageChunk())
        const reason = finishReasonFrom(state.finishReason, state.sawToolCall)
        yield* guarded([{ type: 'finish', reason }])
        return
      }

      if (provider.dialect === 'anthropic') {
        for await (const event of parseSSE(response.body, { signal: controller.signal, onActivity: resetIdle })) {
          if (event.data.trim().length === 0) continue
          let payload
          try { payload = JSON.parse(event.data) } catch {
            throw bridgeError('upstream sent a non-JSON SSE data event', 'INVALID_RESPONSE')
          }
          if (provider.trace === 'verbose') log?.trace?.('sse', payload)
          yield* guarded(emitAnthropicEvent(event.event, payload, state))
          if (state.done) break
        }
      } else {
        for await (const event of parseSSE(response.body, { signal: controller.signal, onActivity: resetIdle })) {
          if (event.data === '[DONE]') {
            state.done = true
            break
          }
          if (event.data.trim().length === 0) continue
          let payload
          try {
            payload = JSON.parse(event.data)
          } catch {
            log?.trace?.('sse-unparseable', { data: event.data.slice(0, 500) })
            throw bridgeError('upstream sent a non-JSON SSE data event', 'INVALID_RESPONSE')
          }
          if (provider.trace === 'verbose') log?.trace?.('sse', payload)
          yield* guarded(emitOpenAIChunk(payload, state))
        }
      }

      if (!state.done && state.finishReason === undefined) {
        throw bridgeError('upstream stream ended before a completion marker ([DONE] or finish_reason)', 'TRANSPORT')
      }
      if (!state.sawContent) throw bridgeError('upstream stream produced no content', 'EMPTY_RESPONSE')
      yield* guarded(closeBlocks(state))
      yield* guarded(usageChunk())
      const reason = finishReasonFrom(state.finishReason, state.sawToolCall)
      yield* guarded([{ type: 'finish', reason }])
      log?.trace?.('finish', { reason, usage: state.usage, elapsedMs: Date.now() - started, sawToolCall: state.sawToolCall })
    } catch (error) {
      // Usage the upstream already reported is real even when the turn fails.
      if (!usageSent && state.usage !== undefined
        && state.usage.inputTokens !== undefined && state.usage.outputTokens !== undefined) {
        usageSent = true
        yield { type: 'usage', usage: state.usage }
      }
      if (isAbortError(error) || controller.signal.aborted) {
        if (error?.failure !== undefined) throw error
        const timedOut = abortedBy === 'timeout' || abortedBy === 'idle-timeout'
        throw bridgeError(
          timedOut ? `upstream stream timed out after ${provider.streamIdleTimeoutMs}ms` : 'upstream stream aborted',
          timedOut ? 'TIMEOUT' : 'ABORTED',
          { cause: error },
        )
      }
      if (error?.failure !== undefined) throw error
      log?.trace?.('stream-error', { message: String(error?.message ?? error), code: error?.code })
      throw bridgeError(`upstream stream error: ${String(error?.message ?? error)}`, error?.code ?? 'TRANSPORT', { cause: error })
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function prepareCall(_provider, model, signal) {
    return {
      model: await resolveModel(_provider, model, signal),
      stream: (options) => stream(options),
    }
  }

  return {
    id: provider.route,
    provider,
    providerInfo,
    providerRetryPolicy,
    imageRequestPricing,
    imageRequestTarget,
    listModels,
    resolveModel,
    prepareCall,
    stream,
  }
}
