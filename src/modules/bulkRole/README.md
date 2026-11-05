# 批量身份组管理

## 管理员使用

1. 输入 `/管理 身份组 批量操作`，选择「添加」或「移除」、一个原生身份组选项，并在 `用户id列表` 填写英文逗号分隔的用户 ID。例如：`123456789012345678,987654321098765432`。
2. 检查仅自己可见的预览，包括输入/去重人数、需要修改、已是目标状态、不在服务器及异常人数。此时没有身份组变更。
3. 5 分钟内点击「确认执行」创建唯一任务，或点击「取消操作」。按钮仅原操作者可用，确认令牌只能消费一次。
4. 使用 `/管理 身份组 任务` 查询自己在当前服务器最近的任务；也可填写 `任务id` 查询历史任务。无需保留最初的交互消息。
5. 任务查询的 `操作` 可选「状态」「取消」「重试失败」。取消只停止未开始部分，正在请求或重启前结果不确定的部分先核对。失败重试只包含 `failed` 成员，生成新的预览并再次确认，不重放整批。

Discord 要求指令/选项中的拉丁字母小写：需求中的“用户ID列表”实际注册名为 **`用户id列表`**，“任务ID”为 `任务id`。大写名称会被 discord.js 验证器拒绝。

输入最多 6000 字符，去除项首尾空白、去重保序，最多 200 个去重 ID。接受 17–20 位非零十进制 Snowflake，且不超过 uint64。空项、中文逗号、提及语法、非法 ID、超量均整批拒绝，不会静默丢弃。仅请求给出的 ID，不扫描全服。

## 权限与安全边界

- 直接调用现有 `checkAdminPermission`，保留管理身份组、Administrator、服务器所有者规则；`permissionManager.js` 原样不变。
- 每次入口、预览交付前、确认、恢复和成员变更前刷新 guild、roles、操作者及 Bot。查询、结果附件、自动私密反馈也刷新操作者权限。原操作者以外的管理员不能查询/取消此任务。
- 拒绝 @everyone、managed、Administrator、管理白名单角色；通过 SDK `comparePositionTo` 比较层级，目标必须严格低于操作者和 Bot，所有者也无豁免。
- Bot 必须拥有 **ManageRoles**，并且最高身份组高于目标。无需 Administrator；不申请更广权限。
- 只读检查 `roleSync.sqlite` 的有效映射两端和未完成同步任务，`selfRole.sqlite` 的主/配套身份组和 active grant；发现冲突拒绝执行，不改动同步机制、熔断器或生命周期规则。
- 还拒绝处罚警告/四字转换身份组、赛事自动发放身份组、归档自助/创作者奖励/投票通知自助身份组。配置损坏、schema 不匹配或数据库不可读时拒绝执行。
- 所有 Discord 反馈均为 ephemeral，`allowedMentions.parse=[]`；公开频道不发送名单或任务结果。Discord Audit Log reason 包含任务 ID、操作者及操作类型。

## 队列与恢复

- 全局执行并发为 1，同一服务器有活动任务时明确拒绝确认另一任务。独立 SQLite 的唯一索引、IMMEDIATE 事务和 worker 租约同时保护多个连接/进程。
- 每次只调用官方 discord.js `REST` 的 `Routes.guildMemberRole` 单角色 PUT/DELETE；不 PATCH 成员、不调用 `roles.set`，不会覆盖其他身份组。
- 变更请求使用**独立 REST 实例**，不改变现有 `client.rest`；禁止 SDK 内部自动重试/限流等待，让应用持久化退避并在下一次请求前重新鉴权。HTTP 超时 15 秒。共享 SDK 仍负责只读 guild/member 查询，其共享桶等待可能延迟预览和取消反馈。
- 一轮可恢复错误最多追加 3 次应用重试，每成员最多发起 4 次变更尝试。网络/5xx/429 使用指数退避（1/2/4 秒）并至少遵守服务端 Retry-After；退避写入 DB 后释放 worker，不占用 Interaction。403、目标删除、关键安全条件变化停止剩余部分。
- 每次执行/重试先获取单个成员真实状态。先持久化 `inflight` 再写 Discord，再落盘终态。已提交成功不再执行；`inflight` 恢复先读状态，不确定请求已达目标记为 `reconciled`，不能冒充 API 已确认成功。
- 2 分钟租约、10 秒心跳；正常关闭等待当前请求完成。突然退出在租约到期后恢复，恢复时重新鉴权。数据库错误停止该轮，不会继续发出变更；后续轮次从断点读取真实状态。
- 初始私密消息仍有效时尽力更新进度/结果，最多每 5 秒一次；重启或 token 失效后使用新任务查询。不依赖旧 token 恢复任务。

成员状态：

| 状态 | 意义 |
|---|---|
| pending | 尚未开始 |
| inflight | 请求前已落盘，结果尚未可靠提交 |
| success | Discord API 已确认成功 |
| already | 执行前已是目标状态，没有发送变更 |
| reconciled | 不确定请求后查询已达目标，无法证明是哪次请求导致 |
| absent | Discord 明确返回 Unknown Member |
| failed | 最终失败，支持单独重试 |
| unexecuted | 取消/安全停止后的剩余部分；若权限或读取失败阻止核对，保留 uncertain 标志和提示 |

结果分别展示 API 成功、跳过（含 already/absent/reconciled 的细分）、失败、未完成/未执行、失败原因分类。结束后的失败和未执行名单通过私密 TXT 附件返回，ID 使用英文逗号。未执行名单可手动重新提交；所有重试仍会先读取当前状态。

## 部署与数据

- **没有新依赖、环境变量或 Intent。** 复用项目已有 discord.js、better-sqlite3；项目原有 Guilds/GuildMembers Intent 配置保持不变。本功能使用单成员 REST 查询，不新增全服成员拉取需求。
- 重启 Bot，按原有 `clientReadyHandler` 流程更新已有 `/管理` 命令；没有新顶层指令。
- 自动创建 **`data/bulk-role/jobs.sqlite`**（WAL、FULL 同步，独立 jobs/members/previews/worker_lock/audit 表）。不迁移其他数据库。新目录模式 0700、DB 文件模式 0600。
- 部署必须持久化 `data/bulk-role/`，不能放在重启就丢失的临时盘。备份使用 SQLite backup 或停机后备份整个数据库/WAL，不要在运行中仅复制主文件。
- 任务结果与独立 audit 日志**不自动删除**，因此保留至少 24 小时，也不会随预览清理丢失审计。过期预览 24 小时后清理。按站点数据政策进行备份、归档和磁盘监控。
- 多实例必须共享同一可靠本地 SQLite 数据库文件；不同数据库的实例无法互斥。不支持用网络文件系统实现多主队列。

## 验证与边界

运行：

```sh
npm ci --no-audit --no-fund
node --test --test-isolation=none tests/bulkRole/*.test.js tests/selfModeration/*.test.js
```

`--test-isolation=none` 适用于本次 Node 24 环境，可展示每个用例；其他支持 node:test 的版本可运行 `node --test tests/bulkRole/*.test.js tests/selfModeration/*.test.js`。项目现有 `npm test` 仍是占位错误，按限定范围不修改 package.json。

使用真实 SQLite、真实 SDK 角色比较/成员接口及真实 REST 控制器，网络边界使用模拟响应。另有子进程 SIGKILL 的 SQLite 恢复测试。**未使用真实 Discord Token、服务器或成员进行在线实测。** 上线前应在隔离测试服验证注册、ephemeral 按钮/附件、实际权限/限流、角色变更事件和重启恢复。

Discord 检查与变更不是原子事务：外部管理员或其他 Bot 在最后一次检查与实际请求之间修改角色/配置的极短竞态无法完全消除；已发出的请求不能撤销。未知外部自动化无法从本仓库配置识别。成员可能在查询后离开，按真实 API 结果记录。角色配置变更导致任务安全停止后，需纠正配置并将未执行名单重新提交；不会为恢复而降低安全限制。

## 文件职责

| 文件 | 用途 |
|---|---|
| input.js | 严格解析、去重和数量限制 |
| safety.js | 新鲜权限、受保护身份组及 SDK 层级检查 |
| compatibility.js | 原存储只读兼容性检查，不初始化/迁移其他模块 |
| store.js | 独立 SQLite 预览/任务/成员/租约/审计状态机 |
| transport.js | 有限重试边界下的官方单角色 REST 操作 |
| service.js | 预览、后台串行队列、恢复、取消及失败项重试 |
| presentation.js | 私密预览、进度、结果和 TXT 附件 |
| commands.js | 管理分组定义及指令/按钮处理器，支持依赖注入 |
| tests/bulkRole/*.test.js | 输入、安全、存储、执行、交互、SDK transport 与原管理回归 |

原有文件仅修改 `mystery/commands/manageCommand.js`、`core/events/interactionCreate.js`、`core/index.js` 的必要接入。设计/计划/验收记录在 `docs/superpowers/`。
