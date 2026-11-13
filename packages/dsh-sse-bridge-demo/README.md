# DSH SSE Bridge — Demo Bundle

一个可安装的示例：装完就有可用的 SSE 端点，不用手改 YAML。

它做的事只有一件——插入一个已经配好的 `sse-bridge` 行：

```yaml
- insert:
    - id: sse-bridge-example
      name: '@local/dsh-sse-bridge'
      config:
        export:
          port: 47190
          modelSource: catalog
```

安装后 DSH 会提供：

| 方法 | 路径 |
| --- | --- |
| `GET` | `http://127.0.0.1:47190/v1/health` |
| `GET` | `http://127.0.0.1:47190/v1/models` |
| `POST` | `http://127.0.0.1:47190/v1/chat/completions` |

`modelSource: catalog` 会镜像 DSH 已有的全部模型路由，所以这里不需要写模型列表。

回环地址默认免鉴权；非回环调用需要设置 `DSH_SSE_BRIDGE_KEY`。

## 安装

```powershell
dsh plugin install H:\Documents\Abyss\dsh-sse-bridge\packages\dsh-sse-bridge-demo
```

注意先装框架包 `packages/dsh-sse-bridge` 这个依赖。

## 验证

```powershell
curl.exe http://127.0.0.1:47190/v1/health
curl.exe http://127.0.0.1:47190/v1/models
```

opencode 侧配置见 [QUICKSTART 路径 A](../../QUICKSTART.md)。

## 想改端口或模型范围

不要改这个包，改你自己的 profile patch —— 覆盖 `sse-bridge-example` 行的 `config` 即可：

```yaml
- id: sse-bridge-example
  config:
    export:
      port: 47191
      includeRoutes:
        - gateway-opencode-go
```
