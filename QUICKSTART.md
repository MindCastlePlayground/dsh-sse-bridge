# QUICKSTART

三条复制命令式路径。选一条，做完就能用。

前提：DSH 已安装、能正常启动；`H:\Documents\Abyss\dsh-sse-bridge` 存在。

---

## 路径 A：把 DSH 的模型导出给 opencode

**最适合第一次试。** 不用凭证，不用上游，只需要 DSH 里已经能用的模型。

### 1. 安装插件

```powershell
dsh plugin install H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge
```

等价于把这两项写进 `C:\Users\<你>\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": {
    "@local/dsh-sse-bridge": "link:H:/Documents/Abyss/dsh-sse-bridge/packages/dsh-sse-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-sse-bridge"]
    }
  }
}
```

### 2. 配置导出

编辑 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`，追加：

```yaml
- id: sse-bridge
  config:
    export:
      port: 47190
      modelSource: catalog
```

`modelSource: catalog` 会镜像 DSH 当前的所有模型路由，包括 `dsh-model-gateway` 注册的那些。

### 3. 重启 DSH，确认在听

```powershell
curl.exe http://127.0.0.1:47190/v1/health
curl.exe http://127.0.0.1:47190/v1/models
```

`/v1/models` 里出现的 id 就是外部客户端可以用的模型 id。单路由是裸 id（`deepseek-v4.1-flash`），多路由是 `<route>::<model>`。

### 4. 让 opencode 用它

在项目目录建 `opencode.json`：

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

```powershell
opencode models
opencode run --model dsh-bridge/deepseek-v4.1-flash "Reply with exactly: opencode ok"
```

期望输出：`opencode ok`。

顺手验一下工具调用：

```powershell
opencode run --model dsh-bridge/deepseek-v4.1-flash "Read packages/dsh-sse-bridge/package.json and print the version field."
```

---

## 路径 B：把一个 SSE 上游导入 DSH

### 1. 安装插件

同路径 A 第 1 步。

### 2. 配置导入

```yaml
- id: sse-bridge
  config:
    import:
      route: my-upstream
      displayName: My Upstream
      baseURL: https://api.example.com/v1
      apiKeyEnv: MY_UPSTREAM_KEY
      discoverModels: true
      models:
        - id: some-model
          name: Some Model
          contextWindow: 131072
          maxTokens: 8192
```

把 `MY_UPSTREAM_KEY` 放进 DSH 的启动环境：

```powershell
[Environment]::SetEnvironmentVariable('MY_UPSTREAM_KEY', 'sk-...', 'User')
```

### 3. 重启 DSH，选模型

`my-upstream` 会出现在 DSH 的模型路由里。选 `some-model`（或 `discoverModels` 拉到的任意模型）开始对话即可。

**验证导入是否真的通了**，不依赖界面：

```powershell
cd H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge
node scripts/verify.mjs --upstream https://api.example.com/v1 --model some-model
```

期望以 `[verify] PASS` 结尾。

---

## 路径 C：双向互通

一个上游既是 DSH 的模型，又能被外部客户端经 DSH 访问。

```yaml
- id: sse-bridge
  config:
    import:
      route: my-upstream
      displayName: My Upstream
      baseURL: https://api.example.com/v1
      apiKeyEnv: MY_UPSTREAM_KEY
      models:
        - id: some-model
          contextWindow: 131072
          maxTokens: 8192
    export:
      port: 47190
      modelSource: catalog
```

重启后：

```powershell
curl.exe http://127.0.0.1:47190/v1/models
```

应该能看到 `my-upstream::some-model`（因为此时不止一个路由，id 会带上路由前缀）以及 DSH 的其他模型。opencode 侧按路径 A 第 4 步配，模型名换成带前缀的那个。

---

## 不用 DSH 也能先验一遍

想确认桥接本身没问题，而不是怀疑配置：

```powershell
cd H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge

# 单元 + 集成测试
node --test --test-timeout=30000 "test/*.test.mjs"

# 拿一个真实上游做端到端往返
node scripts/verify.mjs --upstream http://127.0.0.1:47180/v1 --model deepseek-v4.1-flash

# 起一个常驻的导出服务给 opencode 用（Ctrl+C 退出）
node scripts/verify.mjs --upstream http://127.0.0.1:47180/v1 --model deepseek-v4.1-flash --serve 47190
```

---

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `curl /v1/health` 连不上 | 插件没激活 | 检查 `cordis.patch.yml` 的 `id: sse-bridge` 行；看 DSH 日志里有没有 `[sse-bridge] active:` |
| 日志里 `plugin is dormant` | 两个方向都没配 | 至少配一个 `import` 或 `export` |
| `/v1/models` 是空的 | `modelSource: catalog` 但 DSH 没有可用路由 | 先用 DSH 界面确认有模型；或改用 `modelSource: static` 显式列出 |
| opencode 报 404 model not found | 模型 id 不对 | 用 `/v1/models` 的真实 id；多路由要带 `<route>::` 前缀 |
| opencode 报 401 | 配了 `auth` 但客户端没带 key | 客户端加 `apiKey`，或设 `auth.allowLoopbackWithoutKey: true` |
| 导入路由调用失败 | 上游凭证/地址问题 | `sse_bridge_status` 看 `import.error`；`resolveModel` 是纯本地的不需要网络 |
| 流卡住不动 | 上游不返回 `[DONE]` | 桥会按 `streamIdleTimeoutMs` 超时并报 `TRANSPORT` |
| 端口被占 | 47190 已被用 | 换端口，或设 `port: 0` 用随机端口 |

更多信息用 DSH 里的工具直接问：

- `sse_bridge_status` — 两个方向的状态与计数；
- `sse_bridge_models` — 对外暴露的模型及映射；
- `sse_bridge_selftest` — 经真实监听端口发一次流式请求并报告结果。
