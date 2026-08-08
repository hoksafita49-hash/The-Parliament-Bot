const gameManager = require('../services/mysteryGameManager');

function getMemberIds(member) {
    const guildId = member?.guild?.id;
    const memberId = member?.id;
    const userId = member?.user?.id;

    if (!guildId || (!memberId && !userId)) {
        return null;
    }
    if (memberId && userId && memberId !== userId) {
        return null;
    }

    return { guildId, userId: userId || memberId };
}

function isFiniteTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

async function mysteryGuildMemberUpdateHandler(oldMember, newMember) {
    const oldIds = getMemberIds(oldMember);
    const newIds = getMemberIds(newMember);
    if (
        !oldIds
        || !newIds
        || oldIds.guildId !== newIds.guildId
        || oldIds.userId !== newIds.userId
    ) {
        return;
    }

    const now = Date.now();
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;
    const oldIsActive = isFiniteTimestamp(oldTimeout) && oldTimeout > now;
    const newIsActive = isFiniteTimestamp(newTimeout) && newTimeout > now;
    if (oldIsActive || !newIsActive) {
        return;
    }

    try {
        await gameManager.handleGuildMemberUpdate(oldMember, newMember);
    } catch (_) {
        console.error(
            `[Mystery] member invalidation failed guildId=${newIds.guildId} userId=${newIds.userId} reason=timeout`
        );
    }
}

module.exports = { mysteryGuildMemberUpdateHandler };
