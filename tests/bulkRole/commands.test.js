const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { createHandlers, addRoleGroup } = require('../../src/modules/bulkRole/commands');
const { resultPayload } = require('../../src/modules/bulkRole/presentation');
const { Service } = require('../../src/modules/bulkRole/service');
const { Safety } = require('../../src/modules/bulkRole/safety');
const { Store } = require('../../src/modules/bulkRole/store');
const { fixture, temp, ids, GUILD, ACTOR, ROLE } = require('./fixture');

function setup(t) {
    const f = fixture(2);
    const store = new Store(path.join(temp(t), 'jobs.sqlite'));
    const service = new Service(f.client, { store, safety: new Safety(f.client, f.safetyOptions), transport: f.transport, wait: async () => {} });
    t.after(() => store.close());
    const handlers = createHandlers({ getService: () => service });
    function interaction(overrides = {}) {
        const replies = [];
        return {
            client: f.client, guild: f.guild, user: { id: ACTOR }, inGuild: () => true,
            options: { getSubcommand: () => '批量操作', getString: name => name === '操作' ? 'add' : ids(2).join(','), getRole: () => ({ id: ROLE }) },
            async deferReply(value) { this.deferred = true; replies.push({ kind: 'deferReply', ...value }); },
            async deferUpdate() { this.deferred = true; replies.push({ kind: 'deferUpdate' }); },
            async editReply(value) { replies.push({ kind: 'editReply', ...value }); },
            async reply(value) { this.replied = true; replies.push({ kind: 'reply', ...value }); },
            async followUp(value) { replies.push({ kind: 'followUp', ...value }); },
            replies, ...overrides,
        };
    }
    return { ...f, service, store, handlers, interaction };
}

test('registers one add/remove command, native role option and 6000-character string option', () => {
    const command = addRoleGroup(new SlashCommandBuilder().setName('管理').setDescription('管理')).toJSON();
    const group = command.options[0];
    assert.equal(group.name, '身份组');
    const batch = group.options.find(o => o.name === '批量操作');
    assert.equal(batch.options.length, 3);
    assert.deepEqual(batch.options[0].choices.map(c => c.name), ['添加', '移除']);
    assert.equal(batch.options[1].type, 8);
    assert.equal(batch.options[2].max_length, 6000);
    assert.ok(batch.options.every(o => o.required));
    assert.ok(group.options.some(o => o.name === '任务'));
});
test('preview is ephemeral and mention-safe, carries no member IDs and never writes a role', async t => {
    const f = setup(t);
    const i = f.interaction();
    await f.handlers.execute(i);
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
    const preview = i.replies.at(-1);
    assert.equal(preview.components[0].components.length, 2);
    assert.deepEqual(preview.allowedMentions, { parse: [] });
    for (const id of ids(2)) assert.ok(!preview.content.includes(id));
    assert.equal(f.effects.writes.length, 0);
});
test('buttons reject other users, expired tokens and repeated confirmation without duplicate task creation', async t => {
    const f = setup(t);
    const p = await f.service.preview(f.spec, ids(2).join(','));
    const customId = `bulkrole:confirm:${p.id}`;
    const stranger = f.interaction({ customId, user: { id: ids(1)[0] } });
    await f.handlers.button(stranger);
    assert.equal(stranger.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(f.store.preview(p.id).status, 'ready');
    const original = f.interaction({ customId });
    await f.handlers.button(original);
    assert.equal(original.replies[0].kind, 'deferUpdate');
    assert.equal(f.store.preview(p.id).status, 'consumed');
    const again = f.interaction({ customId });
    await f.handlers.button(again);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
    const expired = f.store.createPreview(f.spec, { ids: ids(1), inputCount: 1 }, {}, 1);
    await f.handlers.button(f.interaction({ customId: `bulkrole:confirm:${expired.id}` }));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
    await f.service.drain(); // finish kick before closing store
});
test('preview cancellation is owner-bound and terminal', async t => {
    const f = setup(t);
    const p = await f.service.preview(f.spec, ids(2).join(','));
    await f.handlers.button(f.interaction({ customId: `bulkrole:cancel:${p.id}` }));
    assert.equal(f.store.preview(p.id).status, 'cancelled');
    await assert.rejects(f.service.confirm(p.id, GUILD, ACTOR));
    assert.equal(f.effects.writes.length, 0);
});
test('task query and attachment delivery enforce guild, original operator and fresh authorization', async t => {
    const f = setup(t);
    const p = await f.service.preview(f.spec, ids(2).join(','));
    const job = await f.service.confirm(p.id, GUILD, ACTOR);
    await f.service.drain();
    const latest = await f.service.result(null, GUILD, ACTOR);
    assert.equal(latest.job.id, job.id, 'lost interaction acknowledgement can be recovered without a task ID');
    await assert.rejects(f.service.result(job.id, 'other', ACTOR));
    await assert.rejects(f.service.result(job.id, GUILD, 'other'));
    f.states.set(ACTOR, new Set());
    await assert.rejects(f.service.result(job.id, GUILD, ACTOR));
});
test('result counts distinguish API success, already, absent, reconciled, failure and unexecuted with private comma TXT', () => {
    const job = { id: 'job', action: 'add', roleId: ROLE, status: 'completed', updatedAt: Date.now() };
    const rows = ['success', 'already', 'absent', 'reconciled', 'failed', 'failed', 'unexecuted'].map((status, i) => ({ userId: ids(7)[i], status, reason: status === 'failed' ? 'write_network' : null }));
    const result = resultPayload({ job, rows });
    assert.match(result.content, /总人数：7/);
    assert.match(result.content, /成功.*1/);
    assert.match(result.content, /跳过.*3/);
    assert.match(result.content, /失败.*2/);
    assert.match(result.content, /未执行.*1/);
    assert.match(result.content, /核对.*1/);
    assert.deepEqual(result.allowedMentions, { parse: [] });
    assert.equal(result.files[0].attachment.toString(), `${ids(7)[4]},${ids(7)[5]}`);
    assert.ok(result.content.length <= 2000);
});

// Load existing command in isolation so regression tests cannot open existing business DBs.
function loadManage() {
    const file = path.resolve(__dirname, '../../src/modules/mystery/commands/manageCommand.js');
    const module = { exports: {} };
    const noop = async () => {};
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports,
        require(request) {
            if (request === 'discord.js') return require(request);
            if (request.includes('permissionManager')) return { checkAdminPermission: () => false, getPermissionDeniedMessage: () => 'denied' };
            if (request.includes('closeDoor')) return { executeCloseDoor: noop };
            if (request.includes('openDoor')) return { executeOpenDoor: noop };
            if (request.includes('memberIds')) return { executeMemberIds: noop };
            if (request.includes('bulkRole/commands')) return require('../../src/modules/bulkRole/commands');
            throw new Error(`Unexpected dependency: ${request}`);
        },
    }, { filename: file });
    return module.exports;
}
test('existing /管理 definitions and dependency injection routes preserve prior behavior', async () => {
    const { createManageCommand } = loadManage();
    const calls = [];
    const command = createManageCommand({ executeCloseDoor: async () => calls.push('close'), executeOpenDoor: async () => calls.push('open'), executeMemberIds: async () => calls.push('members'), executeBulkRole: async () => calls.push('bulk'), checkPermission: () => true });
    const data = command.data.toJSON();
    assert.deepEqual(data.options.map(o => o.name), ['关门', '开门', '成员id', '身份组']);
    assert.equal(data.options[0].options[0].name, '恢复时间');
    assert.equal(data.options[0].options[0].required, false);
    assert.deepEqual(data.options[2].options.map(o => o.name), ['检查', '开始', '状态', '下载']);
    for (const [sub, group] of [['关门', null], ['开门', null], ['检查', '成员id'], ['批量操作', '身份组']]) {
        await command.execute({ inGuild: () => true, options: { getSubcommand: () => sub, getSubcommandGroup: () => group } });
    }
    assert.deepEqual(calls, ['close', 'open', 'members', 'bulk']);
    const denied = createManageCommand({ checkPermission: () => false });
    const replies = [];
    await denied.execute({ inGuild: () => true, options: { getSubcommandGroup: () => null }, reply: async p => replies.push(p) });
    assert.equal(replies[0].content, 'denied');
});
