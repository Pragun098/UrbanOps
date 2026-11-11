/**
 * Admin invites (superadmin only).
 *
 *   POST   /api/v1/invites        { state, country?, note?, expiresInDays? } → { invite, code } (code shown ONCE)
 *   GET    /api/v1/invites        latest invites with status (active/used/expired/revoked)
 *   DELETE /api/v1/invites/:id    revoke an unused invite
 *   GET    /api/v1/invites/regions  states seen so far (issues + staff), for pickers and filters
 */

const express = require('express');
const mongoose = require('mongoose');
const Invite = require('../models/Invite');
const Issue = require('../models/Issue');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createInvite } = require('../services/invites');
const { makeRegion } = require('../services/regions');

const router = express.Router();
router.use(requireAuth, requireRole('superadmin'));

router.post('/', async (req, res, next) => {
  try {
    const { state, country = 'India', note } = req.body || {};
    const region = makeRegion(state, country);
    if (region.key === 'unassigned') {
      return res.status(400).json({ success: false, error: 'state and country are required' });
    }
    const days = Math.min(30, Math.max(1, parseInt(req.body?.expiresInDays, 10) || 7));
    if (note !== undefined && (typeof note !== 'string' || note.length > 200)) {
      return res.status(400).json({ success: false, error: 'note must be a string of at most 200 characters' });
    }

    const { invite, code } = await createInvite({
      region: region.key,
      regionName: region.name,
      note: note?.trim() || undefined,
      createdBy: req.user._id,
      expiresInDays: days,
    });
    return res.status(201).json({
      success: true,
      invite,
      code,
      message: `Send this code to the ${region.name} official. It works once and expires in ${days} day(s).`,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const invites = await Invite.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('usedBy', 'name email')
      .populate('createdBy', 'name');
    return res.json({ success: true, data: invites.map((i) => i.toJSON()) });
  } catch (err) {
    return next(err);
  }
});

router.get('/regions', async (req, res, next) => {
  try {
    const [issueRegions, staffRegions] = await Promise.all([
      Issue.aggregate([
        {
          $group: {
            _id: '$region',
            name: { $first: '$regionName' },
            open: { $sum: { $cond: [{ $ne: ['$status', 'resolved'] }, 1, 0] } },
            total: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        { $match: { role: { $in: ['dispatcher', 'admin'] }, region: { $ne: null } } },
        {
          $group: {
            _id: '$region',
            name: { $first: '$regionName' },
            admins: { $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
            dispatchers: { $sum: { $cond: [{ $eq: ['$role', 'dispatcher'] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const byKey = new Map();
    for (const r of issueRegions) byKey.set(r._id, { key: r._id, name: r.name, open: r.open, total: r.total, admins: 0, dispatchers: 0 });
    for (const r of staffRegions) {
      const row = byKey.get(r._id) || { key: r._id, name: r.name, open: 0, total: 0 };
      byKey.set(r._id, { ...row, admins: r.admins, dispatchers: r.dispatchers });
    }
    const data = [...byKey.values()].sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name));
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const invite = await Invite.findOneAndUpdate(
      { _id: req.params.id, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true }
    );
    if (!invite) return res.status(404).json({ success: false, error: 'No active invite with that id' });
    return res.json({ success: true, invite: invite.toJSON() });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
