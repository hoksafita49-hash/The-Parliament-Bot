const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { Store } = require('../../src/modules/bulkRole/store');
const { Safety } = require('../../src/modules/bulkRole/safety');
const { Service } = require('../../src/modules/bulkRole/service');
const { Transport } = require('../../src/modules/bulkRole/transport');
const { temp, fixture, ids, GUILD, ACTOR, ROLE, OTHER } = require('./fixture');

function setup(t, n = 2, hasRole = false) {
    const f = fixture(n, hasRole);
    const store = new Store(path.join(temp(t), 'jobs.sqlite'));
    let now = 1000000;
    const service = new Service(f.client, { store, safety: new Safety(f.client, f.safetyOptions), transport: f.transport, now: () => now, wait: async () => {}, logger: { error() {} } });
    t.after(() => store.close());
    return { ...f, store, service, advance: ms => { now += ms; } };
}
async function queue(f, action = 'add', list = ids(f.states.size - 2)) {
    const preview = await f.service.preview({ ...f.spec, action }, list.join(','));
    assert.equal(f.effects.writes.length, 0, 'preview must never mutate roles');
    return f.service.confirm(preview.id, GUILD, ACTOR);
}
for (const action of ['add', 'remove']) {
    test(`processes exactly 200 members with official single-role ${action}, preserves all other roles`, async t => {
        const f = setup(t, 200, action === 'remove');
        const job = await queue(f, action);
        await Promise.all([f.service.drain(), f.service.drain()]);
        assert.equal(f.store.get(job.id).status, 'completed');
        assert.equal(f.effects.writes.length, 200);
        assert.ok(f.store.rows(job.id).every(row => row.status === 'success'));
        for (const id of ids(200)) {
            assert.equal(f.states.get(id).has(ROLE), action === 'add');
            assert.equal(f.states.get(id).has(OTHER), true);
        }
        assert.ok(f.effects.writes.every(w => w.reason.includes(job.id) && w.reason.includes(ACTOR)));
    });
}
test('preview counts duplicate, already, absent and exceptional members; execution reads state again', async t => {
    const f = setup(t, 4);
    f.states.get(ids(1)[0]).add(ROLE);
    f.states.delete(ids(3)[2]);
    f.effects.beforeRead = async id => { if (id === ids(4)[3]) throw Object.assign(new Error('read denied'), { status: 403 }); };
    const p = await f.service.preview(f.spec, `${ids(4).join(',')},${ids(1)[0]}`);
    assert.equal(p.inputCount, 5);
    assert.deepEqual(p.counts, { change: 1, already: 1, absent: 1, other: 1 });
    f.effects.beforeRead = null;
    f.states.get(ids(2)[1]).add(ROLE); // preview is only a snapshot
    const job = await f.service.confirm(p.id, GUILD, ACTOR);
    await f.service.drain();
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['already', 'already', 'absent', 'success']);
});
test('rechecks confirmation and execution authorization and stops immediately after mid-task revocation', async t => {
    const f = setup(t, 3);
    const p = await f.service.preview(f.spec, ids(3).join(','));
    f.states.set(ACTOR, new Set());
    await assert.rejects(f.service.confirm(p.id, GUILD, ACTOR));
    assert.equal(f.store.preview(p.id).status, 'ready');
    f.states.set(ACTOR, new Set(['100000000000000010']));
    const job = await f.service.confirm(p.id, GUILD, ACTOR);
    f.effects.beforeWrite = async () => { f.states.set(ACTOR, new Set()); };
    await f.service.drain();
    assert.equal(f.effects.writes.length, 1);
    assert.equal(f.store.get(job.id).status, 'stopped');
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['success', 'unexecuted', 'unexecuted']);
});
test('429 and transient faults persist bounded backoff and reread actual state on retry', async t => {
    const f = setup(t, 1);
    const job = await queue(f);
    let failures = 0;
    f.effects.beforeWrite = async () => {
        if (failures++ === 0) throw Object.assign(new Error('rate limited'), { status: 429, rawError: { retry_after: 10 } });
    };
    await f.service.drain();
    assert.equal(f.store.get(job.id).status, 'running');
    assert.equal(f.store.get(job.id).nextAt, 1010000);
    assert.equal(f.store.rows(job.id)[0].status, 'inflight');
    await f.service.drain();
    assert.equal(f.effects.writes.length, 0);
    f.advance(10000);
    await f.service.drain();
    assert.equal(f.store.rows(job.id)[0].status, 'success');
    assert.equal(f.effects.writes.length, 1);
});
test('repeated network writes and member reads have finite persisted retries across restarts', async t => {
    for (const phase of ['write', 'read']) {
        await t.test(phase, async t => {
            const f = setup(t, 1);
            const job = await queue(f);
            const fail = async id => { if (phase === 'write' || id === ids(1)[0]) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
            if (phase === 'write') f.effects.beforeWrite = fail;
            else f.effects.beforeRead = fail;
            for (let i = 0; i < 6; i++) { await f.service.drain(); f.advance(60000); }
            assert.equal(f.store.get(job.id).status, 'completed');
            assert.equal(f.store.rows(job.id)[0].status, 'failed');
            assert.ok(f.store.rows(job.id)[0].attempts <= 4);
            assert.equal(f.effects.writes.length, 0);
        });
    }
});
test('403 is never retried and stops the remaining members; retry includes only failures', async t => {
    const f = setup(t, 3);
    const job = await queue(f);
    f.effects.beforeWrite = async () => { throw Object.assign(new Error('forbidden'), { status: 403, code: 50013 }); };
    await f.service.drain();
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['failed', 'unexecuted', 'unexecuted']);
    const p = await f.service.retryPreview(job.id, GUILD, ACTOR);
    assert.deepEqual(p.ids, [ids(1)[0]]);
    assert.equal(p.parentId, job.id);
});
test('process restart reconciles an applied but uncommitted request, and never repeats confirmed successes', async t => {
    const f = setup(t, 3);
    const job = await queue(f);
    f.store.claim('dead-worker', 1000000);
    f.store.begin(job.id, ids(1)[0], 'dead-worker', 1000001);
    f.states.get(ids(1)[0]).add(ROLE); // API applied, process dies before commit
    f.store.settle(job.id, ids(1)[0], 'dead-worker', 'success', null, 1000002);
    f.store.begin(job.id, ids(2)[1], 'dead-worker', 1000003);
    f.states.get(ids(2)[1]).add(ROLE); // second request uncertain on restart
    f.advance(130000);
    const restarted = new Service(f.client, { store: f.store, safety: new Safety(f.client, f.safetyOptions), transport: f.transport, now: () => 1130000, wait: async () => {} });
    await restarted.drain();
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['success', 'reconciled', 'success']);
    assert.deepEqual(f.effects.writes.map(r => r.id), [ids(3)[2]]);
});
test('recovery refuses revoked authority and changed automation configs', async t => {
    const f = setup(t);
    const job = await queue(f);
    f.service.safety.compatibility = async () => { throw new Error('跨服同步配置已启用'); };
    await f.service.drain();
    assert.equal(f.store.get(job.id).status, 'stopped');
    assert.equal(f.effects.writes.length, 0);
});
test('cancel during a request keeps its confirmed outcome and leaves the rest unexecuted', async t => {
    const f = setup(t, 3);
    const job = await queue(f);
    f.effects.beforeWrite = async () => f.store.cancel(job.id, GUILD, ACTOR, 1000001);
    await f.service.drain();
    assert.equal(f.store.get(job.id).status, 'cancelled');
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['success', 'unexecuted', 'unexecuted']);
});
test('cancel after an applied request and crash reconciles inflight before marking untouched members unexecuted', async t => {
    const f = setup(t, 2);
    const job = await queue(f);
    f.store.claim('crashed', 1000000);
    f.store.begin(job.id, ids(1)[0], 'crashed', 1000001);
    f.states.get(ids(1)[0]).add(ROLE);
    f.store.cancel(job.id, GUILD, ACTOR, 1000002);
    f.advance(130000);
    await f.service.drain();
    assert.equal(f.store.get(job.id).status, 'cancelled');
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['reconciled', 'unexecuted']);
    assert.equal(f.effects.writes.length, 0);
});
test('real REST rate-limit retry cannot write after authority is revoked during the wait', async t => {
    const f = setup(t, 1);
    const job = await queue(f);
    f.client.token = 'fake-test-token';
    let calls = 0;
    f.service.transport = new Transport(f.client, { makeRequest: async () => {
        calls++;
        f.states.set(ACTOR, new Set());
        return new Response(JSON.stringify({ retry_after: 0.01, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0.01' } });
    } });
    t.after(() => f.service.transport.close());
    await f.service.drain();
    assert.equal(calls, 1);
    assert.equal(f.store.rows(job.id)[0].status, 'inflight');
    f.advance(10000);
    await f.service.drain();
    assert.equal(calls, 1);
    assert.equal(f.store.get(job.id).status, 'stopped');
    assert.equal(f.states.get(ids(1)[0]).has(ROLE), false);
});
test('database write failure prevents further Discord mutations; uncertain result can be safely recovered', async t => {
    const f = setup(t);
    const job = await queue(f);
    f.effects.beforeWrite = async () => f.store.db.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON members WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    await assert.rejects(f.service.drain());
    assert.equal(f.effects.writes.length, 1);
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['inflight', 'pending']);
    f.store.db.exec('DROP TRIGGER fail_result');
    f.effects.beforeWrite = null;
    await f.service.drain();
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['reconciled', 'success']);
    assert.equal(f.effects.writes.length, 2);
});
test('database read/write failures before begin prevent any role write', async t => {
    const f = setup(t);
    const job = await queue(f);
    f.store.db.exec("CREATE TRIGGER fail_begin BEFORE UPDATE ON members WHEN NEW.status='inflight' BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await assert.rejects(f.service.drain());
    assert.equal(f.effects.writes.length, 0);
    assert.equal(f.store.rows(job.id)[0].status, 'pending');
    f.store.close();
    await assert.rejects(f.service.drain());
});
test('SIGKILL leaves a recoverable SQLite checkpoint and restart reconciles the remote state', async t => {
    const directory = temp(t);
    const file = path.join(directory, 'crash.sqlite');
    const marker = path.join(directory, 'remote-state.json');
    const result = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const { Store } = require('./src/modules/bulkRole/store');
        const { fixture, ids, GUILD, ACTOR } = require('./tests/bulkRole/fixture');
        const store = new Store(process.argv[1]);
        const p = store.createPreview(fixture().spec, { ids: ids(2), inputCount: 2 }, {}, 1);
        const job = store.confirm(p.id, GUILD, ACTOR, 2);
        store.claim('killed-worker', 3);
        store.begin(job.id, ids(1)[0], 'killed-worker', 4);
        fs.writeFileSync(process.argv[2], JSON.stringify({ jobId: job.id, applied: ids(1)[0] }));
        process.kill(process.pid, 'SIGKILL');
    `, file, marker], { cwd: path.resolve(__dirname, '../..') });
    assert.equal(result.signal, 'SIGKILL');
    const remote = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const f = fixture(2);
    f.states.get(remote.applied).add(ROLE);
    const store = new Store(file);
    t.after(() => store.close());
    const service = new Service(f.client, { store, safety: new Safety(f.client, f.safetyOptions), transport: f.transport, now: () => 200000, wait: async () => {} });
    await service.drain();
    assert.deepEqual(store.rows(remote.jobId).map(r => r.status), ['reconciled', 'success']);
    assert.deepEqual(f.effects.writes.map(r => r.id), [ids(2)[1]]);
});
test('live target permissions, actor hierarchy and Bot permission changes stop remaining work', async t => {
    for (const change of ['adminRole', 'actorHierarchy', 'botPermission']) {
        await t.test(change, async t => {
            const f = setup(t, 2);
            const job = await queue(f);
            f.effects.beforeWrite = async () => {
                if (change === 'adminRole') f.guild.roles.cache.get(ROLE).permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
                if (change === 'actorHierarchy') f.guild.roles.cache.get('100000000000000010').rawPosition = 1;
                if (change === 'botPermission') f.guild.roles.cache.get('100000000000000011').permissions = new PermissionsBitField(0n);
            };
            await f.service.drain();
            assert.equal(f.effects.writes.length, 1);
            assert.equal(f.store.get(job.id).status, 'stopped');
        });
    }
});
test('lease loss after a dispatched request prevents committing success or starting the next member', async t => {
    const f = setup(t, 2);
    const job = await queue(f);
    f.effects.beforeWrite = async () => {
        f.store.db.prepare('UPDATE worker_lock SET owner=?,until_ms=? WHERE id=1').run('takeover', 9999999);
    };
    await assert.rejects(f.service.drain());
    assert.equal(f.effects.writes.length, 1);
    assert.deepEqual(f.store.rows(job.id).map(r => r.status), ['inflight', 'pending']);
});
test('two independent workers sharing SQLite cannot execute concurrent mutations', async t => {
    const f = fixture(2);
    const filename = path.join(temp(t), 'shared.sqlite');
    const firstStore = new Store(filename);
    const secondStore = new Store(filename);
    t.after(() => { firstStore.close(); secondStore.close(); });
    const options = { safety: new Safety(f.client, f.safetyOptions), transport: f.transport, wait: async () => {} };
    const first = new Service(f.client, { ...options, store: firstStore });
    const second = new Service(f.client, { ...options, store: secondStore });
    const p = await first.preview(f.spec, ids(2).join(','));
    const job = await first.confirm(p.id, GUILD, ACTOR);
    let entered, unblock;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    f.effects.beforeWrite = async () => { entered(); await blocked; };
    const running = first.drain();
    await started;
    await second.drain();
    assert.equal(f.effects.writes.length, 0);
    assert.equal(secondStore.rows(job.id)[0].status, 'inflight');
    unblock();
    await running;
    assert.equal(f.effects.writes.length, 2);
    assert.ok(secondStore.rows(job.id).every(r => r.status === 'success'));
});
