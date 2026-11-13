# DSH SSE Bridge

> **第一次使用？** 从 [QUICKSTART.md](../../QUICKSTART.md) 开始：三条复制命令式路径，分别覆盖导出到 opencode、导入一个 SSE 上游、以及双向互通。

一个 Cordis/DSH Host 插件，把 DSH 的模型能力和 SSE 协议在**两个方向**上接通：

| 方向 | 含义 | 结果 |
| --- | --- | --- |
| **export** | DSH 的模型 → OpenAI 兼容的 SSE 服务 | opencode、OpenAI SDK、任何 OpenAI 兼容客户端直接使用 DSH 里的模型 |
| **import** | 一个说 SSE 的上游 → DSH 模型路由 | 外部 SSE 服务出现在 DSH 的模型选择器里，和原生模型一样调用 |

两个方向互相独立，可以只开一个，也可以同时开。同时开启时，"导入的上游" 和 "导出的模型" 共用同一份目录，所以外部客户端可以直接摸到 DSH 里已有的任何路由——包括 `dsh-model-gateway` 注册的网关路由。

```
                  ┌──────────────────── DSH ────────────────────┐
opencode ──SSE──▶ │  export server ──▶ llm.stream ──▶ adapter   │
OpenAI SDK        │                                    │        │
                  │                                    ▼        │
                  │  import adapter ◀── llm.registerAdapter    │
                  └────────────────────┬────────────────────────┘
                                       │ SSE
                                       ▼
                                 上游模型服务
```

## 为什么是 SSE

SSE 是 OpenAI Chat Completions 的流式载体，也是 opencode、`@ai-sdk/openai-compatible`、各家 SDK 的默认路径。把 DSH 的这一层做对，就等于一次接通了几乎所有客户端，而不需要为每个客户端写一份适配。

桥接层因此把 SSE 当成唯一的线格式：

- `lib/sse.js` 同时实现**读**和**写**——解析器遵循 WHATWG 事件流语法（LF/CRLF/CR、BOM、注释、多行 `data:`、`event:`、`id:`、`retry:`、`[DONE]`），写入端保证每帧以空行结束、多行文本不破坏分帧；
- 解析器和写入端共用同一个模块，所以往返测试是真的往返，不是两边各自自洽。

## 安装

```bash
# 1. 让 DSH profile 认识这个包
dsh plugin install H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge
```

或者手工把它加进 profile 的 `package.json`：

```json
{
  "dependencies": { "@local/dsh-sse-bridge": "link:H:/Documents/Abyss/dsh-sse-bridge/packages/dsh-sse-bridge" },
  "dsh": { "profile": { "bundles": ["@local/dsh-sse-bridge"] } }
}
```

然后在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`（见下）。插件默认是 **dormant**（休眠）的：没有配置任何方向时不会监听端口、不会注册路由，只在日志里留一行说明。

## 配置

### 只做导出（最常见）

把 DSH 已有的模型暴露给 opencode：

```yaml
- id: sse-bridge
  config:
    export:
      port: 47190
      modelSource: catalog
      defaultModel: deepseek-v4.1-flash
      auth:
        apiKeyEnv: DSH_SSE_BRIDGE_KEY
```

`modelSource: catalog` 会镜像 DSH 自己的 provider 列表——包括 `dsh-model-gateway` 注册的路由——所以不用逐条抄模型。单路由的模型直接用裸 id（`deepseek-v4.1-flash`），多路由用 `<route>::<model>` 消歧。

### 只做导入

把一个 SSE 上游变成 DSH 路由：

```yaml
- id: sse-bridge
  config:
    import:
      route: my-upstream
      displayName: My Upstream
      baseURL: https://api.example.com/v1
      apiKeyEnv: MY_UPSTREAM_KEY
      discoverModels: true        # 从 GET /v1/models 拉目录
```

之后 `my-upstream` 会出现在 DSH 的模型路由里，`resolveModel`、`listModels`、流式分块、工具调用、用量统计都按 DSH 的约定执行。

### 双向

```yaml
- id: sse-bridge
  config:
    import:
      route: my-upstream
      baseURL: https://api.example.com/v1
      apiKeyEnv: MY_UPSTREAM_KEY
      models:
        - id: some-model
          contextWindow: 131072
          maxTokens: 8192
    export:
      port: 47190
```

此时 `export` 的目录里会包含 `my-upstream` 的路由，外部客户端可以经 DSH 访问它。

## 配置参考

### `import`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `route` | — | DSH 模型路由 id，必填，`[a-z0-9][a-z0-9_-]*` |
| `displayName` | `route` | 显示名 |
| `baseURL` | — | 上游基址，必填 |
| `requestPath` | `/chat/completions` | 拼接在 baseURL 后 |
| `modelsURL` | `/models` | `discoverModels` 时使用 |
| `dialect` | `openai` | `openai` 或 `anthropic` |
| `apiKeyEnv` / `apiKey` | — | 凭证；`apiKeyEnv` 优先 |
| `headers` | `{}` | 附加请求头 |
| `models` | `[]` | 显式模型表；为空且 `discoverModels` 时走发现 |
| `maxTokensField` | `max_tokens` | 或 `max_completion_tokens` |
| `reasoningFields` | `['reasoning_content','reasoning','reasoning_text','thinking']` | 依次尝试 |
| `extraBody` | `{}` | 合并进请求体，覆盖生成字段 |
| `sessionHeader` | — | 透传 DSH session id 的头名 |
| `connectTimeoutMs` | `30000` | 建连超时 |
| `streamIdleTimeoutMs` | `300000` | 流空闲超时 |
| `trace` | `off` | `off` / `summary` / `verbose` |

### `export`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `47190` | `0` 表示随机端口 |
| `basePath` | `/v1` | 路径前缀 |
| `modelSource` | `catalog` | `catalog` 镜像 DSH，`static` 用固定表 |
| `models` | `[]` | `static` 模式下的模型表 |
| `includeRoutes` | `[]` | 只暴露这些路由（空=全部） |
| `defaultModel` | — | 未指定模型时的默认 |
| `auth.apiKey` / `auth.apiKeyEnv` | — | 设了就要 Bearer / `x-api-key` |
| `auth.allowLoopbackWithoutKey` | `true` | 回环地址免鉴权 |
| `cors.origins` | `['*']` | 允许的来源 |
| `sse.keepAliveMs` | `15000` | 注释帧间隔 |
| `limits.maxBodyBytes` | `8388608` | 请求体上限 |
| `limits.maxConcurrent` | `8` | 并发上限，超出 429 |
| `limits.requestTimeoutMs` | `600000` | 单请求总超时 |

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/health` | 运行状态与计数 |
| `GET` | `/v1/models` | 模型列表（OpenAI 形状） |
| `POST` | `/v1/chat/completions` | 流式与非流式 |

同时接受不带 `/v1` 前缀的 `/health`、`/models`、`/chat/completions`，方便把 `baseURL` 配成 `http://127.0.0.1:47190` 而不带路径。

## opencode 接入

`opencode.json`：

```json
{
  "provider": {
    "dsh-bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DSH SSE Bridge",
      "options": {
        "baseURL": "http://127.0.0.1:47190/v1",
        "apiKey": "dsh-bridge-local"
      },
      "models": {
        "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash (via DSH bridge)" }
      }
    }
  }
}
```

```bash
opencode models                     # 应能看到 dsh-bridge/deepseek-v4.1-flash
opencode run --model dsh-bridge/deepseek-v4.1-flash 'Reply with exactly: opencode ok'
```

已实测：文本、工具调用（`read`）、多轮工具结果回传都正常。

## 工具

插件注册三个面向模型的工具：

- **`sse_bridge_status`** — 两个方向各自的运行状态、计数、最近错误；
- **`sse_bridge_models`** — 对外暴露的模型及其映射到的 DSH 路由（用来配 opencode 不用猜 id）；
- **`sse_bridge_selftest`** — 通过真实监听端口发一次流式请求，报告帧数、文本、结束原因、用量、耗时。

`selftest` 走的是 HTTP 而不是内部函数调用，所以它验证的正是外部客户端会走的路径。

## 错误语义

导入方向的失败被映射成 DSH 认识的错误码，而不是裸的 `fetch` 异常：

| 上游状况 | 错误码 |
| --- | --- |
| 401 / 403 | `AUTH` |
| 429 | `RATE_LIMIT`（带 `providerRetryAfterMs`） |
| 超时 | `TIMEOUT` |
| 5xx | `SERVER` |
| 400 / 422 | `INVALID_REQUEST` |
| 流被截断（无 `[DONE]`） | `TRANSPORT` |
| 流里没有任何内容 | `EMPTY_RESPONSE` |
| 非 JSON 的 SSE 载荷 | `INVALID_RESPONSE` |

导出方向则把模型侧的失败写成**流内的 error 帧**（HTTP 200 已经发出去了，不能改状态码），然后照常发 `[DONE]`，这样客户端不会卡在半个流上。

## 设计取舍

- **不 import 任何 `@deepseek-ai/*` 包。** 需要的一切（`llm`、`tools`、`attachments`）都从 Cordis context 取。Windows 上 profile 内的 ESM 包解析进 DSH 目录并不可靠，绕开它是稳的。
- **适配器靠鸭子类型。** 不需要继承基类，`ctx.llm.registerAdapter()` 只校验形状。这让插件可以独立于 DSH 的发布节奏。
- **导出服务器接受注入的 `stream` / `listModels` / `resolveRoute`。** 于是它可以在没有 DSH 的情况下被完整测试——测试里的 `llm` 是一个忠实于真实契约的替身。
- **assistant / tool 消息必须带 `source`。** DSH 的 `LlmRuntime.forAdapter` 会对每条 assistant 消息解引用 `message.source`；少这个字段，**第二轮**（工具结果回传时）就会抛 `Cannot read properties of undefined (reading 'replayState')`。导出侧因此给 assistant 消息补 `source: {kind:'model', provider, model}`，给 tool 消息补 `source: {kind:'tool', callId}`。这是一个真实踩到的坑，已固化为回归测试。
- **图片走附件服务。** 行内 `data:` 图片先经 `attachments.saveImages()` 变成 DSH 的 `image` block；没有附件服务时降级为文本说明，而不是让整个请求失败。
- **休眠优先。** 没配置就不做事。一个装错位置的插件不应该占用端口或污染日志。

## 测试

```bash
node --test --test-timeout=30000 "test/*.test.mjs"
```

134 项，覆盖：

- SSE 语法（分块边界、CRLF 跨块、BOM、多字节字符、注释、`[DONE]`、中止）；
- DSH 分块 ↔ wire 分块（文本、推理、工具调用、用量、各种结束原因）；
- 导入适配器对真实 SSE 上游（文本、工具调用、推理、错误映射、超时、中止、Anthropic 方言、凭证缺失）；
- 导出服务器的路由、鉴权、CORS、并发、限流、背压、断连、非流式；
- 双向串联与三个工具；
- 回归：assistant 消息必须带 `source`（否则工具回传第二轮崩溃）。

对真实模型的验证：

```bash
node scripts/verify.mjs --upstream http://127.0.0.1:47180/v1 --model deepseek-v4.1-flash
```

## 已知边界

- 只实现 OpenAI Chat Completions 与 Anthropic Messages 两种方言；其他协议请在自己的服务里翻译。
- `export` 目前是明文 HTTP，没有 TLS。要对外暴露请放到反向代理后面。
- 一个配置行对应一个导入路由；要多条请插入多行（每行一个 `id`）。
- 没有 Web 设置页，配置走 Cordis patch。
