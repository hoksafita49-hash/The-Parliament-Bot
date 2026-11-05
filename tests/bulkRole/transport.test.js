const test = require('node:test');
const assert = require('node:assert/strict');
const { Transport } = require('../../src/modules/bulkRole/transport');
const { classify } = require('../../src/modules/bulkRole/service');
const { GUILD, ACTOR, ROLE, ids } = require('./fixture');

const job = { id: 'test-task', guildId: GUILD, actorId: ACTOR, roleId: ROLE, action: 'add' };
test('real SDK REST uses only single-role PUT/DELETE, with bounded network/server attempts', async t => {
    const calls = [];
    const transport = new Transport({ token: 'fake-test-token' }, { makeRequest: async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 204 });
    } });
    t.after(() => transport.close());
    await transport.change(job, ids(1)[0]);
    await transport.change({ ...job, action: 'remove' }, ids(1)[0]);
    assert.deepEqual(calls.map(c => c.options.method), ['PUT', 'DELETE']);
    assert.ok(calls.every(c => c.url.endsWith(`/guilds/${GUILD}/members/${ids(1)[0]}/roles/${ROLE}`)));
    assert.ok(calls.every(c => !c.options.body));
    const reason = decodeURIComponent(new Headers(calls[0].options.headers).get('X-Audit-Log-Reason'));
    assert.ok(reason.includes('test-task') && reason.includes(ACTOR));
});
test('actual SDK 429 rejects to durable worker instead of silently sleeping and resending', async t => {
    let calls = 0;
    const transport = new Transport({ token: 'fake-test-token' }, { makeRequest: async () => {
        calls++;
        return new Response(JSON.stringify({ retry_after: 10, global: true }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '10', 'x-ratelimit-global': 'true' } });
    } });
    t.after(() => transport.close());
    await assert.rejects(transport.change(job, ids(1)[0]), error => classify(error) === 'rate_limit');
    assert.equal(calls, 1);
    // A known global bucket also rejects before sending another HTTP request.
    await assert.rejects(transport.change(job, ids(1)[0]));
    assert.equal(calls, 1);
});
test('real SDK server and network errors do not retry outside the worker state machine', async t => {
    for (const kind of ['server', 'network']) {
        await t.test(kind, async t => {
            let calls = 0;
            const transport = new Transport({ token: 'fake-test-token' }, { makeRequest: async () => {
                calls++;
                if (kind === 'network') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
                return new Response('temporary', { status: 503 });
            } });
            t.after(() => transport.close());
            await assert.rejects(transport.change(job, ids(1)[0]));
            assert.equal(calls, 1);
        });
    }
});
