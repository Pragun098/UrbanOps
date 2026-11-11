process.env.AUTH_RATE_LIMIT = '1000'; // keep the brute-force limiter out of functional tests
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { connectTestDb, clearTestDb, dropTestDb, sentMails, failMail } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const Invite = require('../models/Invite');
const { inviteEmail } = require('../services/mailer');
const { hashPassword, signToken, getJwtSecret } = require('../services/auth');

before(connectTestDb);
beforeEach(clearTestDb);
after(dropTestDb);

const register = (body) => request(app).post('/api/v1/auth/register').send(body);
const login = (body) => request(app).post('/api/v1/auth/login').send(body);

const scoped = (role) => role === 'dispatcher' || role === 'admin';
const makeUser = async (role, email = `${role}@city.gov`, region = 'india/karnataka') => {
  const user = await User.create({
    name: role, email, passwordHash: await hashPassword('password123'), role,
    ...(scoped(role) && { region, regionName: region === 'india/karnataka' ? 'Karnataka, India' : region }),
  });
  return { user, token: signToken(user) };
};

describe('register', () => {
  test('creates a citizen and returns a token, never the hash', async () => {
    const res = await register({ name: 'Asha', email: 'Asha@Mail.com', password: 'password123' });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, 'asha@mail.com');
    assert.equal(res.body.user.role, 'citizen');
    assert.equal(res.body.user.passwordHash, undefined);

    const stored = await User.findOne({ email: 'asha@mail.com' }).select('+passwordHash');
    assert.notEqual(stored.passwordHash, 'password123');
    assert.match(stored.passwordHash, /^\$2[aby]\$/);
  });

  test('ignores a client-supplied role (no self-promotion)', async () => {
    const res = await register({ name: 'X', email: 'x@mail.com', password: 'password123', role: 'admin' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'citizen');
  });

  test('validates input', async () => {
    const res = await register({ name: '', email: 'not-an-email', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.length, 3);
  });

  test('rejects duplicate email with 409 (case-insensitive)', async () => {
    await register({ name: 'A', email: 'dup@mail.com', password: 'password123' });
    const res = await register({ name: 'B', email: 'DUP@mail.com', password: 'password123' });
    assert.equal(res.status, 409);
  });

  test('rejects a non-string email without crashing', async () => {
    const res = await register({ name: 'A', email: { $gt: '' }, password: 'password123' });
    assert.equal(res.status, 400);
  });
});

describe('login', () => {
  beforeEach(() => register({ name: 'Asha', email: 'asha@mail.com', password: 'password123' }));

  test('succeeds with correct credentials', async () => {
    const res = await login({ email: 'ASHA@mail.com', password: 'password123' });
    assert.equal(res.status, 200);
    const claims = jwt.verify(res.body.token, getJwtSecret());
    assert.equal(claims.role, 'citizen');
    assert.equal(claims.sub, res.body.user._id);
  });

  test('same 401 message for wrong password and unknown email', async () => {
    const wrong = await login({ email: 'asha@mail.com', password: 'nope-nope' });
    const unknown = await login({ email: 'ghost@mail.com', password: 'password123' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error);
  });

  test('NoSQL-injection style payload is rejected', async () => {
    const res = await login({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 400);
  });
});

describe('requireAuth via /me', () => {
  test('401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    assert.equal(res.status, 401);
  });

  test('401 with a garbage or forged token', async () => {
    const garbage = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer abc.def.ghi');
    assert.equal(garbage.status, 401);

    const forged = jwt.sign({ role: 'admin' }, 'wrong-secret', { subject: '507f1f77bcf86cd799439011', issuer: 'urbanops-api' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    assert.equal(res.status, 401);
  });

  test('401 with an expired token', async () => {
    const { user } = await makeUser('citizen');
    const expired = jwt.sign({ role: 'citizen' }, getJwtSecret(), {
      subject: String(user._id), issuer: 'urbanops-api', expiresIn: -10,
    });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Token expired');
  });

  test('returns the current user without the hash', async () => {
    const { token } = await makeUser('dispatcher');
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'dispatcher');
    assert.equal(res.body.user.passwordHash, undefined);
  });

  test('a deleted account is rejected even with a valid token', async () => {
    const { user, token } = await makeUser('citizen');
    await User.deleteOne({ _id: user._id });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });
});

describe('staff management by state', () => {
  const as = (token) => ({ Authorization: `Bearer ${token}` });

  test('citizens and dispatchers cannot list users; a state admin sees only their own state staff', async () => {
    const { token: citizen } = await makeUser('citizen');
    const { token: dispatcher } = await makeUser('dispatcher');
    const { token: admin } = await makeUser('admin');
    await makeUser('dispatcher', 'mh-disp@city.gov', 'india/maharashtra');

    assert.equal((await request(app).get('/api/v1/users').set(as(citizen))).status, 403);
    assert.equal((await request(app).get('/api/v1/users').set(as(dispatcher))).status, 403);

    const res = await request(app).get('/api/v1/users').set(as(admin));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((u) => u.role).sort(), ['admin', 'dispatcher'], 'own state only, no citizens');
    assert.ok(res.body.data.every((u) => u.region === 'india/karnataka' && u.passwordHash === undefined));
    assert.equal((await request(app).get('/api/v1/users?role=citizen').set(as(admin))).status, 403);
  });

  test('superadmin sees everyone and can search; regex characters are treated literally', async () => {
    const { token: sa } = await makeUser('superadmin');
    await User.create({ name: 'Asha Rao', email: 'asha@mail.com', passwordHash: 'x' });
    await User.create({ name: 'Ravi', email: 'ravi@corp.io', passwordHash: 'x' });

    const byName = await request(app).get('/api/v1/users?q=asha').set(as(sa));
    assert.deepEqual(byName.body.data.map((u) => u.email), ['asha@mail.com']);
    const byEmail = await request(app).get('/api/v1/users?q=CORP.IO').set(as(sa));
    assert.deepEqual(byEmail.body.data.map((u) => u.name), ['Ravi']);
    const regexy = await request(app).get('/api/v1/users?q=.*').set(as(sa));
    assert.equal(regexy.status, 200);
    assert.equal(regexy.body.total, 0, '".*" is matched literally, not as a wildcard');
  });

  test('assignable staff list is limited to the same state', async () => {
    const { token: citizen } = await makeUser('citizen');
    const { token: dispatcher } = await makeUser('dispatcher');
    await makeUser('admin');
    await makeUser('dispatcher', 'mh@city.gov', 'india/maharashtra');

    assert.equal((await request(app).get('/api/v1/users/dispatchers').set(as(citizen))).status, 403);
    const res = await request(app).get('/api/v1/users/dispatchers').set(as(dispatcher));
    assert.deepEqual(res.body.data.map((u) => u.role).sort(), ['admin', 'dispatcher']);
    assert.ok(res.body.data.every((u) => u.region === 'india/karnataka'));
  });

  test('state admin creates a dispatcher for THEIR state with a one-time temporary password', async () => {
    const { token: admin } = await makeUser('admin');
    const res = await request(app)
      .post('/api/v1/users/staff')
      .set(as(admin))
      .send({ name: 'New Disp', email: 'new@city.gov', state: 'Maharashtra' }); // state is ignored for admins
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'dispatcher');
    assert.equal(res.body.user.region, 'india/karnataka', 'admins can only staff their own state');
    assert.match(res.body.temporaryPassword, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.equal(res.body.emailed, true, 'temporary password is emailed to the dispatcher');
    const mail = sentMails[sentMails.length - 1];
    assert.equal(mail.to, 'new@city.gov');
    assert.ok(mail.text.includes(res.body.temporaryPassword));
    assert.ok(mail.text.includes('Karnataka, India'));

    const stored = await User.findOne({ email: 'new@city.gov' }).select('+passwordHash');
    assert.equal(stored.mustChangePassword, true);
    assert.notEqual(stored.passwordHash, res.body.temporaryPassword);
  });

  test('new dispatcher must change the temporary password before using the app', async () => {
    const { token: admin } = await makeUser('admin');
    const created = await request(app).post('/api/v1/users/staff').set(as(admin)).send({ name: 'D', email: 'd@city.gov' });
    const temp = created.body.temporaryPassword;

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'd@city.gov', password: temp });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePassword, true);
    const t = login.body.token;

    const blocked = await request(app).get('/api/v1/issues').set(as(t));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await request(app).get('/api/v1/auth/me').set(as(t))).status, 200, '/me still works');

    const wrong = await request(app).post('/api/v1/auth/change-password').set(as(t)).send({ currentPassword: 'nope-nope', newPassword: 'brand-new-pass' });
    assert.equal(wrong.status, 401);
    const same = await request(app).post('/api/v1/auth/change-password').set(as(t)).send({ currentPassword: temp, newPassword: temp });
    assert.equal(same.status, 400);

    const changed = await request(app).post('/api/v1/auth/change-password').set(as(t)).send({ currentPassword: temp, newPassword: 'brand-new-pass' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);
    assert.equal((await request(app).get('/api/v1/issues').set(as(t))).status, 200, 'unlocked');
    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email: 'd@city.gov', password: temp });
    assert.equal(oldLogin.status, 401, 'temp password no longer works');
  });

  test('state admin can reset or revoke only their own dispatchers', async () => {
    const { token: admin } = await makeUser('admin');
    const { user: mine } = await makeUser('dispatcher', 'mine@city.gov');
    const { user: other } = await makeUser('dispatcher', 'other@city.gov', 'india/maharashtra');
    const { user: peer } = await makeUser('admin', 'peer@city.gov');

    const reset = await request(app).post(`/api/v1/users/${mine._id}/reset-password`).set(as(admin));
    assert.equal(reset.status, 200);
    assert.ok(reset.body.temporaryPassword);

    assert.equal((await request(app).post(`/api/v1/users/${other._id}/reset-password`).set(as(admin))).status, 404, 'other state is invisible');
    assert.equal((await request(app).patch(`/api/v1/users/${peer._id}/role`).set(as(admin)).send({ role: 'citizen' })).status, 404, 'cannot touch other admins');
    assert.equal((await request(app).patch(`/api/v1/users/${mine._id}/role`).set(as(admin)).send({ role: 'admin' })).status, 403, 'cannot promote');

    const revoke = await request(app).patch(`/api/v1/users/${mine._id}/role`).set(as(admin)).send({ role: 'citizen' });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.user.role, 'citizen');
    assert.equal(revoke.body.user.region, null);
  });

  test('superadmin sets roles with a state; nobody can grant superadmin via the API', async () => {
    const { token: sa } = await makeUser('superadmin');
    const { user: citizen, token: citizenToken } = await makeUser('citizen');

    const noState = await request(app).patch(`/api/v1/users/${citizen._id}/role`).set(as(sa)).send({ role: 'dispatcher' });
    assert.equal(noState.status, 400, 'a dispatcher needs a state');

    const ok = await request(app).patch(`/api/v1/users/${citizen._id}/role`).set(as(sa)).send({ role: 'dispatcher', state: 'Goa', country: 'India' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.region, 'india/goa');
    assert.equal(ok.body.user.regionName, 'Goa, India');
    assert.equal((await request(app).get('/api/v1/users/dispatchers').set(as(citizenToken))).status, 200, 'new role applies to the existing token');

    assert.equal((await request(app).patch(`/api/v1/users/${citizen._id}/role`).set(as(sa)).send({ role: 'superadmin' })).status, 403);
  });

  test('role change validates input and blocks changing yourself', async () => {
    const { user: me, token: sa } = await makeUser('superadmin');
    const auth = as(sa);
    assert.equal((await request(app).patch('/api/v1/users/not-an-id/role').set(auth).send({ role: 'admin' })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/users/${me._id}/role`).set(auth).send({ role: 'god' })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/users/${me._id}/role`).set(auth).send({ role: 'citizen' })).status, 400);
    assert.equal((await request(app).patch('/api/v1/users/507f1f77bcf86cd799439011/role').set(auth).send({ role: 'citizen' })).status, 404);
  });
});

describe('admin invites (state admins)', () => {
  const as = (token) => ({ Authorization: `Bearer ${token}` });
  const registerAdmin = (body) => request(app).post('/api/v1/auth/register-admin').send(body);

  test('only the superadmin can create invites', async () => {
    const { token: admin } = await makeUser('admin');
    const { token: citizen } = await makeUser('citizen');
    for (const t of [admin, citizen]) {
      assert.equal((await request(app).post('/api/v1/invites').set(as(t)).send({ state: 'Kerala' })).status, 403);
    }
  });

  test('an invite turns the registrant into that state admin, exactly once', async () => {
    const { token: sa } = await makeUser('superadmin');
    const inv = await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Kerala', country: 'India', note: 'Kerala PWD' });
    assert.equal(inv.status, 201);
    const { code } = inv.body;
    assert.match(code, /^ADM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(inv.body.invite.codeHash, undefined, 'hash never leaves the server');

    // Lower-case and spaces are accepted.
    const res = await registerAdmin({ code: code.toLowerCase().replace(/-/g, ' '), name: 'Kerala Admin', email: 'ka@kerala.gov', password: 'password123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.region, 'india/kerala');
    assert.equal(res.body.permissions.canManageStaff, true);
    assert.equal(res.body.permissions.canInviteAdmins, false);

    const again = await registerAdmin({ code, name: 'X', email: 'x@kerala.gov', password: 'password123' });
    assert.equal(again.status, 400, 'single use');

    const list = await request(app).get('/api/v1/invites').set(as(sa));
    assert.equal(list.body.data[0].status, 'used');
    assert.equal(list.body.data[0].usedBy.email, 'ka@kerala.gov');
  });

  test('a duplicate email does not burn the invite', async () => {
    const { token: sa } = await makeUser('superadmin');
    await makeUser('citizen', 'taken@mail.com');
    const { code } = (await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa' })).body;

    assert.equal((await registerAdmin({ code, name: 'A', email: 'taken@mail.com', password: 'password123' })).status, 409);
    assert.equal((await registerAdmin({ code, name: 'A', email: 'fresh@mail.com', password: 'password123' })).status, 201, 'still usable');
  });

  test('revoked, expired, and made-up codes are rejected with one generic message', async () => {
    const { token: sa } = await makeUser('superadmin');
    const revoked = (await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa' })).body;
    assert.equal((await request(app).delete(`/api/v1/invites/${revoked.invite._id}`).set(as(sa))).status, 200);

    const expired = (await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa' })).body;
    await Invite.updateOne({ _id: expired.invite._id }, { expiresAt: new Date(Date.now() - 1000) });

    const messages = new Set();
    let n = 0;
    for (const code of [revoked.code, expired.code, 'ADM-FAKE-FAKE-FAKE']) {
      n += 1;
      const r = await registerAdmin({ code, name: 'A', email: `a${n}@x.io`, password: 'password123' });
      assert.equal(r.status, 400);
      messages.add(r.body.error);
    }
    assert.equal(messages.size, 1, 'no hint about why a code failed');
  });

  test('three people redeeming the same code at once: exactly one admin is created', async () => {
    const { token: sa } = await makeUser('superadmin');
    const { code } = (await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Punjab' })).body;
    const results = await Promise.all(
      [1, 2, 3].map((i) => registerAdmin({ code, name: `A${i}`, email: `race${i}@x.io`, password: 'password123' }))
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400, 400]);
    assert.equal(await User.countDocuments({ role: 'admin', region: 'india/punjab' }), 1);
  });

  test('public registration can never produce staff, whatever is sent', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'Sneaky', email: 'sneaky@x.io', password: 'password123', role: 'superadmin', region: 'india/karnataka' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'citizen');
    assert.equal(res.body.user.region, null);
  });
});

describe('emailing invite codes', () => {
  const as = (token) => ({ Authorization: `Bearer ${token}` });

  beforeEach(() => {
    sentMails.length = 0;
    failMail.on = false;
  });

  test('with an email address the code is sent, with a link that pre-fills it', async () => {
    const { token: sa } = await makeUser('superadmin');
    const res = await request(app)
      .post('/api/v1/invites')
      .set(as(sa))
      .send({ state: 'Kerala', email: 'Official@Kerala.gov.in', note: 'Kerala PWD' });
    assert.equal(res.status, 201);
    assert.equal(res.body.emailed, true);
    assert.match(res.body.message, /emailed to official@kerala.gov.in/i);

    assert.equal(sentMails.length, 1);
    const mail = sentMails[0];
    assert.equal(mail.to, 'official@kerala.gov.in');
    assert.match(mail.subject, /Kerala, India/);
    assert.ok(mail.text.includes(res.body.code), 'plain-text body carries the code');
    assert.ok(mail.html.includes(res.body.code), 'html body carries the code');
    assert.ok(mail.text.includes(`/login?invite=${encodeURIComponent(res.body.code)}`), 'link pre-fills the code');
    assert.ok(mail.text.includes('superadmin'), 'says who invited them');

    const list = await request(app).get('/api/v1/invites').set(as(sa));
    assert.equal(list.body.data[0].sentTo, 'official@kerala.gov.in');
    assert.ok(list.body.data[0].sentAt);

    // The emailed code works exactly like a hand-delivered one.
    const reg = await request(app).post('/api/v1/auth/register-admin')
      .send({ code: res.body.code, name: 'K', email: 'official@kerala.gov.in', password: 'password123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.region, 'india/kerala');
  });

  test('without an email nothing is sent and the code is returned for hand delivery', async () => {
    const { token: sa } = await makeUser('superadmin');
    const res = await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa' });
    assert.equal(res.status, 201);
    assert.equal(res.body.emailed, false);
    assert.equal(sentMails.length, 0);
    assert.ok(res.body.code);
  });

  test('an invalid email is rejected before any invite is created', async () => {
    const { token: sa } = await makeUser('superadmin');
    const res = await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa', email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(await Invite.countDocuments(), 0);
    assert.equal(sentMails.length, 0);
  });

  test('if the mail server is down the invite still exists and the code is returned', async () => {
    const { token: sa } = await makeUser('superadmin');
    failMail.on = true;
    const res = await request(app).post('/api/v1/invites').set(as(sa)).send({ state: 'Goa', email: 'x@goa.gov.in' });
    assert.equal(res.status, 201);
    assert.equal(res.body.emailed, false);
    assert.match(res.body.emailError, /SMTP down/);
    assert.ok(res.body.code, 'superadmin can still pass the code on by hand');
    const list = await request(app).get('/api/v1/invites').set(as(sa));
    assert.equal(list.body.data[0].sentTo, null, 'not recorded as sent');
  });

  test('html email escapes user-supplied text', () => {
    const { html } = inviteEmail({ code: 'ADM-TEST-TEST-TEST', regionName: 'X<script>alert(1)</script>', expiresAt: new Date(), note: '<b>n</b>', invitedBy: 'A&B' });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('A&amp;B'));
  });
});
