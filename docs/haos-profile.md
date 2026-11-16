# Haos Profile：一个进程内同时运行 Web / 控制 / 事件 / Tunnel

目标形态：

```text
dsh --profile haos
  ├─ @deepseek-ai/dsh-base
  ├─ @deepseek-ai/dsh-web-app
  └─ dsh-haos（in-process）
       ├─ 注册 / 心跳 / 控制 WSS
       ├─ 当前 web server 认证 + Tunnel
       └─ session/event → Haos
```

所有实例通过 `dsh-haos` 插件接入，没有 sidecar。

## 创建

```bash
cd haos
node scripts/create-haos-profile.mjs \
  --dsh-home ~/.dsh \
  --key 'haos_enr_...' \
  --base http://127.0.0.1:4600 \
  --workspace ~/.haos/haos-workspace
```

脚本会：

1. 复制 `web` profile 为 `haos`；
2. 安装 `dsh-haos`（link 到本仓库）；
3. 写入 `cordis.patch.yml` 的 `dsh-haos` 配置；
4. 创建工作区。

## 启动

```bash
DSH_HOME=~/.dsh dsh --profile haos --no-open --host 127.0.0.1 --port 30900
```

只启动 **一个** DSH 进程；`dsh-haos` 在进程内：

- 用 `webServer.getOrigin()` 获取当前 web server；
- 用 `connection.authenticatedUrl()` 获取启动 token 并换取 Cookie；
- 建立 WEB Tunnel；
- 订阅 `session/event`，把工具调用/结果/助手消息上报 Haos。

## 验证

```bash
curl -s http://127.0.0.1:4600/api/instances -b cookie.txt
```

应看到实例：

```json
{"name":"haos-inproc","online":true,"webReady":true,"webPort":30900,"capabilities":["control","events","tools","sessions","workspace","web","tunnel"]}
```

Haos 控制台打开 `/w/<instanceId>/`，能正常对话；Haos「Haos 通信」面板能看到 `session.event`、`tool/call`、`tool/result`。

## 当前本机演示

本机已有一个实际运行的 `haos` profile：

```bash
DSH_HOME=/Volumes/wd2025/devel/aiworker/haos/data/haos-home \
  dsh --profile haos --no-open --host 127.0.0.1 --port 30900
```

该 profile 的实例名由 Haos 服务端分配（例如 `dsh-0001`）；本机目前保留的演示实例名可能是 `haos-inproc`。

## 注意

- 需要 DSH 的 `connection` 服务暴露 `authenticatedUrl()`；当前 DSH 0.2.2-rc.1 已提供。
- `dsh-haos` 的 in-process 模式复用当前 web server，不绑定新端口；Haos 仍然通过 `/w/:instanceId/` 访问。
- 插件会自动创建 `haos-home` 工作区；实例名由 Haos 分配。
