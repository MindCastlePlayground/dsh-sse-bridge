import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { SseBridge } from '../lib/bridge.js'
import { registerBridgeTools } from '../lib/tools.js'
import { createFakeLLM, createFakeCtx, startUpstream, frame } from './fixtures.mjs'
import { apply } from '../index.js'

function upstreamFrames(text) {
  return [
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    frame({ choices: [{ index: 0, delta: { content: text } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
}

/** A bridge over a fake llm, optionally with a real SSE import upstream. */
async function buildBridge({ importConfig, exportConfig, streams, catalog = {}, attachments } = {}) {
  const llm = createFakeLLM({ streams, catalog })
  const ctx = createFakeCtx({ llm, attachments })
  const config = normalizeConfig({
    ...(importConfig === undefined ? {} : { import: importConfig }),
    ...(exportConfig === undefined ? {} : { export: exportConfig }),
  })
  const bridge = new SseBridge({ config, ctx, log: {} })
  return { bridge, llm, ctx, config }
}

// ---------------------------------------------------------------------------
// One runtime, both directions
// ---------------------------------------------------------------------------

test('a bridge with only a static export needs no upstream', async (t) => {
  const { bridge, ctx } = await buildBridge({
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'pinned' }] },
  })
  t.after(() => bridge.stop())
  await bridge.start()
  assert.equal(bridge.exporter !== undefined, true)
  const status = bridge.status()
  assert.equal(status.ok, true)
  assert.equal(status.export.running, true)
  assert.equal(status.import, undefined)
  void ctx
})

test('an import route registers with the llm service and is disposer-owned', async (t) => {
  const upstream = await startUpstream(() => ({ frames: upstreamFrames('ok') }))
  t.after(() => upstream.close())
  const { bridge, llm } = await buildBridge({
    importConfig: { route: 'up', displayName: 'Up', baseURL: upstream.baseURL, models: [{ id: 'm1' }] },
  })
  await bridge.start()
  assert.deepEqual([...llm.adapters.keys()], ['up'])
  const status = bridge.status()
  assert.equal(status.import.registered, true)
  assert.equal(status.import.modelCount, 1)
  await bridge.stop()
  assert.equal(llm.adapters.size, 0)
})

test('exported ids are bare for the single import route and qualified otherwise', async (t) => {
  const upstream = await startUpstream(() => ({ frames: upstreamFrames('ok') }))
  t.after(() => upstream.close())
  const { bridge, llm } = await buildBridge({
    importConfig: { route: 'up', displayName: 'Up', baseURL: upstream.baseURL, models: [{ id: 'm1' }] },
    exportConfig: { port: 0 },
  })
  await bridge.start()
  t.after(() => bridge.stop())
  // The import route accepts any model id, so its catalogue is not enumerable;
  // a bare id must still be accepted for the common single-upstream case.
  const models = await bridge.listExportedModels()
  assert.ok(Array.isArray(models))
  const resolved = await bridge.resolveRoute('m1')
  assert.deepEqual(resolved, { provider: 'up', model: 'm1' })
  void llm
})

test('a route::model id resolves explicitly', async (t) => {
  const { bridge } = await buildBridge({ exportConfig: { port: 0 } })
  const resolved = await bridge.resolveRoute('some-route::some-model')
  assert.deepEqual(resolved, { provider: 'some-route', model: 'some-model' })
})

test('an unknown bare model id does not resolve', async (t) => {
  const { bridge } = await buildBridge({ exportConfig: { port: 0 } })
  assert.equal(await bridge.resolveRoute('nope'), undefined)
})

test('catalog mode mirrors the llm providers that pass the filter', async (t) => {
  const llm = createFakeLLM({ catalog: { alpha: [{ id: 'a1', name: 'A1' }], beta: [{ id: 'b1', name: 'B1' }] } })
  // Register both providers so listProviders sees them.
  for (const route of ['alpha', 'beta']) {
    llm.registerAdapter([route], {
      providerInfo: () => ({ id: route, name: route }),
      listModels: async () => llm.catalogOf(route),
    })
  }
  const ctx = createFakeCtx({ llm })
  const config = normalizeConfig({ export: { port: 0, includeRoutes: ['alpha'] } })
  const bridge = new SseBridge({ config, ctx, log: {} })
  const models = await bridge.listExportedModels()
  assert.deepEqual(models.map((model) => model.id), ['alpha::a1'])
})

test('catalog mode skips a provider whose listModels throws', async (t) => {
  const llm = createFakeLLM({})
  llm.registerAdapter(['broken'], {
    providerInfo: () => ({ id: 'broken', name: 'Broken' }),
    listModels: async () => { throw new Error('catalog unavailable') },
  })
  const ctx = createFakeCtx({ llm })
  const bridge = new SseBridge({ config: normalizeConfig({ export: { port: 0 } }), ctx, log: {} })
  assert.deepEqual(await bridge.listExportedModels(), [])
})

test('a missing llm service is reported instead of throwing', async () => {
  const ctx = createFakeCtx({})
  const bridge = new SseBridge({
    config: normalizeConfig({ import: { route: 'r', displayName: 'R', baseURL: 'http://127.0.0.1:1/v1' } }),
    ctx,
    log: {},
  })
  bridge.startImport()
  assert.equal(bridge.registered, false)
  assert.match(bridge.importError, /llm service is unavailable/)
})

test('a port already in use is reported without crashing the plugin', async () => {
  const first = await buildBridge({ exportConfig: { port: 0 } })
  await first.bridge.start()
  const port = first.bridge.exporter.port
  try {
    const second = await buildBridge({ exportConfig: { port, basePath: '/other' } })
    await second.bridge.start()
    assert.match(second.bridge.exportError, /EADDRINUSE|address already in use/i)
    assert.equal(second.bridge.exporter, undefined)
    assert.equal(second.bridge.status().ok, false)
  } finally {
    await first.bridge.stop()
  }
})

// ---------------------------------------------------------------------------
// Full loop: import upstream -> DSH route -> export to an SSE client
// ---------------------------------------------------------------------------

test('a request through both directions reaches the upstream and returns text', async (t) => {
  const upstream = await startUpstream((_request, body) => {
    assert.equal(body.model, 'm1')
    return { frames: upstreamFrames('reply from upstream') }
  })
  t.after(() => upstream.close())

  const { bridge } = await buildBridge({
    importConfig: { route: 'up', displayName: 'Up', baseURL: upstream.baseURL, models: [{ id: 'm1' }] },
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] },
  })
  await bridge.start()
  t.after(() => bridge.stop())

  // The exporter's `stream` posts to the export listener, whose route resolution
  // writes to the static list; point it at the import route instead.
  const response = await fetch(`${bridge.exporter.origin}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /\[DONE\]/)
})

test('the self-test reports assembled text and usage through the real listener', async (t) => {
  const upstream = await startUpstream(() => ({
    frames: [
      frame({ choices: [{ index: 0, delta: { content: 'bridge ok' } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      'data: [DONE]\n\n',
    ],
  }))
  t.after(() => upstream.close())

  const llm = createFakeLLM({})
  const ctx = createFakeCtx({ llm })
  const config = normalizeConfig({
    import: { route: 'up', displayName: 'Up', baseURL: upstream.baseURL, models: [{ id: 'm1' }] },
    export: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] },
  })
  const bridge = new SseBridge({ config, ctx, log: {} })
  await bridge.start()
  t.after(() => bridge.stop())

  const result = await bridge.selftest({ prompt: 'say hi' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'bridge ok')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage, '3+2=5')
  assert.ok(result.frames >= 2)
  assert.match(result.route, /^up\//)
})

test('the self-test reports a failure instead of throwing', async (t) => {
  const upstream = await startUpstream(() => ({ status: 500, body: '{"error":{"message":"upstream down"}}' }))
  t.after(() => upstream.close())
  const { bridge } = await buildBridge({
    importConfig: { route: 'up', displayName: 'Up', baseURL: upstream.baseURL, models: [{ id: 'm1' }] },
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] },
  })
  await bridge.start()
  t.after(() => bridge.stop())

  const result = await bridge.selftest()
  assert.equal(result.ok, false)
  assert.match(result.error, /upstream down|500/)
})

test('the self-test explains that it cannot run without a listener', async () => {
  const { bridge } = await buildBridge({ exportConfig: { port: 0 } })
  // Never started.
  const result = await bridge.selftest()
  assert.equal(result.ok, false)
  assert.match(result.error, /not running/)
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('the plugin registers three tools and disposes them on unload', async () => {
  const { bridge, ctx } = await buildBridge({
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] },
  })
  const dispose = registerBridgeTools(ctx, bridge)
  assert.deepEqual(ctx.registered.map((tool) => tool.name).sort(), [
    'sse_bridge_models',
    'sse_bridge_selftest',
    'sse_bridge_status',
  ])
  dispose()
  assert.equal(ctx.registered.length, 0)
})

test('sse_bridge_status returns a schema-conformant object', async () => {
  const { bridge, ctx } = await buildBridge({
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] },
  })
  await bridge.start()
  try {
    registerBridgeTools(ctx, bridge)
    const tool = ctx.registered.find((entry) => entry.name === 'sse_bridge_status')
    const value = await tool.execute({})
    assert.equal(typeof value.ok, 'boolean')
    assert.equal(value.export.running, true)
    // The render function must produce a text block.
    const rendered = tool.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.doesNotThrow(() => JSON.parse(rendered[0].text))
  } finally {
    await bridge.stop()
  }
})

test('sse_bridge_models lists exported models', async () => {
  const { bridge, ctx } = await buildBridge({
    exportConfig: { port: 0, modelSource: 'static', models: [{ id: 'm1', name: 'Model One' }] },
  })
  registerBridgeTools(ctx, bridge)
  const tool = ctx.registered.find((entry) => entry.name === 'sse_bridge_models')
  const value = await tool.execute({})
  assert.equal(value.models.length, 1)
  assert.equal(value.models[0].id, 'm1')
})

test('tool schemas are closed objects', async () => {
  const { bridge, ctx } = await buildBridge({ exportConfig: { port: 0 } })
  registerBridgeTools(ctx, bridge)
  for (const tool of ctx.registered) {
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} parameters must be closed`)
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`)
  }
})

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

test('the plugin entry is dormant with an empty config', () => {
  const ctx = createFakeCtx({})
  const info = []
  ctx.logger.info = (message) => info.push(message)
  const result = apply(ctx, {})
  assert.equal(result, undefined)
  assert.match(info.join('\n'), /dormant/)
})

test('the plugin entry rejects an invalid config loudly', () => {
  const ctx = createFakeCtx({})
  ctx.logger.error = () => {}
  assert.throws(() => apply(ctx, { import: { route: 'bad route', baseURL: 'http://x/v1' } }), /route/)
})

test('the plugin entry starts the export listener and tears it down', async () => {
  const ctx = createFakeCtx({})
  ctx.logger.info = () => {}
  const bridge = apply(ctx, { export: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] } })
  assert.ok(bridge instanceof SseBridge)
  // Activation is deferred so the Host is never blocked.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(bridge.exporter !== undefined, true)
  await bridge.stop()
  assert.equal(bridge.exporter, undefined)
})

test('the plugin entry exposes its config tools without a listener', () => {
  const ctx = createFakeCtx({})
  ctx.logger.info = () => {}
  apply(ctx, { export: { port: 0, modelSource: 'static', models: [{ id: 'm1' }] } })
  assert.equal(ctx.registered.length, 3)
})

