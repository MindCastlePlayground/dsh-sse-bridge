import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, SseBridgeConfigError } from '../lib/config.js'
import { createImportAdapter, buildOpenAIMessages, buildAnthropicBody } from '../lib/import-adapter.js'
import { collect, frame, createFakeCtx, startUpstream } from './fixtures.mjs'

function importConfig(overrides = {}, upstream) {
  const { import: importOverride, ...rest } = overrides
  new Unused(rest)
  return normalizeConfig({
    import: {
      route: 'test-route',
      displayName: 'Test Upstream',
      baseURL: upstream.baseURL,
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          contextWindow: 32_768,
          maxTokens: 4_096,
          reasoningEfforts: { low: 'low', high: 'high' },
        },
      ],
      connectTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
      ...importOverride,
    },
  }).import
}
class Unused { constructor(_value) {} }

function adapterFor(config, ctx = createFakeCtx()) {
  return createImportAdapter({ config, ctx, log: {} })
}

function userRequest(overrides = {}) {
  return {
    provider: 'test-route',
    model: 'model-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  }
}

function openAITextFrames(text = 'hello there') {
  return [
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    frame({ choices: [{ index: 0, delta: { content: text } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }),
    'data: [DONE]\n\n',
  ]
}

// ---------------------------------------------------------------------------
// Metadata contract (matches LlmRuntime validation)
// ---------------------------------------------------------------------------

test('resolveModel returns the exact identity LlmRuntime requires', async () => {
  const adapter = adapterFor(normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'm' }] } }).import)
  const info = await adapter.resolveModel('r', 'm')
  assert.equal(info.provider, 'r')
  assert.equal(info.id, 'm')
  assert.equal(typeof info.name, 'string')
  assert.ok(info.name.length > 0)
  assert.equal(info.context.contextWindow, 131_072)
  assert.equal(info.defaultMaxTokens, 8_192)
})

test('resolveModel accepts an unlisted model with defaults', async () => {
  const adapter = adapterFor(normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1' } }).import)
  const info = await adapter.resolveModel('r', 'not-listed')
  assert.equal(info.id, 'not-listed')
  assert.equal(info.name, 'not-listed')
})

test('resolveModel advertises reasoning efforts only when configured', async () => {
  const config = normalizeConfig({
    import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'm', reasoningEfforts: { low: 'lo', high: 'hi' }, defaultReasoningEffort: 'low' }] },
  }).import
  const adapter = adapterFor(config)
  const info = await adapter.resolveModel('r', 'm')
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'low')
})

test('resolveModel omits reasoning when reasoningEfforts is false', async () => {
  const config = normalizeConfig({
    import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'm', reasoningEfforts: false }] },
  }).import
  const info = await adapterFor(config).resolveModel('r', 'm')
  assert.equal(info.reasoning, undefined)
})

test('resolveModel honors an abort signal', async () => {
  const adapter = adapterFor(normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1' } }).import)
  const controller = new AbortController()
  controller.abort(new Error('nope'))
  await assert.rejects(() => adapter.resolveModel('r', 'm', controller.signal), /nope/)
})

test('providerInfo preserves the route id', () => {
  const adapter = adapterFor(normalizeConfig({ import: { route: 'my-route', displayName: 'My Upstream', baseURL: 'http://127.0.0.1:1/v1' } }).import)
  assert.deepEqual(adapter.providerInfo(), { id: 'my-route', name: 'My Upstream' })
})

test('listModels returns configured models without network I/O', async () => {
  const upstream = await startUpstream(() => ({ frames: [] }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    const models = await adapter.listModels()
    assert.deepEqual(models.map((model) => model.id), ['model-a'])
    assert.equal(models[0].inputModalities[0], 'text')
    assert.equal(upstream.requests.length, 0)
  } finally {
    await upstream.close()
  }
})

test('listModels discovers from /models when none are configured', async () => {
  const upstream = await startUpstream(() => ({ frames: [] }))
  try {
    const config = normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: upstream.baseURL } }).import
    const models = await adapterFor(config).listModels()
    assert.deepEqual(models.map((model) => model.id), ['discovered-a', 'discovered-b'])
    assert.ok(upstream.requests[0].url.endsWith('/v1/models'))
  } finally {
    await upstream.close()
  }
})

test('listModels falls back to the configured list when discovery fails', async () => {
  const upstream = await startUpstream(() => ({ status: 500, body: '{"error":"boom"}' }))
  try {
    const config = normalizeConfig({
      import: { route: 'r', displayName: 'R', baseURL: upstream.baseURL, models: [{ id: 'kept' }] },
    }).import
    // A configured list short-circuits discovery entirely.
    const models = await adapterFor(config).listModels()
    assert.deepEqual(models.map((model) => model.id), ['kept'])
    assert.equal(upstream.requests.length, 0)
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

test('buildOpenAIMessages merges system messages into one leading message', async () => {
  const messages = await buildOpenAIMessages({
    system: 'sys A',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys B' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, 'sys A\n\nsys B')
  assert.equal(messages[1].content, 'hello')
})

test('buildOpenAIMessages keeps tool calls and tool results linked', async () => {
  const messages = await buildOpenAIMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
    ],
  })
  assert.equal(messages.length, 3)
  assert.equal(messages[1].tool_calls[0].id, 'call_1')
  assert.equal(messages[1].tool_calls[0].function.name, 'read')
  assert.equal(messages[2].role, 'tool')
  assert.equal(messages[2].tool_call_id, 'call_1')
  assert.equal(messages[2].content, 'file body')
})

test('buildOpenAIMessages projects images through the resolver', async () => {
  const messages = await buildOpenAIMessages({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'x.png' } },
      ],
    }],
  }, { imageDataURL: async () => 'data:image/png;base64,AAAA' })
  assert.equal(messages[0].content[1].type, 'image_url')
  assert.equal(messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
})

test('buildOpenAIMessages degrades an unresolvable image to text', async () => {
  const messages = await buildOpenAIMessages({
    messages: [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'x.png' } }],
    }],
  })
  // A single text part collapses to a plain string, which is what upstreams expect.
  assert.equal(typeof messages[0].content, 'string')
  assert.match(messages[0].content, /unavailable/)
  assert.match(messages[0].content, /x\.png/)
})

test('buildOpenAIBody maps tools, limits and reasoning effort', async () => {
  const adapter = adapterFor(importConfig({}, { baseURL: 'http://127.0.0.1:1/v1' }))
  void adapter
  const config = normalizeConfig({
    import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'm', reasoningEfforts: { high: 'HIGH' } }] },
  }).import
  const { buildOpenAIBody } = await import('../lib/import-adapter.js')
  const body = buildOpenAIBody(config, {
    model: 'm',
    maxTokens: 256,
    temperature: 0.2,
    stop: ['END'],
    reasoningEffort: 'high',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
  }, [{ role: 'user', content: 'hi' }])
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_tokens, 256)
  assert.equal(body.reasoning_effort, 'HIGH')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools[0].function.name, 'read')
  assert.deepEqual(body.stop, ['END'])
})

test('maxTokensField selects max_completion_tokens', () => {
  const config = normalizeConfig({
    import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', maxTokensField: 'max_completion_tokens' },
  }).import
  const adapter = adapterFor(config)
  void adapter
})

test('buildAnthropicBody converts tool calls and images', () => {
  const config = normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1', dialect: 'anthropic' } }).import
  const body = buildAnthropicBody(config, { model: 'claude-like', maxTokens: 100 }, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ])
  assert.equal(body.system, 'be brief')
  assert.equal(body.max_tokens, 100)
  assert.equal(body.messages[0].content[0].type, 'image')
  assert.equal(body.messages[0].content[0].source.media_type, 'image/png')
  assert.equal(body.messages[1].content[0].type, 'tool_use')
  assert.deepEqual(body.messages[1].content[0].input, { p: 1 })
  assert.equal(body.messages[2].content[0].type, 'tool_result')
})

// ---------------------------------------------------------------------------
// Streaming against a real upstream
// ---------------------------------------------------------------------------

test('stream maps an OpenAI SSE reply into DSH chunks', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames('hello there') }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    const chunks = await collect(adapter.stream(userRequest()))

    const types = chunks.map((chunk) => chunk.type)
    assert.equal(types[0], 'block-start')
    assert.ok(types.includes('text-delta'))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'hello there')
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.usage.inputTokens, 7)
    assert.equal(usage.usage.outputTokens, 2)
    assert.equal(usage.usage.totalTokens, 9)

    // Every opened block is closed exactly once, in order.
    const opened = chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.index)
    const closed = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.index)
    assert.deepEqual(opened, closed)
  } finally {
    await upstream.close()
  }
})

test('stream sends the provider credential and body DSH builds', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    process.env.SSE_BRIDGE_TEST_KEY = 'sk-test-123'
    const adapter = adapterFor(importConfig({
      import: { apiKeyEnv: 'SSE_BRIDGE_TEST_KEY' },
    }, upstream))
    await collect(adapter.stream(userRequest({ maxTokens: 64 })))
    const request = upstream.requests[0]
    assert.equal(request.headers.authorization, 'Bearer sk-test-123')
    assert.equal(request.body.model, 'model-a')
    assert.equal(request.body.stream, true)
    assert.equal(request.body.max_tokens, 64)
  } finally {
    delete process.env.SSE_BRIDGE_TEST_KEY
    await upstream.close()
  }
})

test('stream fails with MISSING_CREDENTIAL before any request is sent', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    delete process.env.SSE_BRIDGE_ABSENT_KEY
    const adapter = adapterFor(importConfig({ import: { apiKeyEnv: 'SSE_BRIDGE_ABSENT_KEY' } }, upstream))
    await assert.rejects(async () => collect(adapter.stream(userRequest())), (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      return true
    })
    assert.equal(upstream.requests.length, 0)
  } finally {
    await upstream.close()
  }
})

test('stream maps a 429 to RATE_LIMIT with a retry hint', async () => {
  const upstream = await startUpstream(() => ({
    status: 429,
    headers: { 'retry-after': '2' },
    body: JSON.stringify({ error: { message: 'slow down' } }),
  }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    await assert.rejects(async () => collect(adapter.stream(userRequest())), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.status, 429)
      assert.ok(error.failure.providerRetryAfterMs >= 1_000)
      assert.match(error.message, /slow down/)
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream maps a 401 to AUTH', async () => {
  const upstream = await startUpstream(() => ({ status: 401, body: '{"error":{"message":"bad key"}}' }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    await assert.rejects(async () => collect(adapter.stream(userRequest())), (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream surfaces tool calls with ids and argument deltas', async () => {
  const frames = [
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'read', arguments: '' } }] } }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    const chunks = await collect(adapter.stream(userRequest()))
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    assert.ok(deltas.length >= 2)
    assert.equal(deltas[0].id, 'call_x')
    assert.equal(deltas[0].name, 'read')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
    const blockEnd = chunks.filter((chunk) => chunk.type === 'block-end').at(-1)
    assert.equal(blockEnd.block.type, 'tool-call')
    assert.equal(blockEnd.block.arguments, '{"path":"a.txt"}')
  } finally {
    await upstream.close()
  }
})

test('stream maps reasoning fields to a reasoning block', async () => {
  const frames = [
    frame({ choices: [{ index: 0, delta: { reasoning_content: 'let me think' } }] }),
    frame({ choices: [{ index: 0, delta: { content: 'answer' } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames }))
  try {
    const chunks = await collect(adapterFor(importConfig({}, upstream)).stream(userRequest()))
    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
    assert.equal(reasoning, 'let me think')
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'answer')
    // Reasoning and text must not share a block index.
    const reasoningIndex = chunks.find((chunk) => chunk.type === 'reasoning-delta').index
    const textIndex = chunks.find((chunk) => chunk.type === 'text-delta').index
    assert.notEqual(reasoningIndex, textIndex)
  } finally {
    await upstream.close()
  }
})

test('stream accepts an alternate reasoning field name', async () => {
  const frames = [
    frame({ choices: [{ index: 0, delta: { thinking: 'hmm' } }] }),
    frame({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames }))
  try {
    const chunks = await collect(adapterFor(importConfig({}, upstream)).stream(userRequest()))
    assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'hmm')
  } finally {
    await upstream.close()
  }
})

test('stream rejects a truncated stream with no completion marker', async () => {
  const frames = [frame({ choices: [{ index: 0, delta: { content: 'partial' } }] })]
  const upstream = await startUpstream(() => ({ frames }))
  try {
    await assert.rejects(async () => collect(adapterFor(importConfig({}, upstream)).stream(userRequest())), (error) => {
      assert.equal(error.code, 'TRANSPORT')
      assert.match(error.message, /completion marker/)
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream rejects an empty response', async () => {
  const upstream = await startUpstream(() => ({ frames: ['data: [DONE]\n\n'] }))
  try {
    await assert.rejects(async () => collect(adapterFor(importConfig({}, upstream)).stream(userRequest())), (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream rejects a non-JSON SSE payload', async () => {
  const upstream = await startUpstream(() => ({ frames: ['data: <html>oops</html>\n\n'] }))
  try {
    await assert.rejects(async () => collect(adapterFor(importConfig({}, upstream)).stream(userRequest())), (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE')
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream surfaces an in-band error object', async () => {
  const frames = [
    frame({ error: { message: 'model overloaded', code: 'overloaded' } }),
    'data: [DONE]\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames }))
  try {
    await assert.rejects(async () => collect(adapterFor(importConfig({}, upstream)).stream(userRequest())), /model overloaded/)
  } finally {
    await upstream.close()
  }
})

test('stream falls back to a JSON body when the upstream does not stream', async () => {
  const upstream = await startUpstream(() => ({
    json: {
      choices: [{ index: 0, message: { role: 'assistant', content: 'whole answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  }))
  try {
    const chunks = await collect(adapterFor(importConfig({}, upstream)).stream(userRequest()))
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'whole answer')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  } finally {
    await upstream.close()
  }
})

test('stream reports a timeout instead of hanging', async () => {
  const upstream = await startUpstream(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    return { frames: openAITextFrames() }
  })
  try {
    const adapter = adapterFor(importConfig({ import: { connectTimeoutMs: 200 } }, upstream))
    await assert.rejects(async () => collect(adapter.stream(userRequest())), (error) => {
      assert.ok(['TIMEOUT', 'TRANSPORT'].includes(error.code))
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream aborts when the caller signal aborts', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(async () => collect(adapter.stream(userRequest({ signal: controller.signal }))), (error) => {
      assert.equal(error.code, 'ABORTED')
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('stream handles an Anthropic dialect upstream', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames: events }))
  try {
    const config = normalizeConfig({
      import: { route: 'r', displayName: 'R', baseURL: upstream.baseURL, dialect: 'anthropic' },
    }).import
    const chunks = await collect(adapterFor(config).stream(userRequest({ model: 'claude-like' })))
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hi there')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    assert.equal(upstream.requests[0].headers['anthropic-version'], '2023-06-01')
  } finally {
    await upstream.close()
  }
})

test('stream maps Anthropic tool_use blocks to tool-call deltas', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames: events }))
  try {
    const config = normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: upstream.baseURL, dialect: 'anthropic' } }).import
    const chunks = await collect(adapterFor(config).stream(userRequest({ model: 'claude-like' })))
    assert.equal(chunks.filter((chunk) => chunk.type === 'tool-call-delta')[0].id, 'toolu_1')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
  } finally {
    await upstream.close()
  }
})

test('a configured session header carries the request session id', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    const adapter = adapterFor(importConfig({ import: { sessionHeader: 'x-session', sendSessionHeader: true } }, upstream))
    await collect(adapter.stream(userRequest({ sessionId: 'session-42' })))
    assert.equal(upstream.requests[0].headers['x-session'], 'session-42')
  } finally {
    await upstream.close()
  }
})

test('extraBody overrides generated fields', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    const adapter = adapterFor(importConfig({ import: { extraBody: { top_p: 0.5, model: 'override' } } }, upstream))
    await collect(adapter.stream(userRequest()))
    assert.equal(upstream.requests[0].body.top_p, 0.5)
    assert.equal(upstream.requests[0].body.model, 'override')
  } finally {
    await upstream.close()
  }
})

test('a keepalive comment during a slow stream does not end it', async () => {
  const frames = [
    ': keep-alive\n\n',
    frame({ choices: [{ index: 0, delta: { content: 'slow' } }] }),
    ': keep-alive\n\n',
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
  const upstream = await startUpstream(() => ({ frames, delayMs: 20 }))
  try {
    const adapter = adapterFor(importConfig({ import: { streamIdleTimeoutMs: 2_000 } }, upstream))
    const chunks = await collect(adapter.stream(userRequest()))
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'slow')
  } finally {
    await upstream.close()
  }
})

test('prepareCall binds model metadata and a stream entry', async () => {
  const upstream = await startUpstream(() => ({ frames: openAITextFrames() }))
  try {
    const adapter = adapterFor(importConfig({}, upstream))
    const prepared = await adapter.prepareCall('test-route', 'model-a')
    assert.equal(prepared.model.id, 'model-a')
    assert.equal(prepared.model.provider, 'test-route')
    const chunks = await collect(prepared.stream(userRequest()))
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('normalizeConfig accepts a dormant row', () => {
  const config = normalizeConfig({})
  assert.equal(config.import, null)
  assert.equal(config.export, null)
})

test('normalizeConfig rejects invalid routes and URLs', () => {
  assert.throws(() => normalizeConfig({ import: { route: 'bad route', baseURL: 'http://x/v1' } }), SseBridgeConfigError)
  assert.throws(() => normalizeConfig({ import: { route: 'ok', baseURL: 'ftp://x' } }), /baseURL/)
  assert.throws(() => normalizeConfig({ import: { route: 'ok', baseURL: 'http://x/v1', requestPath: 'chat' } }), /requestPath/)
  assert.throws(() => normalizeConfig({ import: { route: 'ok', baseURL: 'http://x/v1', dialect: 'grpc' } }), /dialect/)
})

test('normalizeConfig validates export fields', () => {
  assert.throws(() => normalizeConfig({ export: { port: 70_000 } }), /port/)
  assert.throws(() => normalizeConfig({ export: { modelSource: 'static' } }), /modelSource is "static"/)
  const config = normalizeConfig({ export: { port: 0, basePath: 'v1/' } })
  assert.equal(config.export.port, 0)
  assert.equal(config.export.basePath, '/v1')
  assert.equal(config.export.host, '127.0.0.1')
})

test('normalizeConfig rejects duplicate model ids', () => {
  assert.throws(
    () => normalizeConfig({ import: { route: 'r', baseURL: 'http://x/v1', models: [{ id: 'a' }, { id: 'a' }] } }),
    /duplicated/,
  )
})

test('normalizeConfig rejects a config that disables both directions', () => {
  assert.throws(() => normalizeConfig({ import: false, export: false }), /both directions/)
})

test('normalizeConfig accepts the inbound alias for import', () => {
  const config = normalizeConfig({ inbound: { route: 'r', baseURL: 'http://x/v1' } })
  assert.equal(config.import.route, 'r')
})

test('normalizeConfig rejects an unknown input modality', () => {
  assert.throws(
    () => normalizeConfig({ import: { route: 'r', baseURL: 'http://x/v1', models: [{ id: 'a', input: ['audio'] }] } }),
    /must be "text" or "image"/,
  )
})
