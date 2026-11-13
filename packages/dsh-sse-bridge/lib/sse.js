// The SSE wire layer shared by both directions.
//
// Read side:  a tolerant `text/event-stream` parser that follows the WHATWG
//             grammar (LF/CRLF/CR, comments, multi-line data, `event:` names,
//             `retry:` hints, BOM) and never splits a UTF-8 sequence across
//             chunk boundaries.
// Write side:  an incremental Chat Completions chunk builder that produces the
//             exact frames DSH, opencode and the OpenAI SDKs expect: role delta,
//             reasoning deltas, content deltas, tool-call deltas, a
//             `finish_reason` frame, a usage frame, and `[DONE]`.
//
// Both halves are exported because the import adapter parses upstream SSE while
// the export server writes it; keeping one implementation is what makes the
// round-trip test meaningful.

const BOM = '\uFEFF'

/**
 * Normalize one decoded chunk for line splitting while holding a trailing CR.
 *
 * A CR ends a line whether or not the next byte is its LF partner, so a CR at
 * the end of a chunk cannot be resolved until the next chunk arrives.  The
 * parser holds it and prepends the newline on the next call.
 */
export function createLineNormalizer() {
  let pendingCR = false
  return (input) => {
    let text = input
    if (pendingCR) {
      pendingCR = false
      if (text.startsWith('\n')) text = text.slice(1)
      text = `\n${text}`
    }
    if (text.endsWith('\r')) {
      text = text.slice(0, -1)
      pendingCR = true
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
}

/**
 * Incrementally parse an SSE byte stream into events.
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>|null|undefined} body
 * @param {{ signal?: AbortSignal, onActivity?: () => void, onComment?: (text: string) => void }} [options]
 * @returns {AsyncGenerator<{ data: string, event?: string, id?: string }>}
 */
export async function* parseSSE(body, options = {}) {
  if (body === null || body === undefined) return
  const { signal, onActivity, onComment } = options
  const normalizer = createLineNormalizer()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  let eventName
  let eventId
  let sawFirstChunk = false

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = undefined
      eventId = undefined
      return undefined
    }
    const data = dataLines.join('\n')
    dataLines = []
    const event = { data, ...(eventName === undefined ? {} : { event: eventName }), ...(eventId === undefined ? {} : { id: eventId }) }
    eventName = undefined
    eventId = undefined
    return event
  }

  const consumeLine = (line) => {
    if (line === '') return flush()
    if (line.startsWith(':')) {
      onComment?.(line.slice(1).replace(/^ /, ''))
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        eventName = value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'id':
        if (!value.includes('\0')) eventId = value
        break
      case 'retry':
        // A retry hint is advisory for EventSource reconnects; the adapters own
        // their own reconnect policy so the field is validated and dropped.
        break
      default:
        // Unknown fields are ignored per the SSE specification.
        break
    }
    return undefined
  }

  const iterations = typeof body.getReader === 'function'
    ? readFromReader(body.getReader(), signal)
    : readFromIterable(body)

  for await (const bytes of iterations) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    onActivity?.()
    let text = decoder.decode(bytes, { stream: true })
    if (!sawFirstChunk) {
      sawFirstChunk = true
      if (text.startsWith(BOM)) text = text.slice(1)
    }
    buffer += normalizer(text)
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const event = consumeLine(line)
      if (event !== undefined) yield event
    }
  }
  buffer += normalizer(decoder.decode())
  if (buffer.length > 0) {
    for (const line of buffer.split('\n')) {
      const event = consumeLine(line)
      if (event !== undefined) yield event
    }
  }
  const last = flush()
  if (last !== undefined) yield last
}

async function* readFromReader(reader, signal) {
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) yield value
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
}

async function* readFromIterable(body) {
  for await (const chunk of body) {
    if (typeof chunk === 'string') yield new TextEncoder().encode(chunk)
    else yield chunk
  }
}

/** Encode one SSE frame. `data` may contain newlines; each line gets a prefix. */
export function sseFrame(data, { event, id } = {}) {
  let out = ''
  if (id !== undefined) out += `id: ${id}\n`
  if (event !== undefined) out += `event: ${event}\n`
  for (const line of String(data).split('\n')) out += `data: ${line}\n`
  return `${out}\n`
}

/** Encode one SSE comment (keepalive). */
export function sseComment(text = 'keep-alive') {
  return `: ${text}\n\n`
}

// ---------------------------------------------------------------------------
// Write side: DSH StreamChunk -> OpenAI Chat Completions chunks
// ---------------------------------------------------------------------------

const FINISH_REASON = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  'max-tokens': 'length',
  aborted: 'stop',
  error: 'stop',
}

/** Map a DSH finish reason to the wire `finish_reason` string. */
export function finishReasonFromDSH(reason) {
  const kind = reason?.kind ?? 'stop'
  return FINISH_REASON[kind] ?? 'stop'
}

/**
 * Convert DSH usage into OpenAI `usage`.
 *
 * DSH reports disjoint input/output/cache counts; OpenAI's `prompt_tokens`
 * folds cache hits into the aggregate, so the conversion adds them back.
 */
export function usageToWire(usage) {
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
    ...(cacheRead === undefined && cacheWrite === undefined ? {} : {
      prompt_tokens_details: {
        ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
      },
    }),
    ...(Number.isFinite(usage.reasoningTokens) ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  }
}

/**
 * Translate a DSH chunk stream into Chat Completions chunks.
 *
 * The translator is an async generator over DSH chunks so it composes directly
 * on top of `ctx.llm.stream()` without buffering a whole response.  Each yielded
 * object is a ready-to-serialize Chat Completions chunk; the caller owns the
 * `data:` framing and the terminal `[DONE]`.
 *
 * @param {AsyncIterable<object>} chunks DSH `StreamChunk` values.
 * @param {{ model: string, id?: string, created?: number, includeUsage?: boolean, reasoningField?: string }} options
 */
export async function* chunksToWire(chunks, options) {
  const model = options.model
  const id = options.id ?? `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  const created = options.created ?? Math.floor(Date.now() / 1000)
  const reasoningField = options.reasoningField ?? 'reasoning_content'
  let roleSent = false
  let finishKind = 'stop'
  let usage

  const envelope = (delta, finishReason) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })

  // Tool-call deltas are addressed by their position among tool-call blocks, not
  // by the DSH block index, because OpenAI's `index` counts calls in this turn.
  const toolPositions = new Map()
  let nextToolPosition = 0
  const positionOf = (blockIndex) => {
    if (!toolPositions.has(blockIndex)) toolPositions.set(blockIndex, nextToolPosition++)
    return toolPositions.get(blockIndex)
  }

  for await (const chunk of chunks) {
    if (chunk?.type === 'finish') {
      finishKind = chunk.reason?.kind ?? 'stop'
      if (finishKind === 'error') {
        const failure = chunk.reason.failure ?? {}
        const error = new Error(failure.message ?? 'model call failed')
        error.code = failure.code ?? 'PROVIDER_ERROR'
        throw error
      }
      if (finishKind === 'aborted') {
        const failure = chunk.reason.failure ?? {}
        const error = new Error(failure.message ?? 'model call aborted')
        error.code = failure.code ?? 'ABORTED'
        error.aborted = true
        throw error
      }
      // The finish frame is emitted after the loop so a trailing block-end does
      // not land after `finish_reason: "..."`, which some clients treat as fatal.
      continue
    }

    if (!roleSent) {
      roleSent = true
      yield envelope({ role: 'assistant', content: '' })
    }

    if (chunk?.type === 'usage') {
      usage = chunk.usage
      continue
    }
    if (chunk?.type === 'block-start') continue
    if (chunk?.type === 'block-end') continue
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      yield envelope({ content: chunk.text })
      continue
    }
    if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      yield envelope({ [reasoningField]: chunk.text })
      continue
    }
    if (chunk?.type === 'tool-call-delta') {
      const position = positionOf(chunk.index)
      const call = { index: position, ...(chunk.id === undefined ? {} : { id: chunk.id }), type: 'function', function: {} }
      if (typeof chunk.name === 'string' && chunk.name.length > 0) call.function.name = chunk.name
      if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) call.function.arguments = chunk.argumentsDelta
      yield envelope({ tool_calls: [call] })
      continue
    }
  }

  if (!roleSent) {
    // An empty but well-formed turn still needs a role frame so strict clients
    // do not reject the stream outright.
    yield envelope({ role: 'assistant', content: '' })
  }
  yield envelope({}, finishReasonFromDSH({ kind: finishKind }))
  if (options.includeUsage !== false && usage !== undefined) {
    const wire = usageToWire(usage)
    if (wire !== undefined) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: wire,
      }
    }
  }
}

/**
 * Build the non-streaming `chat.completion` body from a finished chunk stream.
 *
 * Used when a client sends `stream: false`; DSH only streams, so the body is
 * assembled here instead of asking the provider for a single JSON reply.
 */
export async function chunksToCompletion(chunks, options) {
  const text = []
  const reasoning = []
  const calls = []
  let usage
  let finishReason = 'stop'
  const reasoningField = options.reasoningField ?? 'reasoning_content'

  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta') text.push(chunk.text)
    else if (chunk?.type === 'reasoning-delta') reasoning.push(chunk.text)
    else if (chunk?.type === 'tool-call-delta') {
      const slot = chunk.index
      calls[slot] ??= { id: chunk.id, name: '', arguments: '' }
      if (typeof chunk.name === 'string' && chunk.name.length > 0) calls[slot].name = chunk.name
      if (typeof chunk.id === 'string' && chunk.id.length > 0) calls[slot].id = chunk.id
      if (typeof chunk.argumentsDelta === 'string') calls[slot].arguments += chunk.argumentsDelta
    } else if (chunk?.type === 'usage') usage = chunk.usage
    else if (chunk?.type === 'finish') {
      finishReason = finishReasonFromDSH(chunk.reason)
      if (chunk.reason?.kind === 'error') {
        const failure = chunk.reason.failure ?? {}
        const error = new Error(failure.message ?? 'model call failed')
        error.code = failure.code ?? 'PROVIDER_ERROR'
        throw error
      }
      if (chunk.reason?.kind === 'aborted') {
        const failure = chunk.reason.failure ?? {}
        const error = new Error(failure.message ?? 'model call aborted')
        error.code = failure.code ?? 'ABORTED'
        error.aborted = true
        throw error
      }
    }
  }

  const message = { role: 'assistant', content: text.length > 0 ? text.join('') : null }
  const wireReasoning = reasoning.join('')
  if (wireReasoning.length > 0) message[reasoningField] = wireReasoning
  const toolCalls = calls.filter(Boolean).map((call, position) => ({
    id: call.id ?? `call_${position}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
  }))
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
    if (message.content === null) delete message.content
  }

  const wireUsage = usageToWire(usage)
  return {
    id: options.id ?? `chatcmpl-${Math.random().toString(36).slice(2, 14)}`,
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(wireUsage === undefined ? {} : { usage: wireUsage }),
  }
}
