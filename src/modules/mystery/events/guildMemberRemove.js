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

async function mysteryGuildMemberRemoveHandler(member) {
    const ids = getMemberIds(member);
    if (!ids) {
        return;
    }

    try {
        await gameManager.handleGuildMemberRemove(member);
    } catch (_) {
        console.error(
            `[Mystery] member invalidation failed guildId=${ids.guildId} userId=${ids.userId} reason=member-remove`
        );
    }
}

module.exports = { mysteryGuildMemberRemoveHandler };
