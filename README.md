# DSH SSE Bridge

> **第一次使用？** 从 [QUICKSTART.md](QUICKSTART.md) 开始。

用 SSE 把 DSH 和外部世界接通——**两个方向都通**。

- **export**：DSH 里的模型变成 OpenAI 兼容的 SSE 服务，opencode、OpenAI SDK、任何 OpenAI 兼容客户端直接可用。
- **import**：一个说 SSE 的上游变成 DSH 的模型路由，在 DSH 里像原生模型一样用。

两个方向互相独立。同时开启时共用一份模型目录，所以外部客户端能摸到 DSH 里已有的任何路由。

## 仓库结构

```
packages/
  dsh-sse-bridge/            # 插件本体 + 测试 + 验证脚本
```

## 快速开始

```bash
# 让 profile 认识这个包
dsh plugin install H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge
```

然后在 profile 的 `cordis.patch.yml` 里配置一个方向：

```yaml
- id: sse-bridge
  config:
    export:
      port: 47190
      modelSource: catalog
```

重启 DSH，`http://127.0.0.1:47190/v1/models` 就能列出你的模型了。

完整的三条路径（导出 / 导入 / 双向）见 [QUICKSTART.md](QUICKSTART.md)；协议细节、配置参考、错误语义见 [插件 README](packages/dsh-sse-bridge/README.md)。

## 验证

```bash
cd packages/dsh-sse-bridge
node --test --test-timeout=30000 "test/*.test.mjs"     # 134 项单元/集成测试
node scripts/verify.mjs --upstream http://127.0.0.1:47180/v1 --model deepseek-v4.1-flash
```

已实测的端到端路径：

- **真实 DSH 进程内**：插件通过 `dsh plugin add` 装进 profile，DSH loader 组合出 `sse-bridge` 行；`/v1/models` 同时列出 DSH 原生路由（`deepseek-official::*`）与桥接导入的路由；流式与非流式请求都经 DSH 的 `llm.stream()` 完成，0 错误。
- 真实模型（`deepseek-v4.1-flash`，经本地 OpenCode Go 网关）在两个方向上完成往返，文本、推理、用量都正确。
- **opencode v2.2.7** 通过 `@ai-sdk/openai-compatible` 接入本桥：`opencode models` 能列出模型，`opencode run` 能出结果，**多轮工具调用（Glob → Read → 回答）正常往返**。

## 设计要点

- **SSE 是唯一线格式。** 读写共用一个模块（`lib/sse.js`），所以往返测试是真往返。解析器遵循 WHATWG 事件流语法：LF/CRLF/CR、BOM、注释帧、多行 `data:`、`event:`/`id:`/`retry:`、`[DONE]`。
- **不 import 任何 `@deepseek-ai/*` 包。** `llm`、`tools`、`attachments` 全部从 Cordis context 取，避开 Windows 上 profile 内 ESM 解析进 DSH 目录的坑。
- **适配器靠鸭子类型。** 不需要继承，`registerAdapter()` 只校验形状，插件因此不绑定 DSH 的发布节奏。
- **导出服务器可注入依赖。** `stream` / `listModels` / `resolveRoute` 都是注入的，所以能在没有 DSH 的情况下完整测试。
- **assistant / tool 消息带 `source`。** DSH 的 `forAdapter` 会对每条 assistant 消息解引用 `source`，缺了它工具回传的第二轮就崩。这一点是实测踩出来的，已加回归测试。
- **休眠优先。** 没配置任何方向就不监听端口、不注册路由，只留一行日志。

## 范围与限制

- 支持 OpenAI Chat Completions 与 Anthropic Messages 两种方言；其他协议请在自有服务里翻译。
- `export` 是明文 HTTP，对外暴露请放到反向代理后面。
- 一个配置行对应一个导入路由，多条路由请插入多行。
- 没有 Web 设置页，配置走 Cordis patch。
