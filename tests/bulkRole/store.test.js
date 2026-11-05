const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../../src/modules/bulkRole/store');
const { temp, fixture, ids, GUILD, ACTOR } = require('./fixture');

function setup(t) {
    const file = path.join(temp(t), 'jobs.sqlite');
    const store = new Store(file);
    t.after(() => store.close());
    const preview = store.createPreview(fixture().spec, { ids: ids(2), inputCount: 2 }, { change: 2, already: 0, absent: 0, other: 0 }, 1000);
    return { file, store, preview };
}
test('confirmation is atomic, single-use, owner-bound and expires at five minutes', t => {
    const { store, preview } = setup(t);
    assert.throws(() => store.confirm(preview.id, GUILD, 'other', 1001));
    assert.throws(() => store.confirm(preview.id, 'other', ACTOR, 1001));
    const job = store.confirm(preview.id, GUILD, ACTOR, 1001);
    assert.notEqual(job.id, preview.id);
    assert.equal(store.rows(job.id).length, 2);
    assert.throws(() => store.confirm(preview.id, GUILD, ACTOR, 1002));
    const expired = store.createPreview(fixture().spec, { ids: ids(1), inputCount: 1 }, {}, 1000);
    assert.throws(() => store.confirm(expired.id, GUILD, ACTOR, 301000), /过期/);
});
test('two connections cannot confirm conflicting tasks; failed confirmation leaves token usable', t => {
    const { file, store, preview } = setup(t);
    const second = new Store(file);
    t.after(() => second.close());
    const p2 = second.createPreview(fixture().spec, { ids: ids(1), inputCount: 1 }, {}, 1000);
    const j1 = store.confirm(preview.id, GUILD, ACTOR, 1001);
    assert.throws(() => second.confirm(p2.id, GUILD, ACTOR, 1002), /活动任务/);
    assert.equal(second.preview(p2.id).status, 'ready');
    store.claim('worker', 1003);
    store.finish(j1.id, 'worker', 'stopped', 'test', 1004);
    assert.ok(second.confirm(p2.id, GUILD, ACTOR, 1005).id);
});
test('worker lease excludes concurrent execution and old owners cannot settle after takeover', t => {
    const { file, store, preview } = setup(t);
    const job = store.confirm(preview.id, GUILD, ACTOR, 1001);
    const second = new Store(file);
    t.after(() => second.close());
    assert.equal(store.claim('first', 1002).id, job.id);
    assert.equal(second.claim('second', 1003), null);
    store.begin(job.id, ids(1)[0], 'first', 1004);
    assert.equal(second.claim('second', 200000).id, job.id);
    assert.throws(() => store.settle(job.id, ids(1)[0], 'first', 'success', null, 200001));
    assert.equal(store.rows(job.id)[0].status, 'inflight');
    second.settle(job.id, ids(1)[0], 'second', 'reconciled', null, 200002);
    assert.equal(store.rows(job.id)[0].status, 'reconciled');
});
test('cancel preserves successes, records unexecuted members and retains independent audit', t => {
    const { store, preview } = setup(t);
    const job = store.confirm(preview.id, GUILD, ACTOR, 1001);
    store.claim('worker', 1002);
    store.begin(job.id, ids(1)[0], 'worker', 1003);
    store.settle(job.id, ids(1)[0], 'worker', 'success', null, 1004);
    store.cancel(job.id, GUILD, ACTOR, 1005);
    store.finish(job.id, 'worker', 'cancelled', 'cancelled', 1006);
    assert.deepEqual(store.rows(job.id).map(r => r.status), ['success', 'unexecuted']);
    assert.equal(store.get(job.id).status, 'cancelled');
    assert.ok(store.db.prepare('SELECT COUNT(*) n FROM audit WHERE job_id=?').get(job.id).n >= 5);
    assert.equal(store.get(job.id).createdAt, 1001);
    // There is deliberately no automatic result deletion, including after 24h.
    assert.equal(store.claim('later', 999999999), null);
    assert.equal(store.rows(job.id).length, 2);
});
test('durable inflight state survives connection restart; writes fail atomically', t => {
    const { file, store, preview } = setup(t);
    const job = store.confirm(preview.id, GUILD, ACTOR, 1001);
    store.claim('first', 1002);
    store.begin(job.id, ids(1)[0], 'first', 1003);
    store.close();
    const recovered = new Store(file);
    t.after(() => recovered.close());
    assert.equal(recovered.rows(job.id)[0].status, 'inflight');
    recovered.db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    assert.throws(() => recovered.cancel(job.id, GUILD, ACTOR, 1004));
    assert.equal(recovered.get(job.id).cancelRequested, false);
    recovered.close();
    assert.throws(() => recovered.get(job.id));
});
