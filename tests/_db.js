/**
 * Shared test DB helpers. Uses a dedicated database that is dropped after each file,
 * so the dev `urbanops` database is never touched.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const mongoose = require('mongoose');
const { setResolver } = require('../services/regions');
const { setTransport } = require('../services/mailer');

// Capture outgoing email in memory (never hits SMTP or Ethereal in tests).
const sentMails = [];
const failMail = { on: false };
setTransport({
  sendMail: async (mail) => {
    if (failMail.on) throw new Error('SMTP down (simulated)');
    sentMails.push(mail);
    return { messageId: `test-${sentMails.length}` };
  },
});

// Deterministic, offline region lookup for tests (never calls Nominatim).
const KARNATAKA = { key: 'india/karnataka', name: 'Karnataka, India' };
const MAHARASHTRA = { key: 'india/maharashtra', name: 'Maharashtra, India' };
setResolver(async (lat, lng) => {
  if (lat >= 11.5 && lat <= 18.5 && lng >= 74 && lng <= 78.6) return KARNATAKA;
  if (lat >= 18.8 && lat <= 19.4 && lng >= 72.6 && lng <= 73.2) return MAHARASHTRA;
  return { key: 'unassigned', name: 'Unassigned' };
});
const { connectDB } = require('../config/db');

const TEST_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/urbanops_test';

const connectTestDb = async () => {
  await connectDB(TEST_URI);
};

const clearTestDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
};

const dropTestDb = async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
};

module.exports = { connectTestDb, clearTestDb, dropTestDb, TEST_URI, KARNATAKA, MAHARASHTRA, sentMails, failMail };
