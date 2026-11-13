// Model-facing diagnostics and control tools for the SSE bridge.
//
// The tools return compact, schema-stable JSON rather than the full runtime
// snapshot: a broken route should be diagnosable from the transcript without
// leaking credentials, prompts, or unbounded logs.

const renderJSON = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const statusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    import: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: { type: 'string' },
        displayName: { type: 'string' },
        baseURL: { type: 'string' },
        dialect: { type: 'string' },
        modelCount: { type: 'number' },
        credentialConfigured: { type: 'boolean' },
        registered: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    export: {
      type: 'object',
      additionalProperties: false,
      properties: {
        running: { type: 'boolean' },
        origin: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        basePath: { type: 'string' },
        modelSource: { type: 'string' },
        authRequired: { type: 'boolean' },
        activeRequests: { type: 'number' },
        requests: { type: 'number' },
        streams: { type: 'number' },
        errors: { type: 'number' },
        bytes: { type: 'number' },
        uptimeMs: { type: 'number' },
        error: { type: 'string' },
      },
    },
  },
}

export function registerBridgeTools(ctx, bridge) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'sse_bridge_status',
    description: 'Report the DSH SSE bridge: which imported SSE upstreams are registered as model routes, and whether the OpenAI-compatible SSE export server is listening, on which URL, with which auth and traffic counters. Use this first when an external client cannot reach DSH models or an imported route fails.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: statusSchema, render: renderJSON },
    async execute() {
      return bridge.status()
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'sse_bridge_models',
    description: 'List the models the SSE bridge exposes to external clients, with the DSH provider route and model id each one maps to. Use this to build or debug an opencode / OpenAI-SDK provider configuration without guessing model ids.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['models'],
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'provider', 'model'],
              properties: {
                id: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                name: { type: 'string' },
                contextWindow: { type: 'number' },
                maxTokens: { type: 'number' },
              },
            },
          },
        },
      },
      render: renderJSON,
    },
    async execute() {
      return { models: await bridge.listExportedModels() }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'sse_bridge_selftest',
    description: 'Send one real streaming request through the SSE export server to a DSH model route and report the SSE frames it received, the assembled text, finish reason, usage and latency. Verifies the whole outbound path — HTTP, SSE framing, DSH llm streaming — without needing an external client.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', description: 'Exported model id. Defaults to the configured default model.' },
        prompt: { type: 'string', description: 'User prompt. Defaults to a short connectivity check.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          route: { type: 'string' },
          url: { type: 'string' },
          text: { type: 'string' },
          reasoning: { type: 'string' },
          finishReason: { type: 'string' },
          frames: { type: 'number' },
          toolCalls: { type: 'number' },
          usage: { type: 'string' },
          elapsedMs: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: renderJSON,
    },
    async execute(args) {
      return bridge.selftest({ model: args?.model, prompt: args?.prompt })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}
