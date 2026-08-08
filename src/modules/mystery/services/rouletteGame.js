const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');

const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const ROULETTE_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const ROULETTE_TIMEOUT_REASON = '神秘指令：运气轮盘';
const MAX_PARTICIPANTS = 6;
const MIN_PARTICIPANTS = 3;

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const TIMEOUT_BLOCKED_MESSAGE = '🎰 **轮盘拒绝了你。**\n你当前还在禁言，暂时无法参加。';
const INVALID_MEMBER_MESSAGE = '⚠️ **你现在无法参加这场运气轮盘。**';
const EXPIRED_MESSAGE = '⌛ **这场运气轮盘已经结束或失效了。**';
const FULL_MESSAGE = '🎰 **这场运气轮盘已经满员了。**';
const DUPLICATE_MESSAGE = '👀 **你已经参加这场游戏了。**\n再点也不会增加中奖概率。';
const JOINED_MESSAGE = '✅ **你已加入运气轮盘**\n\n接下来就看命了。';
const JOIN_FAILURE_MESSAGE = '❌ **参加运气轮盘失败了。**\n请稍后再试。';

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryRoulette] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function recruitmentDescription(game) {
    return [
        '🎰 **运气轮盘已开启**',
        '',
        `<@${game.initiatorId}> 发起了一场运气轮盘，并已自动加入游戏。`,
        '',
        '**游戏规则**',
        '- 本游戏为自愿参加，点击按钮即视为接受游戏规则',
        '- 最少 **3 人**、最多 **6 人**',
        '- 满 **6 人**立即开始',
        '- 未满 6 人将在 **3 分钟后**尝试开始',
        '- 游戏开始后，将从参与者中随机挑选一名“幸运儿”',
        '- 被选中的玩家将被 **禁言 5 分钟**',
        '',
        `**当前人数：${game.participantIds.length} / 6**`,
    ].join('\n');
}

function cancellationDescription() {
    return [
        '🥀 **运气轮盘开不起来了**',
        '',
        '等待 3 分钟后，本轮仍未达到最低 **3 人**。',
        '',
        '本轮游戏自动取消。',
        '',
        '看来今天大家都很珍惜自己的发言权。',
    ].join('\n');
}

function startingDescription(count) {
    return [
        '🎰 **轮盘开始转动……**',
        '',
        `本局共有 **${count} 名玩家**。`,
        '',
        '正在从各位勇士之中挑选幸运儿……',
        '',
        '**祝你好运。**',
        '',
        '*或者祝别人好运。*',
    ].join('\n');
}

function ordinaryResultDescription(userId, timeoutFailed) {
    const lines = [
        '🎉 **恭喜幸运儿诞生！**',
        '',
        '在本轮运气轮盘中，',
        '',
        `🎯 **<@${userId}>**`,
        '',
        '成功从所有参与者中脱颖而出！',
        '',
        '奖励是：',
        '**禁言 5 分钟。**',
        '',
        '感谢其他玩家陪跑。',
    ];
    if (timeoutFailed) {
        lines.push('', '🛡️ **但禁言被神秘力量阻挡，未能生效。**');
    }
    return lines.join('\n');
}

function allWinnersResultDescription(hasTimeoutFailures) {
    const lines = [
        '🚨 **等等，好像哪里不对……**',
        '',
        '轮盘在最后一刻突然失控。',
        '',
        '本轮似乎没有选出幸运儿。',
        '',
        '因为——',
        '',
        '🎰 **恭喜，全员中奖。**',
        '',
        '本局所有参与者将被 **禁言 5 分钟**。',
        '',
        '*看来今天的幸运比较平均。*',
    ];
    if (hasTimeoutFailures) {
        lines.push('', '🛡️ **部分禁言被神秘力量阻挡，未能生效。**');
    }
    return lines.join('\n');
}

function makeEmbed(description) {
    return new EmbedBuilder().setDescription(description);
}

function joinRow(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_roulette_join:${gameId}`)
            .setLabel('🎰 自愿参加')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

function recruitmentPayload(game, disabled = false) {
    return {
        embeds: [makeEmbed(recruitmentDescription(game))],
        components: [joinRow(game.id, disabled)],
    };
}

async function safeEphemeralReply(interaction, content, game) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    try {
        if (interaction.deferred || interaction.replied) {
            if (typeof interaction.followUp === 'function') {
                await interaction.followUp(payload);
            }
        } else if (typeof interaction.reply === 'function') {
            await interaction.reply(payload);
        }
    } catch (error) {
        logDiscordFailure(game, 'ephemeral-reply', error, interaction.user?.id);
    }
}

function isActivelyTimedOut(member, now = Date.now()) {
    return Number(member?.communicationDisabledUntilTimestamp) > now;
}

function isValidHumanMember(member) {
    return Boolean(member?.id && member.user && !member.user.bot && !isActivelyTimedOut(member));
}

async function fetchMember(game, userId) {
    try {
        return await game.guild.members.fetch(userId);
    } catch (error) {
        logDiscordFailure(game, 'fetch-member', error, userId);
        return null;
    }
}

function drawRouletteOutcome(participantIds, random = Math.random) {
    const ids = [...participantIds];
    if (ids.length === 0) {
        return { allWinners: false, selectedIds: [] };
    }
    if (random() < 0.05) {
        return { allWinners: true, selectedIds: ids };
    }
    const index = Math.min(ids.length - 1, Math.floor(random() * ids.length));
    return { allWinners: false, selectedIds: [ids[Math.max(0, index)]] };
}

async function editPublicPanel(game, payload, action) {
    if (!game.message || typeof game.message.edit !== 'function') return false;
    try {
        await game.message.edit(payload);
        return true;
    } catch (error) {
        logDiscordFailure(game, action, error);
        return false;
    }
}

async function refreshValidParticipants(game) {
    const validMembers = new Map();
    for (const userId of [...game.participantIds]) {
        const member = await fetchMember(game, userId);
        if (!isValidHumanMember(member)) {
            gameManager.removePlayer(game, userId);
            continue;
        }
        validMembers.set(userId, member);
    }
    return validMembers;
}

async function applyTimeouts(game, outcome, members) {
    const failedIds = [];
    for (const userId of outcome.selectedIds) {
        const member = members.get(userId);
        if (!member?.moderatable || typeof member.timeout !== 'function') {
            failedIds.push(userId);
            continue;
        }
        try {
            await member.timeout(ROULETTE_TIMEOUT_DURATION_MS, ROULETTE_TIMEOUT_REASON);
        } catch (error) {
            failedIds.push(userId);
            logDiscordFailure(game, 'timeout-member', error, userId);
        }
    }
    return failedIds;
}

async function finishRecruitment(game) {
    let ownsSettlement = false;
    await gameManager.runExclusive(game, async () => {
        if (game.ended || game.state !== 'recruiting') return;

        game.state = 'starting';
        ownsSettlement = true;
        if (game.recruitmentTimer) {
            clearTimeout(game.recruitmentTimer);
            game.timers.delete(game.recruitmentTimer);
            game.recruitmentTimer = null;
        }

        const members = await refreshValidParticipants(game);
        if (game.participantIds.length < MIN_PARTICIPANTS) {
            await editPublicPanel(game, {
                embeds: [makeEmbed(cancellationDescription())],
                components: [joinRow(game.id, true)],
            }, 'cancel-panel');
            game.state = 'ended';
            return;
        }

        await editPublicPanel(game, {
            embeds: [makeEmbed(startingDescription(game.participantIds.length))],
            components: [joinRow(game.id, true)],
        }, 'starting-panel');

        const outcome = drawRouletteOutcome(game.participantIds, game.random);
        game.outcome = outcome;
        game.resolved = true;
        const failedIds = await applyTimeouts(game, outcome, members);
        const description = outcome.allWinners
            ? allWinnersResultDescription(failedIds.length > 0)
            : ordinaryResultDescription(outcome.selectedIds[0], failedIds.length > 0);
        await editPublicPanel(game, {
            embeds: [makeEmbed(description)],
            components: [],
        }, 'result-panel');
        game.componentsDisabled = true;
        game.state = 'ended';
    });

    if (ownsSettlement) {
        await gameManager.cleanupGame(game);
    }
}

async function startRoulette(interaction) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const provisionalGame = {
        id: randomUUID(),
        type: 'roulette',
        guildId,
        channelId,
        guild: interaction.guild,
        initiatorId: userId,
        participantIds: [userId],
        state: 'recruiting',
        resolved: false,
        random: Math.random,
        timers: new Set(),
    };

    const member = await fetchMember(provisionalGame, userId);
    if (!member || member.user?.bot) {
        await safeEphemeralReply(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
        return false;
    }
    if (isActivelyTimedOut(member)) {
        await safeEphemeralReply(interaction, TIMEOUT_BLOCKED_MESSAGE, provisionalGame);
        return false;
    }

    let game;
    provisionalGame.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleRouletteMemberInvalidated(game, invalidUserId, 'member-invalidated');
        }
    };
    provisionalGame.disableComponents = async () => {
        if (!game || game.componentsDisabled || !game.message) return;
        const disabled = await editPublicPanel(game, {
            components: [joinRow(game.id, true)],
        }, 'disable-components');
        if (disabled) game.componentsDisabled = true;
    };

    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await safeEphemeralReply(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE,
            provisionalGame
        );
        return false;
    }
    game = created.game;

    try {
        await interaction.reply(recruitmentPayload(game));
        game.message = await interaction.fetchReply();
    } catch (error) {
        logDiscordFailure(game, 'recruitment-panel', error, userId);
        await gameManager.cleanupGame(game);
        return false;
    }

    game.recruitmentTimer = setTimeout(
        () => finishRecruitment(game).catch(error => logDiscordFailure(game, 'recruitment-timer', error)),
        RECRUITMENT_DURATION_MS
    );
    game.timers.add(game.recruitmentTimer);
    return true;
}

function parseJoinParts(parts) {
    const tokens = (Array.isArray(parts) ? parts : [parts])
        .filter(part => typeof part === 'string')
        .flatMap(part => part.split(/[:_]/))
        .filter(Boolean)
        .filter(part => part !== 'mystery' && part !== 'roulette');
    const actionIndex = tokens.indexOf('join');
    if (actionIndex === -1) return null;
    return tokens[actionIndex + 1] || tokens.at(-1);
}

async function handleRouletteInteraction(interaction, parts) {
    const gameId = parseJoinParts(parts);
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'roulette') {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    let startWhenUnlocked = false;
    let joined = false;
    await gameManager.runExclusive(game, async () => {
        const userId = interaction.user?.id;
        if (
            game.ended
            || game.state !== 'recruiting'
            || interaction.channelId !== game.channelId
            || (interaction.guildId || interaction.guild?.id) !== game.guildId
        ) {
            await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
            return;
        }
        if (game.participantIds.includes(userId)) {
            await safeEphemeralReply(interaction, DUPLICATE_MESSAGE, game);
            return;
        }
        if (game.participantIds.length >= MAX_PARTICIPANTS) {
            await safeEphemeralReply(interaction, FULL_MESSAGE, game);
            return;
        }

        const member = await fetchMember(game, userId);
        if (!member || member.user?.bot) {
            await safeEphemeralReply(interaction, INVALID_MEMBER_MESSAGE, game);
            return;
        }
        if (isActivelyTimedOut(member)) {
            await safeEphemeralReply(interaction, TIMEOUT_BLOCKED_MESSAGE, game);
            return;
        }
        const ownedGame = gameManager.getPlayerGame(game.guildId, userId);
        if (ownedGame && ownedGame !== game) {
            await safeEphemeralReply(interaction, PLAYER_BUSY_MESSAGE, game);
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            await safeEphemeralReply(interaction, PLAYER_BUSY_MESSAGE, game);
            return;
        }

        const panelUpdated = await editPublicPanel(game, recruitmentPayload(game), 'join-count-panel');
        if (!panelUpdated) {
            gameManager.removePlayer(game, userId);
            await safeEphemeralReply(interaction, JOIN_FAILURE_MESSAGE, game);
            return;
        }

        joined = true;
        startWhenUnlocked = game.participantIds.length === MAX_PARTICIPANTS;
        await safeEphemeralReply(interaction, JOINED_MESSAGE, game);
    });

    if (startWhenUnlocked) {
        await finishRecruitment(game);
    }
    return joined;
}

async function handleRouletteMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'roulette') return false;
    let removed = false;
    await gameManager.runExclusive(game, async () => {
        if (game.ended || game.state === 'ended') return;
        removed = gameManager.removePlayer(game, userId);
        if (!removed) return;
        if (game.state === 'recruiting') {
            await editPublicPanel(game, recruitmentPayload(game), `member-invalidated-${reason || 'unknown'}`);
        }
    });
    return removed;
}

module.exports = {
    startRoulette,
    handleRouletteInteraction,
    drawRouletteOutcome,
    handleRouletteMemberInvalidated,
};
