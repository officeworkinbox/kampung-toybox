const { db } = require('./db');
const { tierFor } = require('./tiers');

// Community rules in one place, so the README, the UI and the server agree.
const RULES = {
  NOTE_MIN: 20,                 // a request must explain who the toy is for
  NOTE_MAX: 500,
  RECEIVE_WINDOW_DAYS: 30,      // anti-hoarding: toys received per rolling window
  RECEIVE_MAX_IN_WINDOW: 4,
  NO_SHOW_WINDOW_DAYS: 60,      // two no-shows in this window pause new requests
  NO_SHOW_MAX: 2,
  REPORTS_TO_HIDE_TOY: 3,       // distinct neighbours reporting a listing hides it
  REPORTS_TO_SUSPEND_USER: 3,   // distinct neighbours reporting a member pauses the account
  OTP_TTL_MINUTES: 10,
  OTP_MAX_ATTEMPTS: 5,
  MAX_PHOTOS: 4,
  MAX_PHOTO_MB: 5,
};

const CONDITIONS = ['Like new', 'Gently used', 'Well loved', 'Needs a little fixing'];
const AGE_RANGES = ['0-12 months', '1-2 years', '3-5 years', '6-8 years', '9-12 years', '13+ years'];
const REPORT_REASONS = ['Looks like a scam or resale', 'Unsafe or recalled toy', 'Inappropriate content',
  'No-show or rude behaviour', 'Not really in this neighbourhood', 'Something else'];

const activeCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM requests WHERE requester_id = ? AND status IN ('pending','approved')`);
const receivedRecentStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM requests WHERE requester_id = ? AND status = 'completed'
     AND completed_at >= datetime('now', ?)`);
const noShowRecentStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM requests WHERE requester_id = ? AND status = 'no_show'
     AND decided_at >= datetime('now', ?)`);
const existingStmt = db.prepare('SELECT status FROM requests WHERE toy_id = ? AND requester_id = ?');

/**
 * Can `user` request `toy`? Returns { ok: true } or { ok: false, reason }.
 * This is the server-side gate; the UI only mirrors it.
 */
function canRequest(user, toy) {
  if (!user.verified_at) return { ok: false, reason: 'Verify your neighbourhood first.' };
  if (user.suspended_at) return { ok: false, reason: 'Your account is paused pending review.' };
  if (!toy || toy.planning_area !== user.planning_area || toy.hidden_at) {
    return { ok: false, reason: 'This toy is not in your neighbourhood.' };
  }
  if (toy.giver_id === user.id) return { ok: false, reason: 'This is your own listing.' };
  if (toy.status !== 'available') return { ok: false, reason: 'This toy has already found a family.' };
  const existing = existingStmt.get(toy.id, user.id);
  if (existing) return { ok: false, reason: `You already asked for this toy (${existing.status.replace('_', ' ')}).` };

  const { tier } = tierFor(user.id);
  const active = activeCountStmt.get(user.id).n;
  if (active >= tier.requestLimit) {
    return { ok: false, reason: `As a ${tier.name} you can have ${tier.requestLimit} open requests at a time. Wait for a reply or cancel one first.` };
  }
  const received = receivedRecentStmt.get(user.id, `-${RULES.RECEIVE_WINDOW_DAYS} days`).n;
  if (received >= RULES.RECEIVE_MAX_IN_WINDOW) {
    return { ok: false, reason: `You've received ${received} toys in the last ${RULES.RECEIVE_WINDOW_DAYS} days. Let other families have a turn for a little while.` };
  }
  const noShows = noShowRecentStmt.get(user.id, `-${RULES.NO_SHOW_WINDOW_DAYS} days`).n;
  if (noShows >= RULES.NO_SHOW_MAX) {
    return { ok: false, reason: 'Requests are paused after two missed pickups. They resume automatically later.' };
  }
  return { ok: true };
}

module.exports = { RULES, CONDITIONS, AGE_RANGES, REPORT_REASONS, canRequest };
