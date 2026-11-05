# Bulk Role Management Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; no parallel implementation.

**Goal:** 在现有 /管理 下新增可审计、可恢复的安全批量身份组管理。

**Architecture:** 独立解析、安全/兼容性检查、SQLite 状态机、串行 worker、命令/按钮处理。现有文件仅添加接入代码。

**Tech Stack:** CommonJS, discord.js 14, better-sqlite3, node:test。

**Spec:** `docs/superpowers/specs/2026-11-05-bulk-role-management-design.md`

## Global Constraints

- 最多 200 个去重 ID；6000 字符；5 分钟二次确认；私密反馈；零全服扫描。
- 直接复用 checkAdminPermission，不修改其他业务或配置。
- 单角色 add/remove，不调用 roles.set；每次变更前刷新关键权限。
- 独立持久化、有限重试、每成员状态、至少 24 小时保留、审计独立保留。

## Review Focus

- 请求成功但落盘失败、重启后 inflight 必须先查询并标记 reconciled。
- 等待限流/租约到期时不能发出失去授权的旧请求。
- 同 position 角色使用 SDK comparePositionTo，而非数值 position。
- 损坏/不可读的兼容性配置必须拒绝操作。
- 原管理指令定义和注入路径需回归，不能改变旧参数或鉴权。

## Tasks

- [x] 1. 新增 `tests/bulkRole/input-safety.test.js`，验证解析、真实 SDK 层级和配置冲突；运行红灯；实现 `input.js`、`safety.js`、`compatibility.js`；运行绿灯。
- [x] 2. 新增 `tests/bulkRole/store.test.js`，验证单次确认、过期、冲突、租约、取消和 DB 故障；运行红灯；实现 `store.js`；运行绿灯。
- [x] 3. 新增 `tests/bulkRole/service.test.js`，验证 200 人 add/remove、幂等、重试、撤权、重启、不确定状态、取消、DB 失败；运行红灯；实现 `service.js`；运行绿灯。
- [x] 4. 新增 `tests/bulkRole/commands.test.js` 和管理回归测试；运行红灯；实现 `commands.js`、`presentation.js` 和必要接入；运行绿灯。
- [x] 5. 新增模块 README，记录使用、部署、权限、数据和验证；运行全套 node:test、npm test、语法和 git diff 检查；准备提交与 PR。
