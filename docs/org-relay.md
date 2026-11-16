# 组织与任务转发（Haos 中心化）

> 把 dsh-co-dsh 的 **P2P 组织拓扑**搬进 Haos：拓扑由 Haos 集中配置，任务由 Haos 转发，
> 深度/防环/直接下级这些规则全部在中心校验。DSH 侧插件退化成"执行 + 轮询"的薄客户端。

## 为什么改成中心化

| 维度 | P2P（dsh-co-dsh 现状） | Haos 中心化 |
| --- | --- | --- |
| 拓扑来源 | 每个实例自己登记对端，树是"涌现"出来的 | 管理员在 Haos 配置一次，所有实例读同一棵树 |
| 权限/信任 | 每对实例互发 token，撤销要逐台操作 | 实例只认 Haos 的实例令牌；成员变更集中在中心 |
| 规则执行 | 每个节点自行校验 chain/depth（可被改代码绕过） | 中心校验，插件无法绕开 |
| 网络前提 | 实例之间要能互相访问（NAT/防火墙是硬门槛） | 实例只需要能访问 Haos |
| 可观测 | 各实例自己的 `tasks/` 目录 | Haos 一处看到所有转发任务与状态 |
| 代价 | 无单点 | Haos 是单点；需要高可用与容量规划 |

## 数据模型

```sql
-- 组织：一个 team 一个默认组织，root_instance_id 指向根节点
CREATE TABLE orgs (id, team_id, name, root_instance_id, max_depth DEFAULT 3, created_at);

-- 实例挂到树上（instances 表新增列）
ALTER TABLE instances ADD COLUMN org_id, org_parent_id, org_role, org_depth;

-- 经 Haos 转发的任务
CREATE TABLE relay_tasks (
  id, org_id, caller_instance_id, target_instance_id,
  status,            -- queued → running → succeeded | failed | canceled
  prompt, context, cwd, title,
  chain_json,        -- 已经过的实例链（防环 + 深度）
  depth, summary, error, created_at, started_at, finished_at
);
```

## 中心化规则（全部在 Haos 校验）

1. **同一组织**：调用方与目标必须 `org_id` 相同。
2. **只能派给直接下级**：`target.org_parent_id === caller.id`。
3. **防环**：`chain` 里出现调用方或目标即拒绝（`delegation_loop`）。
4. **深度**：`chain.length + 1 > org.max_depth` 拒绝（`depth_exceeded`）。
5. **组织树完整性**：配置树时校验单一根、无环、深度不超限（`org_multi_root` / `org_cycle` / `org_too_deep`）。

## API

### 实例侧（实例令牌 `Authorization: Bearer <instanceToken>`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/plugin/v1/org` | 读取本组织树（成员、角色、深度、能力、在线状态） |
| POST | `/api/plugin/v1/tasks` | 请求把任务转发给直接下级 |
| GET | `/api/plugin/v1/tasks/pending` | 拉取派给自己的排队任务 |
| POST | `/api/plugin/v1/tasks/:id/claim` | 领取任务（queued → running） |
| POST | `/api/plugin/v1/tasks/:id/result` | 提交成功结果 `{ summary }` |
| POST | `/api/plugin/v1/tasks/:id/fail` | 提交失败 `{ error, canceled? }` |
| GET | `/api/plugin/v1/tasks/:id` | 查询任务状态（caller 或 target 可见） |

### 控制台侧（浏览器会话）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/org` | 组织树 + 未挂载实例 |
| POST | `/api/org/tree` | 批量配置父子关系 `{ assignments: [{ instanceId, parentId }] }` |
| POST | `/api/org/max-depth` | 调整组织深度上限（1–10） |
| GET | `/api/org/tasks` | 最近的转发任务与状态 |

## 插件侧：已并入 dsh-haos

原 `dsh-co-dsh` 的能力（组织读取、能力匹配、任务转发、入站执行、提示词注入）已经
移进 `haos/integrations/dsh-haos`，不再需要第二个插件：

- 工具：`haos_org`（组织树）、`haos_delegate`（经 Haos 派给直接下级）、`haos_task`（查询/等待结果）；
- 入站执行：`lib/relay.mjs` 每 `relayPollSeconds` 秒拉 `GET /tasks/pending`，claim 后
  用独立 DSH 会话执行，再 `POST /result` 或 `/fail`；
- 本地安全边界：`acceptRemoteTasks`（总开关）、`allowedRoots`（工作目录白名单）、`maxTaskMinutes`（超时）；
- 能力上报：`declaredCapabilities`（每行一条，兼容 `id | 标题 | 标签 | 说明`）随心跳进入组织树；
- 提示词：自动注入「Haos 组织」段（位置、depth、级联上限、直接下级）。

配置项（`cordis.patch.yml` 或实例设置）：

```yaml
- id: dsh-haos
  config:
    baseUrl: http://127.0.0.1:4600
    apiKey: haos_api_...
    friendlyName: analyst
    declaredCapabilities: |-
      role.analyst | 数据分析 | 分析,统计 | 负责数据统计与报表
    allowedRoots: |-
      /srv/projects
    acceptRemoteTasks: true
    relayPollSeconds: 2
    maxTaskMinutes: 60
```

后续可做：把上述字段搬进「设置 → Haos」页面；完成通知由 Haos 控制通道推送而不是调用方轮询。

## 推进顺序

1. ✅ Haos schema + 组织 API + 任务转发 API + 9 个单测 + 端到端脚本（本轮）。
2. ⬜ 控制台「组织」页：树形拖拽/下拉挂载、深度上限、转发任务列表。
3. ⬜ dsh-co-dsh `transport=haos`：组织读取、任务转发、pending 轮询执行。
4. ⬜ 通知链路：目标完成后由 Haos 推给调用方（当前先靠调用方轮询）。
5. ⬜ 高可用：Haos 重启时的任务续跑（queued 保留、running 标为中断）与容量/配额。

## 安全注意

- 实例令牌仍然是唯一凭证，但**不再需要实例间互信**；跨组织调用在中心被拒。
- `/org/tree` 是管理操作，走浏览器会话 + Origin 校验，记 `audit_logs`。
- 转发任务的 `prompt` 会落库（`relay_tasks`），涉及敏感数据时应在插件侧加脱敏开关或缩短保留期。
