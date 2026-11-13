import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLineNormalizer,
  parseSSE,
  sseFrame,
  sseComment,
  chunksToWire,
  chunksToCompletion,
  finishReasonFromDSH,
  usageToWire,
} from '../lib/sse.js'
import { collect, frame, textStream, toolStream } from './fixtures.mjs'

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test('parseSSE handles single-line events', async () => {
  const body = 'data: a\n\ndata: b\n\n'
  const events = await collect(parseSSE(body))
  assert.deepEqual(events.map((event) => event.data), ['a', 'b'])
})

test('parseSSE joins multi-line data with newlines', async () => {
  const body = 'data: line1\ndata: line2\n\n'
  const events = await collect(parseSSE(body))
  assert.equal(events.length, 1)
  assert.equal(events[0].data, 'line1\nline2')
})

test('parseSSE strips one leading space but keeps the rest', async () => {
  const events = await collect(parseSSE('data:  two spaces\n\ndata:none\n\n'))
  assert.equal(events[0].data, ' two spaces')
  assert.equal(events[1].data, 'none')
})

test('parseSSE reads event names and ids', async () => {
  const events = await collect(parseSSE('event: ping\nid: 7\ndata: {}\n\n'))
  assert.equal(events[0].event, 'ping')
  assert.equal(events[0].id, '7')
})

test('parseSSE reports comments without emitting events', async () => {
  const comments = []
  const events = await collect(parseSSE(': keep-alive\n\ndata: x\n\n', { onComment: (text) => comments.push(text) }))
  assert.deepEqual(comments, ['keep-alive'])
  assert.equal(events.length, 1)
  assert.equal(events[0].data, 'x')
})

test('parseSSE ignores unknown fields and handles [DONE]', async () => {
  const events = await collect(parseSSE('foo: bar\ndata: [DONE]\n\n'))
  assert.equal(events[0].data, '[DONE]')
})

test('parseSSE handles CRLF and bare CR line endings', async () => {
  const crlf = await collect(parseSSE('data: a\r\n\r\ndata: b\r\n\r\n'))
  assert.deepEqual(crlf.map((event) => event.data), ['a', 'b'])
  const cr = await collect(parseSSE('data: a\r\rdata: b\r\r'))
  assert.deepEqual(cr.map((event) => event.data), ['a', 'b'])
})

test('parseSSE splits a CRLF across chunk boundaries', async () => {
  const chunks = ['data: a\r', '\n\r', '\ndata: b\n\n']
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const events = await collect(parseSSE(stream))
  assert.deepEqual(events.map((event) => event.data), ['a', 'b'])
})

test('parseSSE does not split a multi-byte character across chunks', async () => {
  const bytes = new TextEncoder().encode('data: 你好世界\n\n')
  const halfway = 9 // inside the first 3-byte character
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, halfway))
      controller.enqueue(bytes.slice(halfway, halfway + 2))
      controller.enqueue(bytes.slice(halfway + 2))
      controller.close()
    },
  })
  const events = await collect(parseSSE(stream))
  assert.equal(events[0].data, '你好世界')
})

test('parseSSE strips a leading BOM', async () => {
  const events = await collect(parseSSE('\uFEFFdata: x\n\n'))
  assert.equal(events[0].data, 'x')
})

test('parseSSE flushes a final event without a trailing blank line', async () => {
  const events = await collect(parseSSE('data: last'))
  assert.deepEqual(events.map((event) => event.data), ['last'])
})

test('parseSSE aborts promptly on signal', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: a\n\n'))
      // Never closes: the abort must break the loop.
    },
  })
  const collected = []
  await assert.rejects(async () => {
    for await (const event of parseSSE(body, { signal: controller.signal })) {
      collected.push(event.data)
      controller.abort(new Error('stop now'))
    }
  }, /stop now/)
  assert.deepEqual(collected, ['a'])
})

test('createLineNormalizer holds a trailing CR', () => {
  const normalize = createLineNormalizer()
  assert.equal(normalize('a\r'), 'a')
  assert.equal(normalize('\nb'), '\nb')
  const split = createLineNormalizer()
  assert.equal(split('x\r'), 'x')
  assert.equal(split('y'), '\ny')
})

// ---------------------------------------------------------------------------
// SSE writing
// ---------------------------------------------------------------------------

test('sseFrame renders data, event and id', () => {
  assert.equal(sseFrame('hello'), 'data: hello\n\n')
  assert.equal(sseFrame('a\nb'), 'data: a\ndata: b\n\n')
  assert.equal(sseFrame('x', { event: 'ping', id: '3' }), 'id: 3\nevent: ping\ndata: x\n\n')
})

test('sseComment renders a comment frame', () => {
  assert.equal(sseComment(), ': keep-alive\n\n')
})

// ---------------------------------------------------------------------------
// DSH chunks -> wire chunks
// ---------------------------------------------------------------------------

test('chunksToWire emits role, text deltas, finish and usage', async () => {
  const chunks = textStream('Hello world', { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } })
  const wire = await collect(chunksToWire(chunks, { model: 'm' }))
  assert.equal(wire[0].choices[0].delta.role, 'assistant')
  const text = wire.filter((entry) => entry.choices[0]?.delta?.content !== undefined).map((entry) => entry.choices[0].delta.content).join('')
  assert.equal(text, 'Hello world')
  const last = wire[wire.length - 1]
  assert.deepEqual(last.choices, [])
  assert.equal(last.usage.prompt_tokens, 5)
  assert.equal(last.usage.completion_tokens, 3)
  assert.equal(last.usage.total_tokens, 8)
  const finish = wire.filter((entry) => entry.choices[0]?.finish_reason).at(-1)
  assert.equal(finish.choices[0].finish_reason, 'stop')
})

test('chunksToWire surfaces reasoning on reasoning_content', async () => {
  const wire = await collect(chunksToWire(textStream('ok', { reasoning: 'thinking...' }), { model: 'm' }))
  const reasoning = wire.filter((entry) => entry.choices[0]?.delta?.reasoning_content !== undefined)
    .map((entry) => entry.choices[0].delta.reasoning_content).join('')
  assert.equal(reasoning, 'thinking...')
})

test('chunksToWire numbers tool calls from zero regardless of block index', async () => {
  const chunks = [
    { type: 'block-start', index: 5, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 5, id: 'call_a', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 5, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' } },
    { type: 'block-start', index: 9, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 9, id: 'call_b', name: 'write', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const wire = await collect(chunksToWire(chunks, { model: 'm' }))
  const indexes = wire.flatMap((entry) => entry.choices[0]?.delta?.tool_calls ?? []).map((call) => call.index)
  assert.deepEqual(indexes, [0, 1])
  const finish = wire.at(-1).choices[0].finish_reason
  assert.equal(finish, 'tool_calls')
})

test('chunksToWire maps max-tokens to length', async () => {
  const wire = await collect(chunksToWire(textStream('x', { finish: { kind: 'max-tokens' } }), { model: 'm' }))
  assert.equal(wire.at(-1).choices[0].finish_reason, 'length')
})

test('chunksToWire throws on an error finish so the caller can send an error frame', async () => {
  const chunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 500', code: 'SERVER' } } }]
  await assert.rejects(async () => collect(chunksToWire(chunks, { model: 'm' })), /upstream 500/)
})

test('chunksToWire throws on an aborted finish with an aborted flag', async () => {
  const chunks = [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }]
  await assert.rejects(async () => collect(chunksToWire(chunks, { model: 'm' })), (error) => {
    assert.equal(error.aborted, true)
    return true
  })
})

test('chunksToWire emits a role frame even for an empty turn', async () => {
  const wire = await collect(chunksToWire([{ type: 'finish', reason: { kind: 'stop' } }], { model: 'm' }))
  assert.equal(wire[0].choices[0].delta.role, 'assistant')
  assert.equal(wire.at(-1).choices[0].finish_reason, 'stop')
})

test('chunksToCompletion assembles text, reasoning and tool calls', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: '{"pa' },
    { type: 'tool-call-delta', index: 1, argumentsDelta: 'th":"a.txt"}' },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const completion = await chunksToCompletion(chunks, { model: 'm' })
  assert.equal(completion.choices[0].message.content, 'Hello world')
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'read')
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.txt"}')
  assert.equal(completion.choices[0].finish_reason, 'tool_calls')
  assert.equal(completion.usage.prompt_tokens, 2)
})

test('finishReasonFromDSH covers every DSH finish kind', () => {
  assert.equal(finishReasonFromDSH({ kind: 'stop' }), 'stop')
  assert.equal(finishReasonFromDSH({ kind: 'tool-calls' }), 'tool_calls')
  assert.equal(finishReasonFromDSH({ kind: 'max-tokens' }), 'length')
  assert.equal(finishReasonFromDSH(undefined), 'stop')
})

test('usageToWire adds cache reads back into prompt_tokens', () => {
  const usage = usageToWire({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 })
  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.completion_tokens, 5)
  assert.equal(usage.total_tokens, 105)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 90)
})

test('usageToWire returns undefined for an empty usage', () => {
  assert.equal(usageToWire(undefined), undefined)
  assert.equal(usageToWire({}), undefined)
})

test('textStream fixture produces a reassemblable stream', async () => {
  const wire = await collect(chunksToWire(textStream('abcdefgh'), { model: 'm' }))
  assert.ok(wire.length > 2)
})

test('toolStream fixture yields a tool call wire frame', async () => {
  const wire = await collect(chunksToWire(toolStream(), { model: 'm' }))
  const calls = wire.flatMap((entry) => entry.choices[0]?.delta?.tool_calls ?? [])
  assert.ok(calls.length > 0)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(wire.at(-1).choices[0].finish_reason, 'tool_calls')
})

test('frame fixture round-trips through the parser', async () => {
  const events = await collect(parseSSE(frame({ a: 1 }) + frame({ b: 2 })))
  assert.deepEqual(events.map((event) => JSON.parse(event.data)), [{ a: 1 }, { b: 2 }])
})
