/**
 * Role hierarchy and jurisdiction.
 *
 *   citizen     report issues anywhere; see only their own reports
 *   dispatcher  ONE state: monitor, dispatch and assign, undo a dispatch, resolve
 *   admin       ONE state: everything a dispatcher can do, plus close without
 *               dispatch, reopen, and manage that state's dispatchers
 *   superadmin  platform owner, ALL states: everything, plus issue admin invites
 *
 * Dispatchers and admins are scoped to `user.region` (e.g. "india/karnataka").
 * The API enforces all of this. The frontend mirrors it only to hide buttons.
 */

const { SCOPED_ROLES, STAFF_ROLES } = require('./constants');

const ROLE_RANK = Object.freeze({ citizen: 0, dispatcher: 1, admin: 2, superadmin: 3 });

const ADMIN_TRANSITIONS = Object.freeze({
  open: ['dispatched', 'resolved'],
  dispatched: ['resolved', 'open'],
  resolved: ['open'],
});

// Status transitions each role may perform: { from: [to, ...] }
const TRANSITIONS_BY_ROLE = Object.freeze({
  citizen: Object.freeze({}),
  dispatcher: Object.freeze({
    open: ['dispatched'],
    dispatched: ['resolved', 'open'],
  }),
  admin: ADMIN_TRANSITIONS,
  superadmin: ADMIN_TRANSITIONS,
});

const allowedTransitions = (role, from) => (TRANSITIONS_BY_ROLE[role] || {})[from] || [];

const canTransition = (role, from, to) => allowedTransitions(role, from).includes(to);

/** Transitions that exist for *someone*: used to tell "not allowed for you" (403) from "never allowed" (400). */
const anyRoleCanTransition = (from, to) => Object.keys(TRANSITIONS_BY_ROLE).some((r) => canTransition(r, from, to));

const atLeast = (role, minimum) => (ROLE_RANK[role] ?? -1) >= ROLE_RANK[minimum];

const isStaffRole = (role) => STAFF_ROLES.includes(role);
const isScopedRole = (role) => SCOPED_ROLES.includes(role);

class JurisdictionError extends Error {
  constructor(message = 'Your account has no state assigned; ask your administrator') {
    super(message);
    this.status = 403;
  }
}

/**
 * Mongo filter limiting a query to what `user` may see.
 * Superadmin: everything. Dispatcher/admin: their region only.
 * A scoped user WITHOUT a region gets an error, never an unfiltered query.
 */
const regionScope = (user) => {
  if (user.role === 'superadmin') return {};
  if (isScopedRole(user.role)) {
    if (!user.region) throw new JurisdictionError();
    return { region: user.region };
  }
  throw new JurisdictionError('Not permitted');
};

/** Can `user` act on something in `region`? */
const inJurisdiction = (user, region) =>
  user.role === 'superadmin' || (isScopedRole(user.role) && !!user.region && user.region === region);

module.exports = {
  ROLE_RANK,
  TRANSITIONS_BY_ROLE,
  allowedTransitions,
  canTransition,
  anyRoleCanTransition,
  atLeast,
  isStaffRole,
  isScopedRole,
  regionScope,
  inJurisdiction,
  JurisdictionError,
};
