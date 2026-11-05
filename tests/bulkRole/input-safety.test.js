const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PermissionFlagsBits } = require('discord.js');
const { fixture, temp, ids, GUILD, ACTOR, BOT, ROLE } = require('./fixture');
const { parseIds } = require('../../src/modules/bulkRole/input');
const { Safety } = require('../../src/modules/bulkRole/safety');
const { checkCompatibility } = require('../../src/modules/bulkRole/compatibility');

test('parses 200 IDs, trims and deduplicates in first-seen order', () => {
    assert.deepEqual(parseIds(` ${ids(2)[1]} ,${ids(2)[0]}, ${ids(2)[1]} `), { ids: [ids(2)[1], ids(2)[0]], inputCount: 3 });
    assert.equal(parseIds(ids(200).join(',')).ids.length, 200);
});
test('rejects empty, malformed, overflow, wrong separator and oversized lists without dropping tokens', () => {
    for (const value of ['', ' ', `${ids(1)[0]},`, `,${ids(1)[0]}`, '123', '0', '012345678901234567', '18446744073709551616', `${ids(1)[0]}，${ids(2)[1]}`, '<@123456789012345678>', '1e18', ids(201).join(','), ' '.repeat(6001)]) {
        assert.throws(() => parseIds(value));
    }
});
test('refreshes authorization and enforces all protected role restrictions, including server owner', async t => {
    for (const kind of ['admin', 'managed', 'everyone', 'actorEqual', 'actorHigher', 'botEqual', 'botHigher', 'allowlist', 'noManageRoles', 'revoked']) {
        await t.test(kind, async () => {
            const f = fixture();
            f.guild.ownerId = ACTOR;
            const role = f.guild.roles.cache.get(ROLE);
            if (kind === 'admin') role.permissions = new (require('discord.js').PermissionsBitField)(PermissionFlagsBits.Administrator);
            if (kind === 'managed') role.managed = true;
            if (kind === 'everyone') f.spec.roleId = GUILD;
            if (kind === 'actorEqual') f.states.set(ACTOR, new Set([ROLE]));
            if (kind === 'actorHigher') role.rawPosition = 30;
            if (kind === 'botEqual') {
                role.permissions = new (require('discord.js').PermissionsBitField)(PermissionFlagsBits.ManageRoles);
                f.states.set(BOT, new Set([ROLE]));
            }
            if (kind === 'botHigher') { role.rawPosition = 12; f.guild.roles.cache.get('100000000000000010').rawPosition = 20; }
            if (kind === 'allowlist') f.safetyOptions.allowedRoles = () => [ROLE];
            if (kind === 'noManageRoles') f.states.set(BOT, new Set());
            if (kind === 'revoked') f.safetyOptions.checkPermission = () => false;
            await assert.rejects(new Safety(f.client, f.safetyOptions).check(f.spec));
            assert.equal(f.effects.writes.length, 0);
        });
    }
});
test('uses SDK comparison for roles sharing the same numeric position', async () => {
    const f = fixture();
    f.guild.roles.cache.get(ROLE).rawPosition = 10;
    // Target's larger snowflake sorts below the actor at the same position.
    await new Safety(f.client, f.safetyOptions).check(f.spec);
    f.guild.roles.cache.get('100000000000000010').rawPosition = 2;
    f.guild.roles.cache.get(ROLE).rawPosition = 10;
    await assert.rejects(new Safety(f.client, f.safetyOptions).check(f.spec));
});
test('does not reuse interaction member cache, and compatibility errors fail closed', async () => {
    const f = fixture();
    const safety = new Safety(f.client, f.safetyOptions);
    await safety.check(f.spec);
    f.states.set(ACTOR, new Set());
    await assert.rejects(safety.check(f.spec));
    assert.ok(f.effects.reads.filter(id => id === ACTOR).length >= 2);
    const broken = new Safety(f.client, { ...f.safetyOptions, checkCompatibility: async () => { throw new Error('read failure'); } });
    await assert.rejects(broken.check(f.spec));
});
test('default Safety delegates to unchanged original owner, Administrator and management-role rules', async () => {
    const root = path.resolve(__dirname, '../..');
    function isolated(relative, override) {
        const filename = path.join(root, relative);
        const localRequire = createRequire(filename);
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, exports: module.exports, console,
            require: request => Object.hasOwn(override, request) ? override[request] : localRequire(request),
        }, { filename });
        return module.exports;
    }
    const permissions = isolated('src/core/utils/permissionManager.js', { './database': {} });
    const { Safety: DefaultSafety } = isolated('src/modules/bulkRole/safety.js', { '../../core/utils/permissionManager': permissions });
    const f = fixture();
    const safety = new DefaultSafety(f.client, { checkCompatibility: async () => {} });
    await safety.check(f.spec); // native Administrator
    const whiteId = permissions.getAllowedRoles()[0];
    f.guild.roles._add({ id: whiteId, name: 'management', permissions: '0', position: 10 });
    f.states.set(ACTOR, new Set([whiteId]));
    await safety.check(f.spec); // configured management role, without Administrator
    await assert.rejects(safety.check({ ...f.spec, roleId: whiteId }), /白名单/);
    f.states.set(ACTOR, new Set());
    await assert.rejects(safety.authorize(f.spec));
    f.guild.ownerId = ACTOR;
    await safety.authorize(f.spec); // owner remains authorized without a management role
    await assert.rejects(safety.check(f.spec), /操作者最高/); // still no hierarchy exemption
});
test('read-only compatibility detects either end of enabled cross-guild mapping and pending jobs', async t => {
    const directory = temp(t);
    const db = new Database(path.join(directory, 'roleSync.sqlite'));
    db.exec(`CREATE TABLE sync_links(link_id TEXT, source_guild_id TEXT, target_guild_id TEXT, enabled INTEGER);
        CREATE TABLE role_sync_map(link_id TEXT, source_role_id TEXT, target_role_id TEXT, enabled INTEGER);
        CREATE TABLE sync_jobs(target_guild_id TEXT,target_role_id TEXT,source_guild_id TEXT,source_role_id TEXT,status TEXT);
        INSERT INTO sync_links VALUES('link','${GUILD}','other',1);
        INSERT INTO role_sync_map VALUES('link','${ROLE}','remote',1);`);
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /跨服/);
    assert.throws(() => checkCompatibility('other', 'remote', { dataDirectory: directory }), /跨服/);
    db.exec('UPDATE sync_links SET enabled=0');
    checkCompatibility(GUILD, ROLE, { dataDirectory: directory });
    db.prepare('INSERT INTO sync_jobs VALUES(?,?,?,?,?)').run(GUILD, ROLE, 'other', 'remote', 'pending');
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /跨服/);
    db.close();
});
test('rejects self-service primary, bundle and active historical grant roles; does not write existing DB', t => {
    const directory = temp(t);
    const db = new Database(path.join(directory, 'selfRole.sqlite'));
    db.exec('CREATE TABLE role_settings(guild_id TEXT,roles TEXT); CREATE TABLE sr_grants(grant_id TEXT,guild_id TEXT,primary_role_id TEXT,status TEXT); CREATE TABLE sr_grant_roles(grant_id TEXT,role_id TEXT);');
    db.prepare('INSERT INTO role_settings VALUES(?,?)').run(GUILD, JSON.stringify([{ roleId: ROLE, bundleRoleIds: ['bundle'] }]));
    for (const role of [ROLE, 'bundle']) assert.throws(() => checkCompatibility(GUILD, role, { dataDirectory: directory }), /自助/);
    db.exec('DELETE FROM role_settings');
    db.prepare('INSERT INTO sr_grants VALUES(?,?,?,?)').run('grant', GUILD, ROLE, 'active');
    db.prepare('INSERT INTO sr_grant_roles VALUES(?,?)').run('grant', 'old-bundle');
    for (const role of [ROLE, 'old-bundle']) assert.throws(() => checkCompatibility(GUILD, role, { dataDirectory: directory }), /自助/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sr_grants').get().n, 1);
    db.close();
});
test('rejects conflicting automation and broken JSON or database schemas', t => {
    const directory = temp(t);
    const settings = path.join(directory, 'archiveSettings.json');
    fs.writeFileSync(settings, JSON.stringify({ [GUILD]: { viewRoleId: ROLE } }));
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /自助/);
    fs.writeFileSync(settings, '{broken');
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }));
    fs.unlinkSync(settings);
    fs.writeFileSync(path.join(directory, 'roleSync.sqlite'), 'broken');
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }));
});
test('rejects known warning/four-word, contest, review and notification automation', t => {
    const directory = temp(t);
    const db = new Database(path.join(directory, 'punishment.sqlite'));
    db.exec('CREATE TABLE punishment_warn_role_config(guild_id TEXT,role_id TEXT); CREATE TABLE punishment_settings(guild_id TEXT,key TEXT,value TEXT);');
    db.prepare('INSERT INTO punishment_warn_role_config VALUES(?,?)').run(GUILD, ROLE);
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /处罚/);
    db.exec('DELETE FROM punishment_warn_role_config');
    db.prepare('INSERT INTO punishment_settings VALUES(?,?,?)').run(GUILD, 'four_word_config', JSON.stringify({ normalRoleId: ROLE }));
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /处罚/);
    db.exec('DELETE FROM punishment_settings');
    db.close();
    const contests = path.join(directory, 'contestChannels.json');
    fs.writeFileSync(contests, JSON.stringify({ channel: { guildId: GUILD, participantRoleId: ROLE, autoGrantRole: true } }));
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /赛事/);
    fs.unlinkSync(contests);
    const review = path.join(directory, 'reviewSettings.json');
    fs.writeFileSync(review, JSON.stringify({ [GUILD]: { rewardRoleId: ROLE } }));
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory }), /自助/);
    fs.unlinkSync(review);
    const notificationFile = path.join(directory, 'notification_roles.json');
    fs.writeFileSync(notificationFile, JSON.stringify({ [GUILD]: { roles: [{ roleId: ROLE }] } }));
    assert.throws(() => checkCompatibility(GUILD, ROLE, { dataDirectory: directory, notificationFile }), /自助/);
});
