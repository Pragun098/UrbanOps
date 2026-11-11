process.env.AUTH_RATE_LIMIT = '1000';
process.env.REPORT_RATE_LIMIT = '1000';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');

const { connectTestDb, clearTestDb, dropTestDb } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const { signToken } = require('../services/auth');
const { attachRealtime, roomsForBbox } = require('../realtime/socket');

let server;
let io;
let url;
const sockets = [];

before(async () => {
  await connectTestDb();
  server = http.createServer(app);
  io = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

after(async () => {
  io.close();
  await new Promise((resolve) => server.close(resolve));
  await dropTestDb();
});

beforeEach(clearTestDb);
afterEach(() => {
  while (sockets.length) sockets.pop().disconnect();
});

let seq = 0;
const makeUser = async (role = 'citizen', region = 'india/karnataka') => {
  seq += 1;
  const scoped = role === 'dispatcher' || role === 'admin';
  const user = await User.create({
    name: `${role}${seq}`, email: `rt-${role}${seq}@t.io`, passwordHash: 'x', role,
    ...(scoped && { region, regionName: region }),
  });
  const token = signToken(user);
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = ioClient(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => reject(err));
  });

const subscribe = (socket, bbox) => new Promise((resolve) => socket.emit('subscribe', { bbox }, resolve));

/** Resolves with the next event payload, or null if none arrives within ms. */
const nextEvent = (socket, event, ms = 700) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    function handler(payload) { clearTimeout(timer); resolve(payload); }
    socket.once(event, handler);
  });

// Central Bengaluru vs. a box far away (Mumbai).
const BLR_BBOX = [77.55, 12.93, 77.65, 13.01];
const MUMBAI_BBOX = [72.8, 18.9, 72.9, 19.0];
const SPOT = { lat: 12.975, lng: 77.605 };
const report = (auth, body) => request(app).post('/api/v1/issues').set(auth).send(body);

describe('handshake auth', () => {
  test('rejects connections without a token', async () => {
    await assert.rejects(connect(null), /Authentication required/);
  });

  test('rejects a forged token', async () => {
    await assert.rejects(connect('not.a.jwt'), /Invalid token/);
  });

  test('accepts a valid token', async () => {
    const { token } = await makeUser('dispatcher');
    const s = await connect(token);
    assert.ok(s.connected);
  });
});

describe('geohash rooms', () => {
  test('roomsForBbox covers the box with precision-5 cells and validates input', () => {
    const { rooms } = roomsForBbox(BLR_BBOX);
    assert.ok(rooms.length > 0 && rooms.every((r) => /^gh:[0-9a-z]{5}$/.test(r)));
    assert.match(roomsForBbox([1, 2, 3]).error, /bbox/);
    assert.match(roomsForBbox([10, 10, 5, 5]).error, /out of range/);
    const started = Date.now();
    assert.match(roomsForBbox([-180, -90, 180, 90]).error, /too large/);
    assert.ok(Date.now() - started < 50, 'oversized areas are rejected without enumerating cells');
  });

  test('cell estimate never under-counts real coverage (cap is safe)', () => {
    for (const bbox of [BLR_BBOX, [77.45, 12.85, 77.8, 13.1], [72.8, 18.9, 72.9, 19.0], [0, 0, 0.01, 0.01]]) {
      const { rooms } = roomsForBbox(bbox);
      assert.ok(rooms.length > 0 && rooms.length <= 400);
    }
  });

  test('citizens cannot subscribe to areas', async () => {
    const { token } = await makeUser('citizen');
    const s = await connect(token);
    const ack = await subscribe(s, BLR_BBOX);
    assert.equal(ack.ok, false);
  });

  test('new issue reaches that state staff (map area or whole state) and the superadmin, nobody else', async () => {
    const near = await connect((await makeUser('dispatcher')).token); // Karnataka, watching Bengaluru
    const wholeState = await connect((await makeUser('admin')).token); // Karnataka, no map area: state channel
    const otherState = await connect((await makeUser('dispatcher', 'india/maharashtra')).token);
    const superadmin = await connect((await makeUser('superadmin')).token);
    assert.equal((await subscribe(near, BLR_BBOX)).ok, true);

    const citizen = await makeUser();
    const gotNear = nextEvent(near, 'issue:created');
    const gotState = nextEvent(wholeState, 'issue:created');
    const gotOther = nextEvent(otherState, 'issue:created');
    const gotSuper = nextEvent(superadmin, 'issue:created');

    const res = await report(citizen.auth, { subcategory: 'Water leak', location: SPOT });
    assert.equal(res.status, 201);

    const payload = await gotNear;
    assert.ok(payload, 'dispatcher watching the area receives it');
    assert.equal(payload._id, res.body.issue._id);
    assert.equal(payload.severityScore, 50);
    assert.ok(await gotState, 'same-state admin receives it on the state channel');
    assert.ok(await gotSuper, 'superadmin receives every state');
    assert.equal(await gotOther, null, 'another state hears nothing: no global broadcast');
  });

  test('a map area never leaks events from a neighbouring state', async () => {
    // A Maharashtra dispatcher looking at a map area INSIDE Karnataka still gets nothing from it.
    const mh = await connect((await makeUser('dispatcher', 'india/maharashtra')).token);
    assert.equal((await subscribe(mh, BLR_BBOX)).ok, true);
    const got = nextEvent(mh, 'issue:created');
    const citizen = await makeUser();
    await report(citizen.auth, { subcategory: 'Pothole', location: SPOT });
    assert.equal(await got, null);
  });

  test('duplicate merge pushes the new severity to the area', async () => {
    const d = await connect((await makeUser('dispatcher')).token);
    await subscribe(d, BLR_BBOX);
    const a = await makeUser();
    const b = await makeUser();
    await report(a.auth, { subcategory: 'Water leak', location: SPOT });

    const update = nextEvent(d, 'issue:updated');
    await report(b.auth, { subcategory: 'Water leak', location: SPOT });
    const payload = await update;
    assert.equal(payload.reason, 'duplicate');
    assert.equal(payload.issue.severityScore, 55);
    assert.equal(payload.issue.reportCount, 2);
  });

  test('re-subscribing replaces the old area', async () => {
    const d = await connect((await makeUser('dispatcher')).token);
    await subscribe(d, BLR_BBOX);
    await subscribe(d, MUMBAI_BBOX);
    const citizen = await makeUser();
    const got = nextEvent(d, 'issue:created');
    await report(citizen.auth, { subcategory: 'Pothole', location: SPOT });
    assert.equal(await got, null);
  });
});

describe('Kanban sync + citizen notifications', () => {
  test('a status change reaches other dispatcher sessions and the reporting citizen', async () => {
    const actor = await makeUser('dispatcher');
    const watcher = await connect((await makeUser('dispatcher')).token);
    await subscribe(watcher, BLR_BBOX);

    const citizen = await makeUser();
    const citizenSocket = await connect(citizen.token);
    const outsider = await connect((await makeUser()).token);

    const created = await report(citizen.auth, { subcategory: 'Pothole', location: SPOT });
    const id = created.body.issue._id;

    const toWatcher = nextEvent(watcher, 'issue:updated');
    const toCitizen = nextEvent(citizenSocket, 'issue:updated');
    const toOutsider = nextEvent(outsider, 'issue:updated');

    await request(app).patch(`/api/v1/issues/${id}`).set(actor.auth).send({ status: 'dispatched' });

    const w = await toWatcher;
    assert.equal(w.issue.status, 'dispatched');
    assert.equal(w.reason, 'status');

    const c = await toCitizen;
    assert.equal(c.issue.status, 'dispatched');
    assert.equal(c.issue.reporterIds, undefined, 'citizen gets the public view');
    assert.equal(c.issue.assignedTo, undefined);

    assert.equal(await toOutsider, null, 'other citizens hear nothing');
  });
});
