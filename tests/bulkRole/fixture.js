const { Client, Guild, PermissionFlagsBits } = require('discord.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUILD = '100000000000000001';
const ACTOR = '100000000000000002';
const BOT = '100000000000000003';
const ROLE = '100000000000000020';
const OTHER = '100000000000000021';
const ids = n => Array.from({ length: n }, (_, i) => String(200000000000000000n + BigInt(i)));
function temp(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-role-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

// Real SDK role hierarchy/member-role APIs; only the REST boundary is replaced.
function fixture(n = 2, hasRole = false) {
    const client = new Client({ intents: [] });
    client.user = client.users._add({ id: BOT, username: 'bot', bot: true });
    const rawRoles = [
        { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
        { id: '100000000000000010', name: 'admin', permissions: String(PermissionFlagsBits.Administrator), position: 10 },
        { id: '100000000000000011', name: 'bot', permissions: String(PermissionFlagsBits.ManageRoles), position: 11 },
        { id: ROLE, name: 'target', permissions: '0', position: 2 },
        { id: OTHER, name: 'other', permissions: '0', position: 1 },
    ];
    const guild = new Guild(client, { id: GUILD, name: 'test', owner_id: '100000000000000099', roles: rawRoles });
    const states = new Map(ids(n).map(id => [id, new Set(hasRole ? [ROLE, OTHER] : [OTHER])]));
    states.set(ACTOR, new Set(['100000000000000010']));
    states.set(BOT, new Set(['100000000000000011']));
    const effects = { writes: [], reads: [], beforeWrite: null, beforeRead: null };
    client.guilds.fetch = async id => { if (id !== GUILD) throw new Error('wrong guild'); return guild; };
    guild.fetch = async () => guild;
    guild.roles.fetch = async () => guild.roles.cache;
    guild.members.fetch = async options => {
        if (!options || typeof options.user !== 'string' || options.force !== true || options.cache !== false) throw new Error('must fetch one fresh member');
        effects.reads.push(options.user);
        if (effects.beforeRead) await effects.beforeRead(options.user);
        const roles = states.get(options.user);
        if (!roles) throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
        return guild.members._add({ user: { id: options.user, username: 'member' }, roles: [...roles] }, false);
    };
    async function write(route, options, adding) {
        const match = route.match(/^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/);
        if (!match || match[1] !== GUILD || match[3] !== ROLE) throw new Error('only the specified role may be changed');
        if (effects.beforeWrite) await effects.beforeWrite(match[2], adding);
        effects.writes.push({ id: match[2], adding, reason: options.reason });
        if (adding) states.get(match[2]).add(match[3]);
        else states.get(match[2]).delete(match[3]);
    }
    client.rest.put = (route, options) => write(route, options, true);
    client.rest.delete = (route, options) => write(route, options, false);
    const safetyOptions = {
        checkPermission: member => member.permissions.has(PermissionFlagsBits.Administrator),
        allowedRoles: () => ['1511670629055725829'],
        checkCompatibility: async () => {},
    };
    const transport = {
        async change(job, userId) {
            const member = guild.members._add({ user: { id: userId, username: 'member' }, roles: [...(states.get(userId) || [])] }, false);
            const reason = `BulkRole task=${job.id} actor=${job.actorId} action=${job.action}`;
            if (job.action === 'add') await member.roles.add(job.roleId, reason);
            else await member.roles.remove(job.roleId, reason);
        },
        close() {},
    };
    return { client, guild, states, effects, rawRoles, safetyOptions, transport, spec: { guildId: GUILD, actorId: ACTOR, roleId: ROLE, action: 'add' } };
}
module.exports = { fixture, temp, ids, GUILD, ACTOR, BOT, ROLE, OTHER };
