# 轮盘延迟揭晓与死斗七轮上限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运气轮盘结果在参与者面板发布满五秒后才揭晓，并让死斗在第七轮仍未达到两分时无处罚失效。

**Architecture:** 轮盘在游戏对象上维护一个可取消且会唤醒等待者的揭晓 timer，不在锁内等待；死斗继续沿用当前回合结算状态机，在公开第七轮结果后原子认领无胜者终局。两个服务分别修改和验证，最后统一重启本地 Bot。

**Tech Stack:** Node.js、CommonJS、discord.js v14、`node:test`、`node:assert/strict`

## Global Constraints

- 轮盘面板 3 不得早于面板 2 发布完成后的 `5,000ms`。
- 轮盘抽取、结果发布和 Timeout 均不得在五秒延迟结束前发生。
- 轮盘 cleanup 必须取消并唤醒揭晓等待，且删除 timer 引用。
- 死斗获胜条件保持先得两分；第七轮达到两分时胜负终局优先。
- 死斗第七轮未决时不得创建第八轮、不得 Timeout 任何人。
- Discord 网络写入和 timer 等待均不得发生在 `gameManager.runExclusive` 内。
- `local-tests/` 沿用本分支约定保持为未跟踪本地验证资产。

---

### Task 1: 运气轮盘五秒可取消揭晓

**Files:**
- Modify: `local-tests/rouletteGame.test.js`
- Modify: `src/modules/mystery/services/rouletteGame.js`

**Interfaces:**
- Consumes: `game.timers: Set<Timeout>`、`cleanupRouletteGame(game)`、面板 2 返回的 Discord Message。
- Produces: `waitForResultReveal(game): Promise<boolean>`，正常满时返回 `true`，cleanup 取消时返回 `false`；`cancelResultReveal(game): boolean` 幂等结束等待。

- [ ] **Step 1: 给既有轮盘测试提供零延迟游戏 helper**

在测试文件增加：

```js
function getFastChannelGame(channelId = 'channel') {
    const game = manager.getChannelGame(channelId);
    if (game) game.resultRevealDelayMs = 0;
    return game;
}

async function waitUntil(predicate, attempts = 50) {
    for (let index = 0; index < attempts; index += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('condition was not reached');
}
```

把既有测试中用于结算的 `manager.getChannelGame('channel')` 改为该 helper；新增精确五秒测试仍直接读取 manager game，保留生产默认值。

- [ ] **Step 2: 写精确五秒时序失败测试**

触发三人轮盘，拦截结算阶段的 `global.setTimeout` 并手动持有回调：

```js
test('waits five seconds after the participant panel before draw, result, and timeout', async () => {
    const settlement = recruitmentCallback();
    await waitUntil(() => revealTimer !== undefined);
    assert.equal(revealTimer.delay, 5000);
    assert.equal(fixture.channelMessages.length, 1);
    assert.equal(randomCalls, 0);
    assert.equal(selected.timeoutCalls.length, 0);

    revealTimer.callback();
    await settlement;

    assert.equal(fixture.channelMessages.length, 2);
    assert.equal(randomCalls, 2);
    assert.equal(selected.timeoutCalls.length, 1);
});
```

测试中的 expected `5000` 为手工字面值，不从生产常量导入。

- [ ] **Step 3: 运行定向测试确认 RED**

Run: `node --test --test-name-pattern="waits five seconds" local-tests/rouletteGame.test.js`

Expected: FAIL，因为当前面板 2 后立即抽取并发送面板 3，未安装 `5,000ms` timer。

- [ ] **Step 4: 写 cleanup 取消等待失败测试**

面板 2 发布并安装揭晓 timer 后调用 `manager.cleanupGame(game)`，验证结算 Promise 正常结束，结果面板、随机抽取和 Timeout 均未发生，timer 被 clear 且不留在 `game.timers`。

```js
test('cleanup cancels and wakes the pending roulette reveal delay', async () => {
    const settlement = recruitmentCallback();
    await waitUntil(() => revealTimer !== undefined);
    await manager.cleanupGame(game);
    await settlement;
    assert.equal(revealTimer.cleared, true);
    assert.equal(game.timers.has(revealTimer), false);
    assert.equal(fixture.channelMessages.length, 1);
});
```

- [ ] **Step 5: 运行 cleanup 测试确认 RED**

Run: `node --test --test-name-pattern="cleanup cancels and wakes" local-tests/rouletteGame.test.js`

Expected: FAIL，因为当前结算没有揭晓 timer，也没有可唤醒的等待。

- [ ] **Step 6: 实现可取消揭晓 timer**

在 `rouletteGame.js` 增加：

```js
const RESULT_REVEAL_DELAY_MS = 5 * 1000;

function waitForResultReveal(game) {
    return new Promise(resolve => {
        let finished = false;
        const finish = revealed => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            game.timers.delete(timer);
            if (game.resultReveal?.timer === timer) game.resultReveal = null;
            resolve(revealed);
        };
        const timer = setTimeout(() => finish(true), game.resultRevealDelayMs);
        timer.unref?.();
        game.timers.add(timer);
        game.resultReveal = { timer, finish };
    });
}

function cancelResultReveal(game) {
    if (!game?.resultReveal) return false;
    game.resultReveal.finish(false);
    return true;
}
```

provisional game 设置 `resultRevealDelayMs: RESULT_REVEAL_DELAY_MS`。`cleanupRouletteGame` 在等待 panel queue 和 manager cleanup 前先调用 `cancelResultReveal(game)`；`provisionalGame.disableComponents` 也必须先同步调用 `cancelResultReveal(game)`，确保外部直接调用 `gameManager.cleanupGame(game)` 时同样能唤醒等待。

- [ ] **Step 7: 把五秒等待插入面板 2 与抽取之间**

`startingMessage` 发布成功后执行：

```js
if (!await waitForResultReveal(game)) {
    await cleanupRouletteGame(game);
    return;
}
```

随后才进入最终参与者复验、`drawRouletteOutcome`、面板 3 和 Timeout。不得把该 await 放进 `runExclusive`。

- [ ] **Step 8: 验证轮盘完整测试**

Run: `node --test local-tests/rouletteGame.test.js`

Expected: 现有 29 项加 2 项新增测试共 31 项 PASS，0 fail/cancelled/skipped/todo。

- [ ] **Step 9: 提交轮盘生产修改**

Run: `node --check src/modules/mystery/services/rouletteGame.js`

Run: `git diff --check`

```bash
git add src/modules/mystery/services/rouletteGame.js
git commit -m "feat(mystery): delay roulette result reveal"
```

### Task 2: 死斗七轮无胜者失效

**Files:**
- Modify: `local-tests/duelGame.test.js`
- Modify: `src/modules/mystery/services/duelGame.js`

**Interfaces:**
- Consumes: `snapshot.number`、`snapshot.final`、`queuePublicWrite(game, operation)`、`cleanupDuelGame(game)`。
- Produces: `MAX_DUEL_ROUNDS = 7` 和七轮失效公开分支；不改变 `resolveChoices` 或先得两分终局接口。

- [ ] **Step 1: 写第六轮继续、第七轮失效失败测试**

使用真实 `handleDuelInteraction` 连续提交相同选择产生平局：

```js
for (let number = 1; number <= 6; number += 1) {
    await chooseTie(fixture, game);
}
assert.equal(game.round.number, 7);

await chooseTie(fixture, game);
assert.equal(manager.getGame(game.id), undefined);
assert.match(descriptionOf(fixture.publicMessages.at(-1).payload), /死斗已失效/);
assert.equal(game.roundNumber, 7);
```

同时断言失效文案包含“双方鏖战 **7 轮**”和“双方均不受处罚”，两位成员 Timeout 调用均为 0。

- [ ] **Step 2: 运行七轮测试确认 RED**

Run: `node --test --test-name-pattern="seventh round" local-tests/duelGame.test.js`

Expected: FAIL，因为当前第七轮平局后会创建第八轮。

- [ ] **Step 3: 写优先级和失败 cleanup 测试**

新增三项行为测试：

1. 前六轮为平局，第七轮一方仅取得第一分时仍失效且不处罚。
2. 第一轮取得一分、第二至第六轮平局、第七轮取得第二分时沿用胜负终局，只 Timeout 败者一次且无失效文案。
3. 七轮失效消息发送失败时仍释放游戏、频道和玩家锁，不产生第八轮或 Timeout。

- [ ] **Step 4: 运行优先级测试确认 RED**

Run: `node --test --test-name-pattern="seven-round cap|seventh-round win|failed seven-round" local-tests/duelGame.test.js`

Expected: FAIL，当前不存在 round cap 分支。

- [ ] **Step 5: 写邀请规则可见性失败测试**

分别启动指定对手和公开邀请，读取真实 invitation embed，验证都同时包含：

```js
assert.match(description, /三局两胜/);
assert.match(description, /最多进行 \*\*7 轮\*\*；仍未分出胜负则自动失效/);
```

- [ ] **Step 6: 运行邀请规则测试确认 RED**

Run: `node --test --test-name-pattern="invitation rules show" local-tests/duelGame.test.js`

Expected: FAIL，因为现有邀请只显示“三局两胜”。

- [ ] **Step 7: 实现七轮失效分支和规则文案**

在 `duelGame.js` 增加：

```js
const MAX_DUEL_ROUNDS = 7;
const ROUND_LIMIT_DESCRIPTION = [
    '⌛ **死斗已失效**',
    '',
    '双方鏖战 **7 轮**，仍然没有分出胜负。',
    '',
    '本场死斗到此为止，双方均不受处罚。',
].join('\n');
```

两个 invitation description 的规则列表都新增：

```js
'- 最多进行 **7 轮**；仍未分出胜负则自动失效',
```

在 `publishRoundResolution` 的 `snapshot.final` 分支之后、创建下一轮之前，若 `snapshot.number >= MAX_DUEL_ROUNDS`：短锁内校验当前 round/state 并把 `game.state = 'ended'`，锁外排队发布 `ROUND_LIMIT_DESCRIPTION`，随后无条件 cleanup 并返回，不调用 `createRound`。

- [ ] **Step 8: 验证死斗完整测试**

Run: `node --test local-tests/duelGame.test.js`

Expected: 现有 45 项加 5 项新增测试共 50 项 PASS，0 fail/cancelled/skipped/todo。

- [ ] **Step 9: 提交死斗生产修改**

Run: `node --check src/modules/mystery/services/duelGame.js`

Run: `git diff --check`

```bash
git add src/modules/mystery/services/duelGame.js
git commit -m "feat(mystery): cap duels at seven rounds"
```

### Task 3: 全量验证与本地重启

**Files:**
- No production file changes.

**Interfaces:**
- Consumes: 全部 `local-tests/*.test.js`、ignored `.env`、ignored proxy bootstrap、Clash `127.0.0.1:7890`。
- Produces: 通过全量验证的分支和一个加载最新代码的本地 Node Bot 进程。

- [ ] **Step 1: 运行全量本地测试**

Run: `$tests = Get-ChildItem local-tests -Filter *.test.js | ForEach-Object FullName; node --test $tests`

Expected: 现有 166 项加 7 项新增测试共 173 项 PASS，0 fail/cancelled/skipped/todo。

- [ ] **Step 2: 运行生产语法和提交范围检查**

Run: `node --check src/modules/mystery/services/rouletteGame.js`

Run: `node --check src/modules/mystery/services/duelGame.js`

Run: `git diff --check 3ef6370..HEAD`

Expected: 全部 exit 0；生产代码仅改两个服务，规格/计划文档单独可见；`.env`、日志、cooldown 数据和代理辅助文件均未跟踪。

- [ ] **Step 3: 停止当前 Bot 并重新启动**

先核对 PID `36072` 仍为当前 Node Bot，然后停止。使用现有 ignored proxy bootstrap 和 `LOCAL_DISCORD_PROXY=http://127.0.0.1:7890` 隐藏启动新 Node 进程，stdout/stderr 写入新的 ignored 本地日志。

- [ ] **Step 4: 验证部署状态**

确认新 PID 存活且 Responding，日志包含 `Logged in as 测试BOT#8902`、73 条命令注册 `Success: 1, Failed: 0` 和“机器人已完全启动”；stderr 无 `Unhandled`、`unhandledRejection` 或 `uncaughtException`。保留分支，不推送、不创建 PR。
