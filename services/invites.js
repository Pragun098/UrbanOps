/**
 * Admin invite codes: generation, hashing, single-use redemption.
 */

const crypto = require('crypto');
const Invite = require('../models/Invite');

// No 0/O/1/I/L: codes get read out over the phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** e.g. "ADM-7F3Q-92XD-KM4P" (60 bits of randomness). */
const generateCode = () => {
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `ADM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
};

/** Case/space-insensitive so "adm 7f3q-92xd km4p" still works. */
const normalizeCode = (code) =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const hashCode = (code) => crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');

const createInvite = async ({ region, regionName, note, createdBy, expiresInDays = 7 }) => {
  const code = generateCode();
  const invite = await Invite.create({
    codeHash: hashCode(code),
    codeHint: code.slice(0, 8),
    region,
    regionName,
    note,
    createdBy,
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 3600 * 1000),
  });
  return { invite, code }; // the plain code is returned ONCE and never stored
};

/**
 * Atomically claim an invite: only one request can ever succeed per code, even
 * if two people submit it at the same moment. Returns the claimed invite or null.
 */
const claimInvite = (code) =>
  Invite.findOneAndUpdate(
    { codeHash: hashCode(code), usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );

/** Undo a claim if creating the account failed afterwards (e.g. email taken). */
const releaseInvite = (inviteId) => Invite.updateOne({ _id: inviteId }, { $set: { usedAt: null, usedBy: null } });

module.exports = { generateCode, normalizeCode, hashCode, createInvite, claimInvite, releaseInvite };
