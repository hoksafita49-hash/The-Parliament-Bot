为现有 `/管理` 新增 `身份组 批量操作`，支持最多 200 个去重 ID 的单角色添加/移除。私密预览和 5 分钟二次确认后进入独立 SQLite 后台队列，支持进度、取消、仅重试失败项、审计和重启幂等恢复。

- 只读复用原 checkAdminPermission，入口/确认/逐成员/恢复刷新权限；禁止受保护身份组及不符合操作者/Bot 层级的身份组，所有者无豁免。
- 只读检查跨服同步和自助角色/生命周期等已知自动化冲突；独立官方 REST 单角色 PUT/DELETE、有限持久化退避；不改变现有 client.rest，不覆盖其他身份组。
- 原业务文件只修改 manageCommand.js、interactionCreate.js、core/index.js 三处必要接入；其他现有业务、鉴权、依赖及配置原样保留。

验证：`node --test --test-isolation=none tests/bulkRole/*.test.js tests/selfModeration/*.test.js`，116 项通过、0 失败（60 新增、56 原有回归）；11 个 JS 语法检查和 git diff --check 通过。覆盖真实 SDK REST 限流边界、200 人添加/移除、并发、权限撤销、DB 故障、子进程 SIGKILL 恢复；两项独立审查发现均已修复并复审。

现有 npm test 是占位错误，基线与本分支均退出 1，未修改。未连接真实 Discord，命令注册、ephemeral 按钮/附件、真实限流和 Gateway 联动仍需测试服验证。

用法：`/管理 身份组 批量操作` 选择操作、身份组和英文逗号列表，然后确认；`/管理 身份组 任务` 查询最近任务，或填任务 ID，操作可选状态/取消/重试失败。Discord 不接受大写 ASCII 选项名，实际参数名为 `用户id列表`。

Bot 需要 ManageRoles，最高角色高于目标；无需新环境变量、依赖或 Intent。自动新建独立 data/bulk-role/jobs.sqlite，不迁移其他数据库；需持久化目录。多实例必须共享同一可靠本地 SQLite，结果/审计不自动清理，需要运营归档。检查与请求间仍有无法原子化的极短竞态，已发出的请求不能撤销。

完整用法、文件职责与剩余边界见 src/modules/bulkRole/README.md；逐项验收记录见 docs/superpowers/specs/2026-11-05-bulk-role-management-verification.md。
