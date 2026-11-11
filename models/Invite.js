/**
 * Admin invite codes. The superadmin creates one per state official; the official
 * registers with it and becomes admin of that state.
 *
 * Only a SHA-256 hash of the code is stored (like a password), so a database leak
 * doesn't leak usable codes. Codes are single-use, expire, and can be revoked.
 */

const mongoose = require('mongoose');

const { Schema } = mongoose;

const InviteSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    // First characters, shown in lists so the superadmin can tell codes apart.
    codeHint: { type: String, required: true },
    role: { type: String, enum: ['admin'], default: 'admin' },
    region: { type: String, required: true },
    regionName: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 200 },
    // Where the code was emailed, if it was.
    sentTo: { type: String, lowercase: true, trim: true, default: null },
    sentAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

InviteSchema.virtual('status').get(function status() {
  if (this.revokedAt) return 'revoked';
  if (this.usedAt) return 'used';
  if (this.expiresAt < new Date()) return 'expired';
  return 'active';
});

InviteSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.codeHash;
    delete ret.__v;
    delete ret.id;
    return ret;
  },
});

module.exports = mongoose.models.Invite || mongoose.model('Invite', InviteSchema);
