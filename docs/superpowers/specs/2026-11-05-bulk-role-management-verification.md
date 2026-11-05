# 批量身份组管理验收记录

基线 `b354f6cfa17e059dc2c66a416856283c570a9668`，分支 `feat/bulk-role-management`。环境：Node v24.22.1、npm 11.9.0；锁定安装 discord.js 14.21.0、better-sqlite3 11.10.0，无新增依赖。

## 检查结果

| 检查 | 结果 |
|---|---|
| `npm ci --no-audit --no-fund` | 158 packages 安装成功，lockfile 无差异 |
| `node --test --test-isolation=none tests/bulkRole/*.test.js tests/selfModeration/*.test.js` | **116 项通过，0 失败**，含 60 项新增用例/子用例和 56 项已有回归；约 11.6 秒 |
| 对 8 个新增模块 JS 和 3 个接入文件运行 `node --check` | 11 个文件通过 |
| `git diff --check` | 通过 |
| `npm test` | 原有占位脚本退出 1：`Error: no test specified`；基线同样失败，未修改 package.json |

本地详细日志：`/tmp/bulk-role-tests.log`。网络边界均注入模拟响应，未连接真实 Discord。

## 要求覆盖

| 用户要求 | 测试证据 |
|---|---|
| 1. 添加 200 人 | service：200 次单角色添加，全部 success |
| 2. 移除 200 人 | service：200 次单角色移除，全部 success |
| 3. 重复 ID | input-safety：去重保序，保留输入计数 |
| 4. 非法 ID | input-safety：空项、短 ID、前导零、溢出、中文逗号、提及、6001 字符、201 人均拒绝 |
| 5. 已有角色 | service：already 不发写请求；预览后状态变化也重新读取 |
| 6. 不在服务器 | service：明确 Unknown Member 记 absent，其他读取错误不能伪装离服 |
| 7. Administrator | input-safety：目标拒绝，所有者也不豁免 |
| 8. 操作者层级 | input-safety：相等/高于拒绝，同 rawPosition 使用 SDK 排序 |
| 9. Bot 层级 | input-safety：相等/高于拒绝，单独验证缺少 ManageRoles |
| 10. 管理白名单 | input-safety：原名单只读复用，目标白名单拒绝 |
| 11. 中途撤权 | service：操作者撤权、目标变 Administrator、层级/Bot 权限变化后停止剩余部分 |
| 12. 确认超时/重放 | store/commands：5 分钟边界、原操作者、跨服拒绝、单次消费和重复点击 |
| 13. 限流 | transport：真实 SDK 收到 429 拒绝隐藏重发；service：持久化 Retry-After，等待时撤权后不再发请求 |
| 14. 突然重启 | service：真实子进程 SIGKILL，未关闭 SQLite，恢复 WAL 记录 |
| 15. 恢复幂等 | service/store：success 不重放，inflight 先查状态；取消也核对在途结果 |
| 16. 并发冲突 | 两个 SQLite 连接确认互斥；两个独立 worker 仅一个发送；租约失效停止提交/下一人 |
| 17. 跨服同步 | input-safety：有效映射两端和积压任务拒绝；禁用且无积压才允许 |
| 18. 其他角色 | service/transport：只改目标，200 人其他角色保留，不 PATCH 成员 |
| 19. DB 故障 | SQLite trigger ABORT 模拟写失败及关闭连接读取失败；不写 Discord 或保留 inflight 待核对，不继续下一人 |
| 20. 原管理回归 | commands：原关门/开门参数、成员id四子命令、依赖注入路由和旧鉴权拒绝不变；已有消息保护 56 项通过 |

其他覆盖：直接执行原 `checkAdminPermission` 的所有者/Administrator/白名单规则；自助主/配套/active grant 冲突；处罚警告/四字转换、赛事自动发放、创作者奖励和归档/通知自助角色冲突；损坏配置拒绝；私密附件鉴权；失败重试仅包含 failed；省略任务 ID 可以找回最近任务。

## 审查与范围

独立只读审查复现两项问题，先加入回归再修复：

1. SDK 隐藏 429 重发绕过新鲜权限检查：新增独立官方 REST transport，禁用内部重试和限流等待，由持久化队列处理，不改变现有 client.rest。
2. 崩溃后取消误将已生效的 inflight 记为未执行：取消先只读核对，保留 reconciled/absent/已知未执行结果，不发新变更。

复审确认两项修复，无新增阻塞问题；复审快照独立运行 113 项通过。后续补充用例后最终 116 项通过。

原业务文件仅改三处必要接入：manageCommand.js（新增分组/注入/委托）、interactionCreate.js（独占前缀按钮分发）、core/index.js（服务启停）。permissionManager、memberIdExport、roleSync、selfRole、punishment、voting 等既有模块无差异；依赖、环境样例和其他数据库结构不变。

实现决定：独立 SQLite；全局并发 1，同服活动任务拒绝；结果和独立审计长期保留；任务 ID 可省略以应对确认反馈丢失；Discord 不接受大写 ASCII 选项名，因此注册 `用户id列表`。没有顺手修复已有业务，没有未处理的审查阻塞项。

## 验证边界

未使用真实 Token、服务器或成员，不能声称在线实测。部署到隔离测试服后需验证命令注册、ephemeral 按钮/附件、实际限流、Gateway 联动和恢复。

检查与实际 API 无法原子化，外部管理员/其他 Bot 同时修改仍有极短竞态；已发出的请求无法撤销。只读查询沿用原 SDK 共享桶，可能延迟取消反馈，但下一次写操作仍重新鉴权。未知外部自动化无法从仓库识别。

必须持久化本地数据目录，多实例需共享同一可靠 SQLite 文件；不同数据库副本不互斥。不自动删除任务/审计，需要运营备份、归档和磁盘监控。安全条件变化导致停止后，纠正配置并重新提交未执行名单，不降低安全约束。


## 发布状态

实现提交 `6e6809c`，已推送 `hoksafita49-hash/The-Parliament-Bot` 的 `feat/bulk-role-management` 分支，未修改任何 main 分支。目标仓库直接推送返回 403；通过已有 fork 推送成功。创建草稿 PR 的 GitHub 连接器和 CLI 均返回 `Resource not accessible by integration`，因此没有伪造 PR 编号或地址。

[打开 PR 创建入口](https://github.com/ESSEX-CV9/The-Parliament-Bot/compare/main...hoksafita49-hash:feat/bulk-role-management?expand=1)。可直接使用同目录 `2026-11-05-bulk-role-management-pr.md` 的 PR 描述。当前工作区保留完整独立分支。
