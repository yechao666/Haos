# dsh-haos

DSH 的 Haos 接入插件。所有 DSH 模式（desktop / web / headless）共用同一个插件路径，**没有 sidecar**。

插件在 DSH 宿主进程内：

- 用用户级 API Key 注册实例；
- 维持心跳与控制 WSS；
- 订阅 `session/event`，上报会话/工具事件；
- 创建并注册唯一的根工作区；
- 如果当前 profile 有 web server，通过 `webServer` + `connection.authenticatedUrl()` 认证并建立 WEB Tunnel；
- 注册 `haos_instance_info / haos_notify / haos_report / haos_workspace` 工具。

## 安装（已有 DSH，一条命令）

在 Haos 仓库根目录：

```bash
node scripts/install-dsh-plugin.mjs \
  --profile desktop \
  --base http://<haos-host>:4600 \
  --api-key 'haos_api_...' \
  --workspace "$HOME/.haos/workspace"
```

然后重启 DSH。`--profile web` 用于 Web profile；其他 profile 传对应名称。

## 手动安装

```bash
cd /path/to/haos
dsh plugin --profile desktop add link:/path/to/haos/integrations/dsh-haos
```

重启 DSH，打开 **设置 → Haos**，填写：

插件面板支持多套连接配置，但只能激活一套。每套包含：

| 字段 | 说明 |
| --- | --- |
| 本实例友好名 | Haos 中显示的本机名称 |
| 本实例工作能力概述 | 上报到 Haos 的能力描述 |
| Haos 中心地址 | Haos API 端点，例如 `http://127.0.0.1:4600` |
| API Key | Haos 用户级 API Key |
| 本地根工作区目录 | 唯一的工作区根；内部 `.haos/` 存放身份、锁等内部信息 |

不再使用独立状态文件，也不再有第二个 `haos-home` 目录。

设置页由 Client 半侧提供（`client-src/index.js` + Host `/api/haos/config`），支持“测试连接”。修改 Client 后运行：

```bash
pnpm --dir integrations/dsh-haos build:client
```

## 工作区

插件使用配置中的唯一根工作区目录，例如：

```text
~/haos-workspace
```

目录结构和内部信息统一放在：

```text
~/haos-workspace/.haos/instance.json   # 实例身份与实例 token
~/haos-workspace/.haos/lock/           # 工作区锁
```

不再创建第二个 `haos-home`，也不使用独立状态文件。首次注册生成 `clientInstanceId`，后续重启复用该身份。

## 控制通道

Haos 可下发：

`ping`、`status`、`diagnostics`、`web.restart`、`web.close`、`web.open`、`tunnel.reconnect`、`notify`、`echo`。

命令与结果写入 `instance_commands` / `instance_events`，在 Haos「Haos 通信」面板查看。

## 协议

见 [控制通道协议](../../docs/control-channel.md)。
