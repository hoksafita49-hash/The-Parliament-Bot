# 批量身份组管理设计

依据用户已授权的完整开发规格实施；所有实现选择限定于新增功能，不改变现有业务规则。

## 仓库检查与范围

- 基线：`b354f6c`；CommonJS、discord.js 14、better-sqlite3；现有测试使用 `node:test`，`npm test` 为占位脚本。
- `manageCommand.js` 有工厂和依赖注入；只新增分组定义、注入参数和提前路由。
- `permissionManager.js` 已导出 `checkAdminPermission` 和 `getAllowedRoles`，原样只读复用。
- `interactionCreate.js` 只新增独占前缀的按钮路由；`core/index.js` 只增加后台服务启动/停止。
- `memberIdExport` 的 SQLite/WAL/租约方案值得参考，但执行器针对分页导出，不能承担逐成员变更而不改变其业务。
- `roleSync` 由 GuildMemberUpdate 触发，双向和单向映射的两端均可能参与对账。有效映射的任一端拒绝批量操作。
- `selfRole` 主身份组、配套身份组、历史 active grant 均可能由生命周期处理。配置或有效 grant 涉及的身份组拒绝操作。
- 同时检查处罚警告身份组、赛事自动发放身份组、归档自助身份组；只读读取现有存储，不触发其他模块的初始化/迁移。

## 方案

唯一符合边界的方案是新增 `src/modules/bulkRole/`，复用依赖、鉴权函数和现有生命周期接入位置。复用导出执行器需要改变旧业务；共享其他模块表会越界，均不采用。

## 行为与安全

`/管理 身份组 批量操作` 提供添加/移除、原生 RoleOption 和最长 6000 字符的逗号列表。严格十进制非零 Snowflake（17–20 位且不超过 uint64），有错误则整批拒绝；去重保序，最多 200。

入口、预览交付、确认、恢复及每次成员变更前刷新 guild、roles、操作者和 Bot。原鉴权规则不变；禁止 @everyone、managed、Administrator、管理白名单，以及按 `comparePositionTo` 高于或等于操作者/Bot 的角色；所有者无豁免，Bot 必须有 ManageRoles。配置读取失败时拒绝执行。运行期检查失败停止剩余成员。

预览只读逐 ID 获取成员，不扫描全服，持久化 5 分钟有效的单次确认令牌。确认事务消费令牌并创建 UUID 任务；同服最多一个活动任务，重复提交和跨进程冲突由 SQLite 事务/唯一索引处理。任务查询仅原操作者且仍有管理权限可用。

## 持久化和队列

独立 `data/bulk-role/jobs.sqlite`，WAL、FULL 同步、独立任务/成员/预览/审计表。全局低并发（1）执行，同服冲突明确拒绝。数据库锁采用独占 worker 租约，心跳及每次写请求前检查持有权；租约丢失立即停止发新请求。结果长期保留（不自动清理，至少 24 小时），审计独立保留。

成员状态分为 pending、inflight、success（API 确认）、already（已是目标状态）、absent、failed、unexecuted、reconciled（不确定请求后查询已达目标）。先落盘 inflight 再通过官方 REST 单角色 PUT/DELETE，之后保存结果；独立 REST 实例禁用内部重试及限流等待，避免绕过下一次权限检查，不改变现有 client.rest。DB 错误绝不继续写 Discord。恢复只处理 pending/inflight，每次查询真实状态，不重放 success。网络/5xx/429 有限退避，重试时间和次数持久化，长限流交还轮询；403/权限错误停止任务。取消先只读核对历史在途请求，保留已完成变更，只取消未开始部分。

## 反馈与限制

任务查询提供进度、取消、重试失败项；省略任务 ID 时查询当前操作者本服最近任务，允许从确认反馈丢失中恢复。重试也先生成新预览，再确认创建子任务，仅包含 failed 成员。TXT 失败列表和全部结果只通过 ephemeral 返回，禁止 mentions。完成通知尽力更新仍有效的私密交互；持久化任务查询不依赖旧 token。Audit reason 包含任务与操作者 ID。

平台限制：Discord 不接受大写 ASCII 指令选项名，实际注册 `用户id列表`；其含义、类型及长度不变。

Discord 权限检查与请求无法形成原子事务，外部管理员/其他 Bot 同时修改仍存在极短竞态；已知自动化配置保守拒绝。跨主机运行需共享同一数据库文件；SQLite 不支持以网络文件系统实现可靠多主部署。真实 Discord 行为需部署到测试服务器验证，本任务测试使用官方 SDK 和本地模拟 API 边界。
