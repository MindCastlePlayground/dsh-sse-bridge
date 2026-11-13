// DSH SSE bridge plugin entry.
//
// One Host row wires two directions:
//
//   import  an SSE-speaking upstream becomes a DSH model route   (llm adapter)
//   export  DSH model routes become an OpenAI-compatible SSE API (local HTTP)
//
// Both directions are optional and independent.  The package has no dependency
// on @deepseek-ai/* packages: everything it needs from DSH arrives through the
// Cordis context (`tools`, `llm`, `attachments`), which keeps a profile-local
// install working on Windows where ESM resolution into the DSH tree is fragile.

import { normalizeConfig, SseBridgeConfigError } from './lib/config.js'
import { SseBridge } from './lib/bridge.js'
import { registerBridgeTools } from './lib/tools.js'

export const name = 'sse-bridge'
export const inject = ['tools']

export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    const message = error instanceof SseBridgeConfigError ? error.message : String(error?.message ?? error)
    ctx.logger.error(`[sse-bridge] invalid configuration: ${message}`)
    throw error
  }

  if (config.import === null && config.export === null) {
    ctx.logger.info('[sse-bridge] neither direction is configured; plugin is dormant')
    return
  }

  const log = {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
    error: (message) => ctx.logger.error(message),
    trace: (event, detail) => {
      if (config.import?.trace === 'off' && config.export?.trace === 'off') return
      const text = detail === undefined ? '' : ` ${safeJSON(detail)}`
      ctx.logger.debug?.(`[sse-bridge] ${event}${text}`)
    },
  }

  const bridge = new SseBridge({ config, ctx, log })

  let toolsDisposer
  try {
    toolsDisposer = registerBridgeTools(ctx, bridge)
  } catch (error) {
    ctx.logger.error(`[sse-bridge] cannot register tools: ${String(error?.message ?? error)}`)
    throw error
  }

  // Activation must not block the Host: the export listener binds asynchronously
  // and the effect owns the teardown, so an unload during startup cannot leak a
  // listening socket.
  ctx.effect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      bridge.start().catch((error) => {
        ctx.logger.error(`[sse-bridge] start failed: ${String(error?.message ?? error)}`)
      })
    }, 50)
    timer.unref?.()

    return async () => {
      disposed = true
      clearTimeout(timer)
      try { toolsDisposer?.() } catch {}
      await bridge.stop()
    }
  }, 'sse-bridge: lifecycle')

  const summary = []
  if (config.import !== null) summary.push(`import -> ${config.import.route}`)
  if (config.export !== null) summary.push(`export -> ${config.export.host}:${config.export.port}${config.export.basePath}`)
  ctx.logger.info(`[sse-bridge] active: ${summary.join(', ')}`)

  return bridge
}

function safeJSON(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
  } catch {
    return String(value)
  }
}

export { normalizeConfig, SseBridgeConfigError, SseBridge }
