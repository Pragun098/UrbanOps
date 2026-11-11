/**
 * Server-side account setup. The ONLY way to create a superadmin.
 *
 *   npm run seed
 *     → superadmin + a demo Karnataka admin and dispatcher (dev defaults below),
 *       and fills in the state for any issue that doesn't have one yet.
 *
 *   npm run seed -- --email a@x.gov --password 'S3cret!!' --role superadmin --name "Asha"
 *   npm run seed -- --email b@x.gov --password 'S3cret!!' --role admin --state Karnataka --country India
 *
 * Re-running with an existing email resets that account's password, role and state.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Issue = require('../models/Issue');
const { ROLES, SCOPED_ROLES } = require('../config/constants');
const { hashPassword } = require('../services/auth');
const { makeRegion, resolveRegion, UNASSIGNED } = require('../services/regions');

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
};

const upsertUser = async ({ name, email, password, role, state, country }) => {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!password || password.length < 8) throw new Error(`password for ${email} must be at least 8 characters`);

  let region = { key: null, name: null };
  if (SCOPED_ROLES.includes(role)) {
    region = makeRegion(state, country || 'India');
    if (region.key === UNASSIGNED.key) throw new Error(`${role} ${email} needs --state (and optionally --country)`);
  }

  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      name,
      role,
      region: region.key,
      regionName: region.name,
      mustChangePassword: false,
      passwordHash: await hashPassword(password),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  console.log(`  ✓ ${user.role.padEnd(11)} ${user.email}${user.regionName ? `  (${user.regionName})` : ''}`);
};

/** Issues created before regions existed: resolve their state from the location. */
const backfillIssueRegions = async () => {
  const missing = await Issue.find({ $or: [{ region: { $exists: false } }, { region: null }, { region: UNASSIGNED.key }] })
    .select('location')
    .lean();
  if (!missing.length) return;
  console.log(`Resolving state for ${missing.length} issue(s) (rate-limited, ~1/s for new areas)…`);
  for (const issue of missing) {
    const [lng, lat] = issue.location.coordinates;
    // eslint-disable-next-line no-await-in-loop
    const region = await resolveRegion(lat, lng);
    // eslint-disable-next-line no-await-in-loop
    await Issue.updateOne({ _id: issue._id }, { $set: { region: region.key, regionName: region.name } });
    console.log(`  · ${String(issue._id).slice(-6)} → ${region.name}`);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();

  if (args.email) {
    await upsertUser({
      name: args.name || args.email.split('@')[0],
      email: args.email,
      password: args.password,
      role: args.role || 'dispatcher',
      state: args.state,
      country: args.country,
    });
  } else {
    if (process.env.NODE_ENV === 'production' && !process.env.SEED_SUPERADMIN_PASSWORD) {
      throw new Error('Set SEED_SUPERADMIN_PASSWORD (and the other SEED_* passwords) in production');
    }
    console.log('Seeding default accounts (development):');
    await upsertUser({
      name: 'Platform Owner',
      email: process.env.SEED_SUPERADMIN_EMAIL || 'superadmin@urbanops.local',
      password: process.env.SEED_SUPERADMIN_PASSWORD || 'super12345',
      role: 'superadmin',
    });
    await upsertUser({
      name: 'Karnataka Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@urbanops.local',
      password: process.env.SEED_ADMIN_PASSWORD || 'admin12345',
      role: 'admin',
      state: 'Karnataka',
      country: 'India',
    });
    await upsertUser({
      name: 'Dispatcher 804',
      email: process.env.SEED_DISPATCHER_EMAIL || 'dispatcher@urbanops.local',
      password: process.env.SEED_DISPATCHER_PASSWORD || 'dispatch12345',
      role: 'dispatcher',
      state: 'Karnataka',
      country: 'India',
    });
    await backfillIssueRegions();
  }
};

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
