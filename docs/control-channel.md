# Haos 控制通道与 DSH 工具

> 版本：v1  
> 对应实现：`server/src/control-hub.mjs`、`integrations/dsh-haos/lib/index.js`  
> 架构原则：**插件是唯一接入路径，无 sidecar**。插件负责注册/心跳/控制/session 事件/工具，并在 profile 有 web server 时内嵌 WEB Tunnel。

## 1. 目的

Tunnel 解决“Haos 怎么访问 DSH 的 WEB”；控制通道解决“Haos 和 DSH 怎么持续沟通”。

控制通道为后续能力提供基础：

- 实例状态、能力、诊断；
- 远程命令（重启 WEB、重连 Tunnel、发通知）；
- 事件上报（DSH 结果、错误、项目动态）；
- 后续项目、记忆、自动化、任务下发；
- 插件工具（DSH 主动调用 Haos API）。

## 2. 拓扑

```text
Haos 控制面
  ├─ /api/plugin/v1/stream   ← 控制通道 WSS（Agent 主动出站）
  ├─ /api/plugin/v1/tunnel   ← WEB 反向 Tunnel WSS
  └─ /api/plugin/v1/*        ← 注册 / 心跳 / instance / events / notify

Agent / in-process 插件（DSH 机器）
  ├─ ControlClient  → 注册、心跳、命令、事件
  ├─ TunnelClient   → dsh-web HTTP/WS 流
  └─ WebSurface     → 启动/复用 dsh-web

DSH 插件 dsh-haos（已实现）
  ├─ 在 DSH 进程内运行 ControlClient / 事件订阅
  ├─ 复用当前 web server（webServer + connection.authenticatedUrl）
  ├─ 内嵌 TunnelClient
  ├─ 设置页、Haos 工具
  └─ 会话 / LLM / 工具事件 → Haos


```

## 3. 连接

```http
GET /api/plugin/v1/stream
Authorization: Bearer haos_itk_...
X-Haos-Protocol: 1
X-Haos-Instance: ins_...
```

服务端通过实例令牌识别实例；连接替换旧连接。

握手：

```json
{
  "type": "hello",
  "protocol": 1,
  "instanceId": "ins_...",
  "serverTime": "2026-11-08T06:00:00.000Z",
  "commands": ["ping", "status", "diagnostics", "web.restart", "web.close", "web.open", "tunnel.reconnect", "notify", "echo"]
}
```

Agent 立刻发送 `ready`：

```json
{
  "type": "ready",
  "v": 1,
  "version": "0.1.0",
  "platform": "darwin-arm64",
  "hostname": "dev-mac",
  "workspaceRoot": "/Users/me/.haos/workspace",
  "capabilities": ["web", "tunnel", "commands", "diagnostics", "notify", "workspace"],
  "web": {"status": "ready", "port": 30812, "path": "/w/ins_.../", "transport": "tunnel"}
}
```

## 4. 帧

### 4.1 Agent → Haos

| 类型 | 说明 |
| --- | --- |
| `ready` | 上线，上报版本、能力、WEB、工作区 |
| `heartbeat` | 20s 心跳，更新状态/能力/WEB |
| `event` | 结构化事件；`kind` + `payload` |
| `command.result` | `{id, ok, result?, error?}` |
| `notification.ack` | 可选，确认收到通知 |

### 4.2 Haos → Agent

| 类型 | 说明 |
| --- | --- |
| `hello` | 连接建立、协议版本、支持命令 |
| `command` | `{id, kind, payload, issuedAt}` |
| `notification` | 预留：服务端主动通知（当前通过 command notify 实现） |

## 5. 命令目录

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `ping` | 可访问实例 | 返回 pong、instanceId、时间 |
| `status` | 可访问实例 | 实例 ID、版本、运行时长、WEB、Tunnel、控制通道 |
| `diagnostics` | 可访问实例 | Node 版本、平台、PID、workspace、端口、配置（不含令牌） |
| `notify` | 可访问实例 | 在 Agent 日志记录通知，并回报事件；Haos 同时记录 |
| `web.restart` | 实例主人/管理员 | 重启托管 dsh-web |
| `web.close` | 实例主人/管理员 | 关闭托管 dsh-web |
| `web.open` | 实例主人/管理员 | 重新启动托管 dsh-web |
| `tunnel.reconnect` | 实例主人/管理员 | 重建 WEB 反向 Tunnel |
| `echo` | 可访问实例 | 联调回显 |

> 权限在 Haos 服务端校验；前端隐藏危险按钮只是体验优化。

## 6. 事件目录

| 事件 | 来源 | 说明 |
| --- | --- | --- |
| `agent.ready` | Agent | 控制通道上线 |
| `web.ready` | Agent | dsh-web 就绪 |
| `web.error` | Agent | dsh-web 退出/异常 |
| `web.stopped` | Agent | dsh-web 被关闭 |
| `command.done` / `command.failed` | Haos | 命令完成，含结果 |
| `notification` | DSH / Haos | DSH 工具通知 |
| `notification.received` | Agent | Agent 收到 Haos notify 命令 |
| `dsh.note` / 自定义 | DSH | 通过 `haos_report` 上报 |

事件写入 `instance_events`，命令写入 `instance_commands`；实例详情页「Haos 通信」面板读取。

## 7. 可靠性与离线

- 控制通道断开后，Agent 指数退避重连（1s → 30s）。
- 服务端对离线实例的命令先写 `queued`，Agent 重连后按创建时间补发（最多 20 条/批）。
- 命令状态：`queued` → `sent` → `done` / `failed`。
- 命令/事件保留在 SQLite；当前原型不做清理，后续加保留策略。
- 控制通道与 Tunnel 独立：控制断开不影响已建立的 WEB 流，反之亦然。

## 8. DSH 工具

插件 `dsh-haos` 注册：

| 工具 | 调用 | 说明 |
| --- | --- | --- |
| `haos_instance_info` | `GET /api/plugin/v1/instance` | 实例状态、能力、Tunnel、控制通道 |
| `haos_notify` | `POST /api/plugin/v1/notify` | 发送通知 |
| `haos_report` | `POST /api/plugin/v1/events` | 上报事件 |
| `haos_workspace` | 本地 | 实例 ID、workspace、public path |

工具从 Agent 状态文件读取实例令牌；令牌不进入 prompt、不作为工具参数。

## 9. 扩展点

后续可以在不改协议骨架的情况下增加：

- `project.*` 命令：绑定项目、拉取项目上下文；
- `memory.*` 命令/事件：项目记忆检索、候选写回；
- `conversation.*`：Haos 会话与 DSH 会话映射；
- `automation.*`：定时/触发任务；
- `capability.*`：插件能力协商；
- 服务端主动 `notification`：DSH 内 toast/侧栏；
- 流式 `event` 分片：长任务过程上报。

## 10. 安全边界

- 控制通道使用实例令牌，令牌只存哈希；
- 命令白名单在服务端与 Agent 双侧校验；
- 危险命令仅实例主人/管理员；
- 诊断输出不含实例令牌、dsh-web token、环境变量；
- 事件 payload 截断到 20KB；
- 控制通道不是通用 RPC：Agent 不执行任意 shell/文件命令。
