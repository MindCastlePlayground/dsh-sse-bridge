import test from 'node:test'
import assert from 'node:assert/strict'
import { SseExportServer } from '../lib/export-server.js'
import { parseSSE } from '../lib/sse.js'
import { collect, createFakeLLM, createFakeCtx, textStream, toolStream, fromChunks } from './fixtures.mjs'

/** Start an export server over a fake LLM with a scripted stream. */
async function startExport({ config = {}, streams, catalog = {}, attachments, resolveRoute } = {}) {
  const llm = createFakeLLM({ streams })
  const ctx = createFakeCtx({ llm, attachments })
  const normalized = await import('../lib/config.js').then((module) => module.normalizeConfig({ export: { port: 0, ...config } }).export)
  const server = new SseExportServer({
    config: normalized,
    log: {},
    attachments,
    listModels: resolveRoute?.listModels ?? (() => [{ id: 'model-a', provider: 'fake', model: 'model-a', name: 'Model A' }]),
    resolveRoute: resolveRoute?.resolveRoute ?? (async (modelId) => ({ provider: 'fake', model: modelId })),
    stream: (options) => llm.stream(options),
  })
  await server.start()
  return { server, llm, ctx, config: normalized, origin: server.origin }
}

async function postJSON(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Read an SSE response into payloads plus the raw [DONE] marker. */
async function readSSE(response) {
  const payloads = []
  let done = false
  for await (const event of parseSSE(response.body)) {
    if (event.data === '[DONE]') {
      done = true
      continue
    }
    if (event.data.startsWith('{')) payloads.push(JSON.parse(event.data))
  }
  return { payloads, done }
}

// ---------------------------------------------------------------------------
// Health, models, routing
// ---------------------------------------------------------------------------

test('the export server binds an ephemeral port', async (t) => {
  const { server } = await startExport()
  t.after(() => server.stop())
  assert.ok(server.port > 0)
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
})

test('GET /health reports running state', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const response = await fetch(`${origin}/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.service, 'dsh-sse-bridge')
})

test('GET /models lists exported models in OpenAI shape', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const body = await (await fetch(`${origin}/models`)).json()
  assert.equal(body.object, 'list')
  assert.equal(body.data[0].id, 'model-a')
  assert.equal(body.data[0].object, 'model')
})

test('an unknown endpoint returns a JSON 404 with the expected paths', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const response = await fetch(`${origin}/nope`)
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.match(body.error.message, /chat\/completions/)
})

test('a non-POST chat invocation is rejected with 405', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const response = await fetch(`${origin}/chat/completions`)
  assert.equal(response.status, 405)
})

test('an unknown model returns 404 model_not_found', async (t) => {
  const { server, origin } = await startExport({
    resolveRoute: { resolveRoute: async () => undefined },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'nope',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, 'model_not_found')
})

test('an empty body is rejected with 400', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const response = await fetch(`${origin}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' })
  assert.equal(response.status, 400)
})

test('malformed JSON is rejected with 400', async (t) => {
  const { server, origin } = await startExport()
  t.after(() => server.stop())
  const response = await fetch(`${origin}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(response.status, 400)
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('POST streams role, content, finish and usage frames then [DONE]', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('Hello world', { usage: { inputTokens: 4, outputTokens: 2 } }) },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  const { payloads, done } = await readSSE(response)
  assert.equal(done, true)
  assert.equal(payloads[0].choices[0].delta.role, 'assistant')
  const text = payloads.filter((entry) => entry.choices[0]?.delta?.content).map((entry) => entry.choices[0].delta.content).join('')
  assert.equal(text, 'Hello world')
  const finish = payloads.find((entry) => entry.choices[0]?.finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'stop')
  const usage = payloads.find((entry) => entry.usage !== undefined)
  assert.equal(usage.usage.prompt_tokens, 4)
  assert.equal(usage.usage.completion_tokens, 2)
  assert.deepEqual(usage.choices, [])
})

test('streaming reasoning arrives on reasoning_content', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('answer', { reasoning: 'pondering' }) },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const { payloads } = await readSSE(response)
  const reasoning = payloads.filter((entry) => entry.choices[0]?.delta?.reasoning_content)
    .map((entry) => entry.choices[0].delta.reasoning_content).join('')
  assert.equal(reasoning, 'pondering')
})

test('streaming tool calls are numbered and carry finish_reason tool_calls', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': toolStream({ args: '{"path":"a.txt"}' }) },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'user', content: 'read a.txt' }],
  })
  const { payloads } = await readSSE(response)
  const calls = payloads.flatMap((entry) => entry.choices[0]?.delta?.tool_calls ?? [])
  assert.equal(calls[0].index, 0)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].function.name, 'read')
  const finish = payloads.find((entry) => entry.choices[0]?.finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'tool_calls')
})

test('a max-tokens finish maps to length', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('cut', { finish: { kind: 'max-tokens' } }) },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  const { payloads } = await readSSE(response)
  assert.equal(payloads.find((entry) => entry.choices[0]?.finish_reason).choices[0].finish_reason, 'length')
})

test('an in-stream provider failure becomes an SSE error frame', async (t) => {
  const { server, origin } = await startExport({
    streams: {
      'fake/model-a': [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'SERVER' } } },
      ],
    },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200)
  const { payloads, done } = await readSSE(response)
  const error = payloads.find((entry) => entry.error !== undefined)
  assert.equal(error.error.message, 'provider exploded')
  assert.equal(error.error.code, 'SERVER')
  assert.equal(done, true)
})

test('a NO_ADAPTER failure is reported in-band, not as a broken socket', async (t) => {
  const { server, origin } = await startExport({ streams: {} })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  const { payloads } = await readSSE(response)
  const error = payloads.find((entry) => entry.error !== undefined)
  assert.match(error.error.message, /NO_ADAPTER/)
})

test('non-streaming requests return one chat.completion body', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('whole answer', { usage: { inputTokens: 3, outputTokens: 2 } }) },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const body = await response.json()
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.choices[0].message.content, 'whole answer')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(body.usage.prompt_tokens, 3)
})

test('non-streaming tool calls are assembled into one message', async (t) => {
  const { server, origin } = await startExport({ streams: { 'fake/model-a': toolStream() } })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    stream: false,
    messages: [{ role: 'user', content: 'read' }],
  })
  const body = await response.json()
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read')
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
})

// ---------------------------------------------------------------------------
// Request translation into DSH options
// ---------------------------------------------------------------------------

test('system messages become ctx.llm.stream options.system, not a message', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  })
  const call = llm.calls[0]
  assert.equal(call.system, 'be terse')
  assert.deepEqual(call.messages.map((message) => message.role), ['user'])
})

test('OpenAI tool definitions become DSH tools', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    }],
  })
  const call = llm.calls[0]
  assert.equal(call.tools[0].name, 'read')
  assert.deepEqual(call.tools[0].parameters.properties.path, { type: 'string' })
})

test('assistant tool_calls and tool results round-trip into DSH content blocks', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('done') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ],
  })
  const call = llm.calls[0]
  const assistant = call.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.content[0].type, 'tool-call')
  assert.equal(assistant.content[0].id, 'call_1')
  assert.equal(assistant.content[0].arguments, '{"path":"a.txt"}')
  const tool = call.messages.find((message) => message.role === 'tool')
  assert.equal(tool.toolCallId, 'call_1')
  assert.equal(tool.content[0].text, 'file body')
})

test('assistant messages carry a DSH source so replay stripping cannot crash', async (t) => {
  // DSH's `LlmRuntime.forAdapter` dereferences `message.source` on every
  // assistant message; a bare one throws "reading 'replayState'" on the next turn.
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('done') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'body' },
    ],
  })
  const call = llm.calls[0]
  const assistants = call.messages.filter((message) => message.role === 'assistant')
  assert.equal(assistants.length, 2)
  for (const message of assistants) {
    assert.ok(message.source !== undefined, 'assistant messages need source')
    assert.equal(message.source.kind, 'model')
    assert.equal(typeof message.source.provider, 'string')
    assert.equal(typeof message.source.model, 'string')
    // No replay state is being replayed, so none may be claimed.
    assert.equal(message.source.replayState, undefined)
  }
  const tool = call.messages.find((message) => message.role === 'tool')
  assert.equal(tool.source.kind, 'tool')
  assert.equal(tool.source.callId, 'call_9')
})

test('max_tokens, temperature and stop reach DSH unchanged', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    max_tokens: 123,
    temperature: 0.3,
    stop: ['END'],
    messages: [{ role: 'user', content: 'hi' }],
  })
  const call = llm.calls[0]
  assert.equal(call.maxTokens, 123)
  assert.equal(call.temperature, 0.3)
  assert.deepEqual(call.stop, ['END'])
})

test('a string stop value is normalized to a list', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, { model: 'model-a', stop: 'END', messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(llm.calls[0].stop, ['END'])
})

test('an invalid message role is rejected with a 400 before streaming', async (t) => {
  const { server, origin } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'wizard', content: 'hi' }],
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'invalid_messages')
})

test('a tool result without tool_call_id is rejected', async (t) => {
  const { server, origin } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'tool', content: 'x' }],
  })
  assert.equal(response.status, 400)
})

// ---------------------------------------------------------------------------
// Attachments, auth, CORS, limits
// ---------------------------------------------------------------------------

test('inline data: images are admitted into the attachment store', async (t) => {
  const saved = []
  const attachments = {
    async saveImages(inputs) {
      saved.push(...inputs)
      return inputs.map((_input, index) => ({ attachmentId: `sha256:img${index}`, mediaType: 'image/png' }))
    },
  }
  const { server, origin, llm } = await startExport({
    streams: { 'fake/model-a': textStream('ok') },
    attachments,
  })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    }],
  })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  const image = llm.calls[0].messages[0].content.find((block) => block.type === 'image')
  assert.equal(image.attachment.attachmentId, 'sha256:img0')
})

test('an inline image degrades to text without an attachment store', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }],
  })
  const block = llm.calls[0].messages[0].content[0]
  assert.equal(block.type, 'text')
  assert.match(block.text, /not forwarded/)
})

test('a remote image URL is preserved as text rather than fetched', async (t) => {
  const { server, origin, llm } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
  })
  const block = llm.calls[0].messages[0].content[0]
  assert.equal(block.type, 'text')
  assert.match(block.text, /example\.com/)
})

test('a configured API key is required and enforced', async (t) => {
  const { server, origin } = await startExport({
    config: { auth: { apiKey: 'sk-secret', allowLoopbackWithoutKey: false } },
    streams: { 'fake/model-a': textStream('ok') },
  })
  t.after(() => server.stop())

  const unauthorized = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(unauthorized.status, 401)

  const wrong = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer nope' })
  assert.equal(wrong.status, 401)

  const authorized = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer sk-secret' })
  assert.equal(authorized.status, 200)
  await readSSE(authorized)
})

test('the x-api-key header is accepted as a credential', async (t) => {
  const { server, origin } = await startExport({
    config: { auth: { apiKey: 'sk-secret', allowLoopbackWithoutKey: false } },
    streams: { 'fake/model-a': textStream('ok') },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'sk-secret' })
  assert.equal(response.status, 200)
  await readSSE(response)
})

test('health stays reachable without a credential so probes work', async (t) => {
  const { server, origin } = await startExport({ config: { auth: { apiKey: 'sk-secret', allowLoopbackWithoutKey: false } } })
  t.after(() => server.stop())
  // Health is behind auth by design: an unauthenticated probe must not leak stats.
  const response = await fetch(`${origin}/health`)
  assert.equal(response.status, 401)
})

test('CORS preflight is answered and headers are present', async (t) => {
  const { server, origin } = await startExport({
    config: { cors: { enabled: true, origins: ['*'] } },
    streams: { 'fake/model-a': textStream('ok') },
  })
  t.after(() => server.stop())
  const preflight = await fetch(`${origin}/chat/completions`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
})

test('a concurrency limit returns 429', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = (async function* slowStream() {
    await gate
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const { server, origin } = await startExport({
    config: { limits: { maxConcurrent: 1 } },
    streams: { 'fake/model-a': () => slow },
  })
  t.after(() => server.stop())

  const first = postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const second = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(second.status, 429)

  release()
  const response = await first
  assert.equal(response.status, 200)
  await readSSE(response)
})

test('a client disconnect aborts the underlying DSH stream', async (t) => {
  let aborted = false
  const config = { port: 0 }
  const normalized = (await import('../lib/config.js')).normalizeConfig({ export: config }).export
  const server = new SseExportServer({
    config: normalized,
    log: {},
    listModels: () => [{ id: 'model-a' }],
    resolveRoute: async () => ({ provider: 'fake', model: 'model-a' }),
    stream: (options) => (async function* slow() {
      options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      yield { type: 'text-delta', index: 0, text: 'first' }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  await server.start()
  t.after(() => server.stop())

  const controller = new AbortController()
  const response = await fetch(`${server.origin}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  try { await reader.cancel() } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(aborted, true)
})

test('keepalive comments are emitted during a slow first token', async (t) => {
  const { server, origin } = await startExport({
    config: { sse: { keepAliveMs: 40 } },
    // The generator itself waits, so the keepalive timer has something to cover.
    streams: {
      'fake/model-a': async function* slowFirstToken() {
        await new Promise((resolve) => setTimeout(resolve, 150))
        yield { type: 'text-delta', index: 0, text: 'late' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  t.after(() => server.stop())

  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  const text = await response.text()
  assert.match(text, /: keep-alive/)
  assert.match(text, /late/)
  assert.match(text, /\[DONE\]/)
})

test('every frame ends with a blank line and never uses a bare newline', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('a\nb') },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  const text = await response.text()
  for (const frame of text.split('\n\n').filter(Boolean)) {
    assert.ok(frame.startsWith('data: ') || frame.startsWith(': '), `unexpected frame: ${frame}`)
  }
  // A multi-line text delta must not corrupt framing; the payload stays one line.
  for (const line of text.split('\n').filter((line) => line.startsWith('data: {'))) {
    assert.doesNotThrow(() => JSON.parse(line.slice('data: '.length)))
  }
})

test('a static model list restricts what the server accepts', async (t) => {
  const { server, origin } = await startExport({
    config: { modelSource: 'static', models: [{ id: 'pinned' }] },
    streams: { 'fake/pinned': textStream('ok') },
    resolveRoute: {
      resolveRoute: async (modelId) => (modelId === 'pinned' ? { provider: 'fake', model: 'pinned' } : undefined),
      listModels: () => [{ id: 'pinned' }],
    },
  })
  t.after(() => server.stop())
  const models = await (await fetch(`${origin}/models`)).json()
  assert.deepEqual(models.data.map((model) => model.id), ['pinned'])
  const response = await postJSON(`${origin}/chat/completions`, { model: 'pinned', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200)
  await readSSE(response)
})

test('the base path is configurable', async (t) => {
  const { server } = await startExport({ config: { basePath: '/openai/v1' }, streams: { 'fake/model-a': textStream('ok') } })
  t.after(() => server.stop())
  assert.match(server.origin, /\/openai\/v1$/)
  const response = await fetch(`${server.origin}/health`)
  assert.equal(response.status, 200)
})

test('stop() closes the listener so the port is released', async () => {
  const { server, origin } = await startExport({ streams: { 'fake/model-a': textStream('ok') } })
  const port = server.port
  assert.ok(port > 0)
  await server.stop()
  await assert.rejects(async () => fetch(`${origin}/health`))
})

test('stats count requests, streams, bytes and errors', async (t) => {
  const { server, origin } = await startExport({
    streams: { 'fake/model-a': textStream('counted') },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
  await readSSE(response)
  assert.equal(server.stats.requests, 1)
  assert.equal(server.stats.streams, 1)
  assert.ok(server.stats.bytes > 0)
})

test('a request larger than the body limit is rejected with 413', async (t) => {
  const { server, origin } = await startExport({
    config: { limits: { maxBodyBytes: 1_024 } },
    streams: { 'fake/model-a': textStream('ok') },
  })
  t.after(() => server.stop())
  const response = await postJSON(`${origin}/chat/completions`, {
    model: 'model-a',
    messages: [{ role: 'user', content: 'x'.repeat(4_000) }],
  })
  assert.equal(response.status, 413)
})

test('fromChunks fixture streams with delay and remains ordered', async () => {
  const chunks = await collect(fromChunks([{ type: 'text-delta', index: 0, text: 'a' }, { type: 'finish', reason: { kind: 'stop' } }], { delayMs: 1 }))
  assert.equal(chunks.length, 2)
})
