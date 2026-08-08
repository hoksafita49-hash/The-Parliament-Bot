# 运气轮盘三面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运气轮盘的招募、开局参与者名单和最终结果改为三条独立公开消息。

**Architecture:** 保留 `game.message` 专门引用招募消息，加入和取消仍只编辑它；把 slash interaction 的 `channel` 保存到游戏对象，并通过一个安全发送函数创建开局消息和结果消息。结果发送成功后保存返回的 Discord Message，仅使用该消息修订 Timeout 失败提示。

**Tech Stack:** Node.js、CommonJS、discord.js v14、`node:test`、`node:assert/strict`

## Global Constraints

- 面板 1 只负责招募人数和取消状态，成功开局后保留原文并禁用加入按钮。
- 面板 2 必须公开最终有效参与者，按成功加入顺序 mention，并宣布游戏开始。
- 面板 3 必须是独立结果消息；先公开结果，后执行 Timeout。
- 面板 2 或面板 3 发送失败时不得执行处罚，并必须清理游戏与玩家锁。
- Discord REST 调用不得在 `gameManager.runExclusive` 内等待。
- 不改炸弹、死斗、命令注册和中央交互路由。

---

### Task 1: 将轮盘结算拆成三条独立消息

**Files:**
- Modify: `local-tests/rouletteGame.test.js`
- Modify: `src/modules/mystery/services/rouletteGame.js`

**Interfaces:**
- Consumes: `gameManager.runExclusive(game, callback)`、`gameManager.cleanupGame(game)`、Discord `interaction.channel.send(payload)` 和 `Message.edit(payload)`。
- Produces: `game.message` 继续只指向招募消息；`sendPublicPanel(game, payload, action)` 返回已发送的 Discord Message 或 `null`。

- [x] **Step 1: 扩充测试夹具的公开频道**

在 `createFixture()` 中加入一个真实记录 payload 的 fake channel，并由 start interaction 暴露它：

```js
const channelMessages = [];
const channel = {
    async send(payload) {
        const edits = [];
        const sentMessage = {
            payload,
            edits,
            async edit(nextPayload) {
                edits.push(nextPayload);
                return this;
            },
        };
        channelMessages.push(sentMessage);
        return sentMessage;
    },
};

// startInteraction 返回值
channel,

// createFixture 返回值
return {
    addMember,
    channel,
    channelMessages,
    guild,
    joinInteraction,
    members,
    message,
    messageEdits,
    startInteraction,
};
```

- [x] **Step 2: 写三个面板的失败测试**

新增行为测试，触发三人招募结束后检查：招募消息最后一次编辑只禁用组件，不含开局或结果 embed；`channelMessages` 恰好为开局、结果两条；开局描述逐一包含 `<@u1>`、`<@u2>`、`<@u3>` 且顺序正确；结果描述包含被选中的 mention。

```js
test('keeps recruitment, participant start, and result as three separate public panels', async () => {
    // 将 game.random 固定为依次返回 0.5、0.4，触发 recruitment timer。
    assert.equal(fixture.channelMessages.length, 2);
    assert.match(fixture.channelMessages[0].payload.embeds[0].data.description,
        /本局参与者：[\s\S]*<@u1>、<@u2>、<@u3>/);
    assert.match(fixture.channelMessages[1].payload.embeds[0].data.description, /<@u2>/);
    assert.doesNotMatch(lastRecruitmentEdit.embeds?.[0]?.data?.description || '', /本局参与者|恭喜幸运儿/);
});
```

- [x] **Step 3: 运行定向测试并确认 RED**

Run: `node --test --test-name-pattern="three separate public panels" local-tests/rouletteGame.test.js`

Expected: FAIL，因为当前开局和结果都会编辑 `game.message`，不会调用 `channel.send`。

- [x] **Step 4: 写面板发送失败和修订归属测试**

新增四个测试，并把现有“结果发布失败”测试改为针对独立结果消息：

1. 开局面板 `channel.send` 拒绝时，随机函数未调用、无人被 Timeout、游戏锁已释放。
2. 结果面板 `channel.send` 拒绝时，无人被 Timeout、游戏锁已释放。
3. Timeout 拒绝时，只编辑结果消息，招募消息不出现护盾提示。
4. 开局面板发送阻塞期间成员失效并导致人数不足时，不发送结果、不执行 Timeout，并清理游戏锁。
5. 开局面板发送阻塞期间 manager cleanup 时，结算只检查一次中止状态并正常返回，不进入循环。

```js
test('a failed participant panel publish skips draw and timeout', async () => {
    fixture.channel.send = async () => { throw new Error('start panel failed'); };
    await withSuppressedConsoleError(recruitmentCallback);
    assert.equal(randomCalls, 0);
    assert.equal(selected.timeoutCalls.length, 0);
    assert.equal(manager.getPlayerGame('guild', 'u1'), null);
});
```

- [x] **Step 5: 运行新增失败路径测试并确认 RED**

Run: `node --test --test-name-pattern="participant panel|result panel|edits only the result|invalidated during participant" local-tests/rouletteGame.test.js`

Expected: FAIL，当前没有独立频道消息和独立结果 Message 引用。

- [x] **Step 6: 实现安全发送和新文案**

在 `rouletteGame.js` 中：

```js
function startingDescription(participantIds) {
    const mentions = participantIds.map(userId => `<@${userId}>`).join('、');
    return [
        '🎰 **轮盘开始转动……**',
        '',
        '**本局参与者：**',
        mentions,
        '',
        `本局共有 **${participantIds.length} 名玩家**。`,
        '',
        '正在从各位勇士中挑选幸运儿……',
        '',
        '**祝你好运。**',
        '',
        '*或者祝别人好运。*',
    ].join('\n');
}

async function sendPublicPanel(game, payload, action) {
    if (!game.channel || typeof game.channel.send !== 'function') return null;
    try {
        return await game.channel.send(payload);
    } catch (error) {
        logDiscordFailure(game, action, error);
        return null;
    }
}
```

在 provisional game 保存 `channel: interaction.channel`。不改变 `game.message` 的招募消息语义。

- [x] **Step 7: 重排结算消息生命周期**

修改 `settleClaimedGame(game)`：

1. 使用 `scheduleComponentDisable(game)` 禁用面板 1，不覆盖 embed。
2. 拉取并在短锁内筛选最终参与者；不足三人仍编辑面板 1 为取消。
3. 锁外通过 `sendPublicPanel` 发布面板 2；失败则 cleanup 并返回。
4. 短锁内再次按当前 `game.participantIds` 和已 fetch 成员确认游戏仍有效；若并发失效导致少于三人，将面板 2 修订为取消状态并 cleanup；否则计算唯一 outcome 并提交 resolved 状态。
5. 锁外通过 `sendPublicPanel` 发布面板 3；失败则 cleanup 并返回。
6. 面板 3 发布成功后调用 `applyTimeouts`。
7. Timeout 失败时调用返回结果 Message 的 `edit`，不调用只面向招募消息的 `editPublicPanel`。

- [x] **Step 8: 运行轮盘完整测试并修订旧契约断言**

Run: `node --test local-tests/rouletteGame.test.js`

Expected: 全部 PASS。只把断言从“同一消息被改写”为“三条消息各司其职”，不得放宽并发、先发布后 Timeout、失败 cleanup 和成员失效断言。

- [x] **Step 9: 运行全部本地测试和语法检查**

Run: `$tests = Get-ChildItem local-tests -Filter *.test.js | ForEach-Object FullName; node --test $tests`

Expected: 161 项现有测试加 5 项新增测试共 166 项全部 PASS，0 fail/cancelled/skipped/todo。

Run: `node --check src/modules/mystery/services/rouletteGame.js`

Expected: exit 0。

Run: `git diff --check`

Expected: exit 0。

- [x] **Step 10: 提交生产代码，保留本地回归测试**

```bash
git add src/modules/mystery/services/rouletteGame.js docs/superpowers/plans/2026-08-09-roulette-three-panels.md
git commit -m "feat(mystery): split roulette into three panels"
```

`local-tests/` 沿用本分支既有约定保留为未跟踪本地验证资产，不进入 PR。提交前确认没有暂存 `.env`、冷却数据、日志或代理辅助文件。

### Task 2: 重启并验证本地 Bot

**Files:**
- No production file changes.

**Interfaces:**
- Consumes: ignored `.env`、ignored local proxy bootstrap、Clash `127.0.0.1:7890`。
- Produces: 一个新的本地 Node Bot 进程和新启动日志。

- [x] **Step 1: 停止旧 Bot 进程**

先核对 PID 23464 的 command line 指向本 worktree，再执行：

```powershell
Stop-Process -Id 23464
```

- [x] **Step 2: 用现有本地代理启动器重新启动**

从 worktree 运行 ignored 的 `local-start-proxied.cmd`，将 stdout/stderr 写入新的本地部署日志；不得打印 `.env` 内容。

- [x] **Step 3: 验证登录和命令状态**

检查新 Node PID、日志中的 `Ready`/登录成功和命令注册成功；stderr 不得出现未处理异常。最后向用户报告 PID、停止命令和 Discord 人工测试步骤，不创建 PR。
