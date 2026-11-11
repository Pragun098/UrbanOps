process.env.AUTH_RATE_LIMIT = '1000';
process.env.REPORT_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { connectTestDb, clearTestDb, dropTestDb } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const Issue = require('../models/Issue');
const { signToken } = require('../services/auth');
const { refreshSeverityScores } = require('../services/issues');
const { issueEvents } = require('../services/events');

before(connectTestDb);
beforeEach(clearTestDb);
after(dropTestDb);

// MG Road, Bengaluru. 0.0001° lat ≈ 11m.
const SPOT = { lat: 12.975, lng: 77.605 };
const metersNorth = (m) => ({ lat: SPOT.lat + m / 111320, lng: SPOT.lng });

let seq = 0;
const makeUser = async (role = 'citizen', region = 'india/karnataka') => {
  seq += 1;
  const scoped = role === 'dispatcher' || role === 'admin';
  const user = await User.create({
    name: `${role}${seq}`, email: `${role}${seq}@t.io`, passwordHash: 'x', role,
    ...(scoped && { region, regionName: region }),
  });
  return { user, auth: { Authorization: `Bearer ${signToken(user)}` } };
};

const report = (auth, body) => request(app).post('/api/v1/issues').set(auth).send(body);
const leak = (location = SPOT) => ({ subcategory: 'Water leak', description: 'Pipe burst', location });

describe('POST /issues — dedup + severity', () => {
  test('first report creates an issue with base severity', async () => {
    const { auth } = await makeUser();
    const res = await report(auth, leak());
    assert.equal(res.status, 201);
    assert.equal(res.body.merged, false);
    assert.equal(res.body.issue.category, 'hazard'); // Water leak → hazard
    assert.equal(res.body.issue.severityScore, 50);
    assert.equal(res.body.issue.reportCount, 1);
    assert.equal(res.body.issue.reportedByMe, true);
    assert.equal(res.body.issue.reporterIds, undefined, 'citizens never see reporter ids');
  });

  test('second reporter within 100m, same category → merged, severity +5', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await report(a.auth, leak());
    const second = await report(b.auth, leak(metersNorth(60)));

    assert.equal(second.status, 200);
    assert.equal(second.body.merged, true);
    assert.equal(second.body.issue._id, first.body.issue._id);
    assert.equal(second.body.issue.severityScore, 55);
    assert.equal(second.body.issue.reportCount, 2);
    assert.equal(await Issue.countDocuments(), 1);

    const stored = await Issue.findById(first.body.issue._id).lean();
    assert.equal(stored.duplicateCount, 1);
    assert.equal(stored.reporterIds.length, 2);
    assert.equal(stored.severityScore, 55);
  });

  test('same citizen reporting twice does not inflate severity', async () => {
    const a = await makeUser();
    await report(a.auth, leak());
    const again = await report(a.auth, leak(metersNorth(10)));
    assert.equal(again.body.merged, true);
    assert.equal(again.body.alreadyReported, true);
    assert.equal(again.body.issue.severityScore, 50);
    assert.equal((await Issue.findOne().lean()).duplicateCount, 0);
  });

  test('different category at the same spot → separate issue', async () => {
    const a = await makeUser();
    await report(a.auth, leak());
    const res = await report(a.auth, { subcategory: 'Pothole', location: SPOT });
    assert.equal(res.status, 201);
    assert.equal(res.body.issue.category, 'infra');
    assert.equal(await Issue.countDocuments(), 2);
  });

  test('same category 150m away → separate issue', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await report(a.auth, leak());
    const res = await report(b.auth, leak(metersNorth(150)));
    assert.equal(res.status, 201);
    assert.equal(await Issue.countDocuments(), 2);
  });

  test('a resolved issue does not absorb a new report (recurring problem)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await report(a.auth, leak());
    await Issue.updateOne({ _id: first.body.issue._id }, { status: 'resolved' });
    const res = await report(b.auth, leak());
    assert.equal(res.status, 201);
    assert.notEqual(res.body.issue._id, first.body.issue._id);
  });

  test('10 simultaneous reports of the same spot produce exactly ONE issue', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const results = await Promise.all(users.map((u, i) => report(u.auth, leak(metersNorth(i * 3)))));

    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(await Issue.countDocuments(), 1, 'race must not create duplicate tickets');
    const issue = await Issue.findOne().lean();
    assert.equal(issue.duplicateCount, 9);
    assert.equal(issue.reporterIds.length, 10);
    assert.equal(issue.severityScore, 50 + 9 * 5);
  });

  test('validates category and coordinates', async () => {
    const { auth } = await makeUser();
    const res = await report(auth, { location: { lat: 200, lng: 'abc' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.length, 3);
  });

  test('unknown subcategory falls back to minor', async () => {
    const { auth } = await makeUser();
    const res = await report(auth, { subcategory: 'Weird smell', location: SPOT });
    assert.equal(res.body.issue.category, 'minor');
    assert.equal(res.body.issue.severityScore, 10);
  });

  test('requires login', async () => {
    const res = await request(app).post('/api/v1/issues').send(leak());
    assert.equal(res.status, 401);
  });

  test('emits issue:created then issue:updated for the event bus', async () => {
    const events = [];
    const onCreate = (i) => events.push(['created', String(i._id)]);
    const onUpdate = (i, meta) => events.push(['updated', String(i._id), meta.reason]);
    issueEvents.on('issue:created', onCreate);
    issueEvents.on('issue:updated', onUpdate);
    try {
      const a = await makeUser();
      const b = await makeUser();
      const first = await report(a.auth, leak());
      await report(b.auth, leak());
      const id = first.body.issue._id;
      assert.deepEqual(events, [['created', id], ['updated', id, 'duplicate']]);
    } finally {
      issueEvents.off('issue:created', onCreate);
      issueEvents.off('issue:updated', onUpdate);
    }
  });
});

describe('severity decay', () => {
  test('stored score decays via the tick; reads show live score; floor holds', async () => {
    const issue = await Issue.create({
      category: 'infra', location: { coordinates: [SPOT.lng, SPOT.lat] }, duplicateCount: 4, region: 'india/karnataka',
    });
    assert.equal(issue.severityScore, 50); // 30 + 4*5

    await Issue.updateOne({ _id: issue._id }, { lastReportedAt: new Date(Date.now() - 10 * 3600 * 1000) });
    await refreshSeverityScores();
    const stored = await Issue.findById(issue._id).lean();
    assert.ok(Math.abs(stored.severityScore - 45) < 0.05, `expected ~45, got ${stored.severityScore}`);

    await Issue.updateOne({ _id: issue._id }, { lastReportedAt: new Date(Date.now() - 1000 * 3600 * 1000) });
    await refreshSeverityScores();
    assert.equal((await Issue.findById(issue._id).lean()).severityScore, 30);

    const { auth } = await makeUser('dispatcher');
    const res = await request(app).get(`/api/v1/issues/${issue._id}`).set(auth);
    assert.equal(res.body.issue.severityScore, 30);
  });
});

describe('GET /issues', () => {
  const seed = async () => {
    const a = await makeUser();
    const b = await makeUser();
    await report(a.auth, leak()); // hazard 50
    await report(b.auth, leak()); // merged → 55
    await report(a.auth, { subcategory: 'Pothole', location: SPOT }); // infra 30
    await report(a.auth, { subcategory: 'Graffiti', location: { lat: 13.05, lng: 77.7 } }); // minor 10, far away
    return a;
  };

  test('staff get full records sorted by severity', async () => {
    await seed();
    const { auth } = await makeUser('dispatcher');
    const res = await request(app).get('/api/v1/issues').set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.deepEqual(res.body.data.map((i) => i.severityScore), [55, 30, 10]);
    assert.equal(res.body.data[0].reporterIds.length, 2);
  });

  test('citizens cannot list all issues (they only see their own via /mine)', async () => {
    const a = await seed();
    const res = await request(app).get('/api/v1/issues').set(a.auth);
    assert.equal(res.status, 403);
  });

  test('staff list omits the (heavy) history; single view includes it', async () => {
    await seed();
    const { auth } = await makeUser('dispatcher');
    const list = await request(app).get('/api/v1/issues').set(auth);
    assert.ok(list.body.data.every((i) => i.history === undefined));
  });

  test('filters by category, status and bbox', async () => {
    await seed();
    const { auth } = await makeUser('dispatcher');
    const byCat = await request(app).get('/api/v1/issues?category=hazard,minor').set(auth);
    assert.equal(byCat.body.total, 2);

    const bbox = await request(app).get('/api/v1/issues?bbox=77.60,12.97,77.61,12.98').set(auth);
    assert.equal(bbox.body.total, 2, 'far-away graffiti excluded');

    const resolved = await request(app).get('/api/v1/issues?status=resolved').set(auth);
    assert.equal(resolved.body.total, 0);

    const severe = await request(app).get('/api/v1/issues?minSeverity=30').set(auth);
    assert.deepEqual(severe.body.data.map((i) => i.severityScore), [55, 30]);
    assert.equal((await request(app).get('/api/v1/issues?minSeverity=-1').set(auth)).status, 400);
    assert.equal((await request(app).get('/api/v1/issues?minSeverity=abc').set(auth)).status, 400);

    assert.equal((await request(app).get('/api/v1/issues?status=closed').set(auth)).status, 400);
    assert.equal((await request(app).get('/api/v1/issues?bbox=1,2,3').set(auth)).status, 400);
  });

  test('/mine lists only the caller’s reports', async () => {
    await seed();
    const c = await makeUser();
    await report(c.auth, { subcategory: 'Street light', location: { lat: 12.9, lng: 77.5 } });
    const res = await request(app).get('/api/v1/issues/mine').set(c.auth);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.data[0].subcategory, 'Street light');
  });

  test('GET /:id — citizens can only see issues they reported (404 otherwise)', async () => {
    const a = await makeUser();
    const outsider = await makeUser();
    const created = await report(a.auth, leak());
    const id = created.body.issue._id;

    assert.equal((await request(app).get(`/api/v1/issues/${id}`).set(a.auth)).status, 200);
    assert.equal((await request(app).get(`/api/v1/issues/${id}`).set(outsider.auth)).status, 404);
    assert.equal((await request(app).get('/api/v1/issues/not-an-id').set(a.auth)).status, 400);
  });
});

describe('PATCH /issues/:id — Kanban workflow', () => {
  const setup = async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const created = await report(citizen.auth, leak());
    return { citizen, dispatcher, id: created.body.issue._id };
  };
  const patch = (auth, id, body) => request(app).patch(`/api/v1/issues/${id}`).set(auth).send(body);

  test('citizens cannot change issues', async () => {
    const { citizen, id } = await setup();
    assert.equal((await patch(citizen.auth, id, { status: 'dispatched' })).status, 403);
  });

  test('dispatcher: open → dispatched (with assignee) → resolved sets resolvedAt; admin reopen clears it', async () => {
    const { dispatcher, id } = await setup();
    const admin = await makeUser('admin');

    const d = await patch(dispatcher.auth, id, { status: 'dispatched', assignedTo: String(dispatcher.user._id) });
    assert.equal(d.status, 200);
    assert.equal(d.body.issue.status, 'dispatched');
    assert.equal(d.body.issue.assignedTo.email, dispatcher.user.email);

    const r = await patch(dispatcher.auth, id, { status: 'resolved' });
    assert.equal(r.body.issue.status, 'resolved');
    assert.ok(r.body.issue.resolvedAt);

    const o = await patch(admin.auth, id, { status: 'open' });
    assert.equal(o.body.issue.status, 'open');
    assert.equal(o.body.issue.resolvedAt, null);
  });

  test('rejects invalid transitions and statuses', async () => {
    const { dispatcher, id } = await setup();
    const admin = await makeUser('admin');
    await patch(admin.auth, id, { status: 'resolved' });
    const bad = await patch(admin.auth, id, { status: 'dispatched' });
    assert.equal(bad.status, 400, 'resolved → dispatched is never allowed');
    assert.deepEqual(bad.body.details.allowed, ['open']);
    assert.equal((await patch(dispatcher.auth, id, { status: 'closed' })).status, 400);
    assert.equal((await patch(dispatcher.auth, id, {})).status, 400);
  });

  test('can only assign to staff; unassign with null', async () => {
    const { citizen, dispatcher, id } = await setup();
    assert.equal((await patch(dispatcher.auth, id, { assignedTo: String(citizen.user._id) })).status, 400);
    assert.equal((await patch(dispatcher.auth, id, { assignedTo: 'nope' })).status, 400);
    await patch(dispatcher.auth, id, { assignedTo: String(dispatcher.user._id) });
    const un = await patch(dispatcher.auth, id, { assignedTo: null });
    assert.equal(un.body.issue.assignedTo, null);
  });

  test('404 for unknown issue', async () => {
    const { dispatcher } = await setup();
    assert.equal((await patch(dispatcher.auth, '507f1f77bcf86cd799439011', { status: 'dispatched' })).status, 404);
  });
});

describe('role hierarchy (citizen < dispatcher < admin)', () => {
  const patch = (auth, id, body) => request(app).patch(`/api/v1/issues/${id}`).set(auth).send(body);
  const freshIssue = async () => {
    const c = await makeUser();
    return (await report(c.auth, leak())).body.issue._id;
  };

  test('dispatcher cannot close an open issue without dispatching it (403); admin can', async () => {
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');
    const id = await freshIssue();

    const denied = await patch(dispatcher.auth, id, { status: 'resolved' });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body.details.allowed, ['dispatched'], 'tells the dispatcher what they can do');

    const ok = await patch(admin.auth, id, { status: 'resolved' });
    assert.equal(ok.status, 200);
  });

  test('dispatcher cannot reopen a resolved issue (403); admin can', async () => {
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');
    const id = await freshIssue();
    await patch(dispatcher.auth, id, { status: 'dispatched' });
    await patch(dispatcher.auth, id, { status: 'resolved' });

    assert.equal((await patch(dispatcher.auth, id, { status: 'open' })).status, 403);
    assert.equal((await patch(admin.auth, id, { status: 'open' })).status, 200);
  });

  test('dispatcher can undo a dispatch (dispatched → open)', async () => {
    const dispatcher = await makeUser('dispatcher');
    const id = await freshIssue();
    await patch(dispatcher.auth, id, { status: 'dispatched' });
    const undo = await patch(dispatcher.auth, id, { status: 'open' });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.issue.status, 'open');
  });

  test('every staff action is recorded in the issue history (who, what, when)', async () => {
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');
    const id = await freshIssue();

    await patch(dispatcher.auth, id, { status: 'dispatched', assignedTo: String(dispatcher.user._id) });
    await patch(dispatcher.auth, id, { status: 'resolved' });
    await patch(admin.auth, id, { status: 'open' });

    const res = await request(app).get(`/api/v1/issues/${id}`).set(admin.auth);
    const h = res.body.issue.history.map((e) => `${e.action}:${e.from}->${e.to}:${e.byRole}`);
    assert.deepEqual(h, [
      'status:open->dispatched:dispatcher',
      `assignment:null->${dispatcher.user._id}:dispatcher`,
      'status:dispatched->resolved:dispatcher',
      'status:resolved->open:admin',
    ]);
    assert.equal(res.body.issue.history[1].toName, dispatcher.user.name);
    assert.ok(res.body.issue.history.every((e) => e.byName && e.at));
  });

  test('citizens never see the staff history of their own report', async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const id = (await report(citizen.auth, leak())).body.issue._id;
    await patch(dispatcher.auth, id, { status: 'dispatched' });

    const own = await request(app).get(`/api/v1/issues/${id}`).set(citizen.auth);
    assert.equal(own.status, 200);
    assert.equal(own.body.issue.history, undefined);
    assert.equal(own.body.issue.assignedTo, undefined);
  });

  test('login and /me tell the UI what each role may do', async () => {
    const { auth } = await makeUser('dispatcher');
    const me = await request(app).get('/api/v1/auth/me').set(auth);
    assert.deepEqual(me.body.permissions.transitions, { open: ['dispatched'], dispatched: ['resolved', 'open'] });
    assert.equal(me.body.permissions.canViewAllIssues, true);
    assert.equal(me.body.permissions.canManageStaff, false);
    assert.equal(me.body.permissions.canInviteAdmins, false);
    assert.equal(me.body.user.region, 'india/karnataka');

    const citizen = await makeUser();
    const cme = await request(app).get('/api/v1/auth/me').set(citizen.auth);
    assert.deepEqual(cme.body.permissions.transitions, {});
    assert.equal(cme.body.permissions.canViewAllIssues, false);
  });
});

describe('GET /issues/stats', () => {
  test('staff-only dashboard numbers', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { auth, user } = await makeUser('dispatcher');

    const leakIssue = await report(a.auth, leak());
    await report(b.auth, leak()); // merged
    const pothole = await report(a.auth, { subcategory: 'Pothole', location: SPOT });
    await report(a.auth, { subcategory: 'Graffiti', location: { lat: 13.0, lng: 77.7 } });

    await request(app).patch(`/api/v1/issues/${leakIssue.body.issue._id}`).set(auth)
      .send({ status: 'dispatched', assignedTo: String(user._id) });
    // Closing an open issue directly is an admin action.
    const admin = await makeUser('admin');
    await request(app).patch(`/api/v1/issues/${pothole.body.issue._id}`).set(admin.auth).send({ status: 'resolved' });

    assert.equal((await request(app).get('/api/v1/issues/stats').set(a.auth)).status, 403);

    const res = await request(app).get('/api/v1/issues/stats').set(auth);
    assert.equal(res.status, 200);
    const s = res.body.data;
    assert.equal(s.active, 2);
    assert.deepEqual(s.byStatus, { open: 1, dispatched: 1, resolved: 1 });
    assert.equal(s.openByCategory.hazard.count, 1);
    assert.equal(s.openByCategory.infra.count, 0);
    assert.equal(s.highPriority, 1);
    assert.equal(s.assignedStaff, 1);
    assert.equal(s.resolvedToday, 1);
    assert.equal(s.duplicatesMerged, 1);
    assert.equal(typeof s.avgResolutionHours, 'number');
  });
});

describe('jurisdiction: staff only see and act on their own state', () => {
  const MUMBAI = { lat: 19.07, lng: 72.88 };
  const patch = (auth, id, body) => request(app).patch(`/api/v1/issues/${id}`).set(auth).send(body);

  const seedTwoStates = async () => {
    const citizen = await makeUser();
    const blr = (await report(citizen.auth, leak())).body.issue;
    const bom = (await report(citizen.auth, leak(MUMBAI))).body.issue;
    return { blr, bom };
  };

  test('each report is filed under the state its location is in', async () => {
    const { blr, bom } = await seedTwoStates();
    const a = await Issue.findById(blr._id).lean();
    const b = await Issue.findById(bom._id).lean();
    assert.equal(a.region, 'india/karnataka');
    assert.equal(a.regionName, 'Karnataka, India');
    assert.equal(b.region, 'india/maharashtra');
  });

  test('list, single view and stats are limited to the dispatcher state', async () => {
    const { blr, bom } = await seedTwoStates();
    const ka = await makeUser('dispatcher', 'india/karnataka');

    const list = await request(app).get('/api/v1/issues').set(ka.auth);
    assert.deepEqual(list.body.data.map((i) => i._id), [blr._id]);
    assert.equal((await request(app).get(`/api/v1/issues/${bom._id}`).set(ka.auth)).status, 404, 'other state looks like it does not exist');

    const stats = await request(app).get('/api/v1/issues/stats').set(ka.auth);
    assert.equal(stats.body.data.active, 1);
  });

  test('staff cannot change another state issue or assign another state staff', async () => {
    const { blr, bom } = await seedTwoStates();
    const kaAdmin = await makeUser('admin', 'india/karnataka');
    const mhDisp = await makeUser('dispatcher', 'india/maharashtra');

    assert.equal((await patch(kaAdmin.auth, bom._id, { status: 'dispatched' })).status, 404);
    const crossAssign = await patch(kaAdmin.auth, blr._id, { assignedTo: String(mhDisp.user._id) });
    assert.equal(crossAssign.status, 400);
    assert.match(crossAssign.body.error, /this state/);
  });

  test('superadmin sees every state and can filter by one', async () => {
    const { bom } = await seedTwoStates();
    const sa = await makeUser('superadmin');
    const all = await request(app).get('/api/v1/issues').set(sa.auth);
    assert.equal(all.body.total, 2);
    const mh = await request(app).get('/api/v1/issues?region=india/maharashtra').set(sa.auth);
    assert.deepEqual(mh.body.data.map((i) => i._id), [bom._id]);
    assert.equal((await patch(sa.auth, bom._id, { status: 'resolved' })).status, 200, 'superadmin can act anywhere');
  });

  test('a dispatcher with no state assigned is refused, never shown everything', async () => {
    await seedTwoStates();
    const orphan = await User.create({ name: 'Orphan', email: 'orphan@t.io', passwordHash: 'x', role: 'dispatcher' });
    const auth = { Authorization: `Bearer ${signToken(orphan)}` };
    const res = await request(app).get('/api/v1/issues').set(auth);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /no state assigned/);
  });

  test('if the state lookup fails the report is still accepted, filed as unassigned', async () => {
    const citizen = await makeUser();
    const res = await report(citizen.auth, leak({ lat: 51.5, lng: -0.12 })); // stub resolver: unknown area
    assert.equal(res.status, 201);
    assert.equal((await Issue.findById(res.body.issue._id).lean()).region, 'unassigned');
    const sa = await makeUser('superadmin');
    const list = await request(app).get('/api/v1/issues?region=unassigned').set(sa.auth);
    assert.equal(list.body.total, 1, 'superadmin can find and handle unassigned reports');
  });
});
