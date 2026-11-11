/**
 * Step-3 walkthrough against a RUNNING server (npm run dev in another terminal).
 *
 *   npm run demo
 *
 * Shows: citizen signup/login, a new report, a nearby duplicate being merged
 * (severity rises), a different category staying separate, the dispatcher's
 * priority queue, a Kanban move, and dashboard stats.
 *
 * Uses demo accounts (demo.citizen1/2@urbanops.local) and puts real issues in the
 * dev database so the dashboard has data once it is wired up in step 5.
 */

require('dotenv').config();

const BASE = process.env.DEMO_API || `http://localhost:${process.env.PORT || 5000}/api/v1`;

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const step = (n, title) => console.log(`\n${c.bold(c.cyan(`[${n}] ${title}`))}`);
const show = (label, value) => console.log(`    ${c.dim(label.padEnd(16))} ${value}`);
const statusColor = (s) => (s < 300 ? c.green(s) : s < 500 ? c.yellow(s) : c.red(s));

const loginOrRegister = async (name, email, password) => {
  let r = await api('POST', '/auth/login', { body: { email, password } });
  if (r.status === 401) r = await api('POST', '/auth/register', { body: { name, email, password } });
  if (!r.data.token) throw new Error(`Could not sign in ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
};

const printIssue = (r) => {
  const i = r.data.issue;
  show('HTTP', `${statusColor(r.status)} ${r.data.message || ''}`);
  show('issue', `${i.subcategory} (${i.category}) @ ${i.address || i.location.coordinates.join(', ')}`);
  show('severity', c.bold(i.severityScore));
  show('reports', i.reportCount);
  show('id', c.dim(i._id));
};

const main = async () => {
  console.log(c.bold(`UrbanOps step-3 demo → ${BASE}`));

  const health = await fetch(BASE.replace('/v1', '') + '/health').then((r) => r.json()).catch(() => null);
  if (!health) {
    console.log(c.red(`\nCannot reach the server. Start it first with:  npm run dev   (port ${process.env.PORT || 5000})`));
    process.exit(1);
  }
  show('server', `${health.status}, database ${health.db}`);

  step(1, 'Two citizens sign in (or register on first run)');
  const asha = await loginOrRegister('Asha (demo)', 'demo.citizen1@urbanops.local', 'demo-pass-123');
  const ravi = await loginOrRegister('Ravi (demo)', 'demo.citizen2@urbanops.local', 'demo-pass-123');
  show('citizen 1', `${asha.user.name} → role ${asha.user.role}`);
  show('citizen 2', `${ravi.user.name} → role ${ravi.user.role}`);

  const disp = await api('POST', '/auth/login', {
    body: { email: process.env.SEED_DISPATCHER_EMAIL || 'dispatcher@urbanops.local', password: process.env.SEED_DISPATCHER_PASSWORD || 'dispatch12345' },
  });
  if (!disp.data.token) {
    console.log(c.red('\nDispatcher login failed. Run  npm run seed  first.'));
    process.exit(1);
  }
  show('dispatcher', `${disp.data.user.name} → role ${disp.data.user.role}`);

  step(2, 'Asha reports a water leak on MG Road');
  const first = await api('POST', '/issues', {
    token: asha.token,
    body: { subcategory: 'Water leak', description: 'Water gushing from a pipe near the metro pillar', address: 'MG Road, District 04', location: { lat: 12.975, lng: 77.605 } },
  });
  printIssue(first);

  step(3, 'Ravi reports the SAME leak ~40m away → merged, not duplicated');
  const second = await api('POST', '/issues', {
    token: ravi.token,
    body: { subcategory: 'Water leak', description: 'Road flooded', address: 'MG Road metro', location: { lat: 12.9753, lng: 77.6052 } },
  });
  printIssue(second);
  show('same ticket?', second.data.issue._id === first.data.issue._id ? c.green('YES — dedup worked') : c.yellow('no'));

  step(4, 'Asha reports it again → counted once per person, severity unchanged');
  const again = await api('POST', '/issues', {
    token: asha.token,
    body: { subcategory: 'Water leak', location: { lat: 12.9751, lng: 77.6051 } },
  });
  printIssue(again);

  step(5, 'A pothole at the same spot → different category, separate ticket');
  const pothole = await api('POST', '/issues', {
    token: ravi.token,
    body: { subcategory: 'Pothole', address: 'Church Street, District 03', location: { lat: 12.9745, lng: 77.6 } },
  });
  printIssue(pothole);

  step(6, "Dispatcher's priority queue (sorted by severity)");
  const queue = await api('GET', '/issues?limit=10', { token: disp.data.token });
  queue.data.data.forEach((i, n) => {
    console.log(`    ${String(n + 1).padStart(2)}. ${c.bold(String(i.severityScore).padStart(5))}  ${i.subcategory.padEnd(14)} ${i.status.padEnd(10)} ${i.reportCount} report(s)  ${c.dim(i.address || '')}`);
  });

  step(7, 'Citizens cannot see the dispatcher-only stats');
  const forbidden = await api('GET', '/issues/stats', { token: asha.token });
  show('HTTP', `${statusColor(forbidden.status)} ${forbidden.data.error}`);

  step(8, 'Dispatcher moves the leak to "dispatched" and assigns it');
  const moved = await api('PATCH', `/issues/${first.data.issue._id}`, {
    token: disp.data.token,
    body: { status: first.data.issue.status === 'open' ? 'dispatched' : first.data.issue.status, assignedTo: disp.data.user._id },
  });
  show('HTTP', statusColor(moved.status));
  show('status', moved.data.issue?.status || moved.data.error);
  show('assigned to', moved.data.issue?.assignedTo?.name || '-');

  step(9, 'Asha checks "My reports"');
  const mine = await api('GET', '/issues/mine', { token: asha.token });
  mine.data.data.forEach((i) => show(i.subcategory, `${i.status}  (severity ${i.severityScore})`));

  step(10, 'Dashboard stats (these will replace the fake numbers on the dashboard)');
  const stats = await api('GET', '/issues/stats', { token: disp.data.token });
  const s = stats.data.data;
  show('active', s.active);
  show('high priority', s.highPriority);
  show('assigned staff', s.assignedStaff);
  show('resolved today', s.resolvedToday);
  show('dupes merged', s.duplicatesMerged);

  console.log(`\n${c.green('Done.')} Re-running is safe: the same people re-reporting won't inflate anything.\n`);
};

main().catch((err) => {
  console.error(c.red(`\nDemo failed: ${err.message}`));
  process.exit(1);
});
