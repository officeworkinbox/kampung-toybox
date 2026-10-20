const { db } = require('./db');

// Tiers are earned, never bought. Each tier lists the minimum for every metric;
// a member holds the highest tier whose every requirement they meet.
//   given     – toys they gave away (completed handovers as the giver)
//   handovers – completed handovers in either role (giver or receiver)
//   kudos     – distinct neighbours who left you 4★ or 5★ feedback
// From "Kind Neighbour" up, the member's average rating must also be >= 4.0
// once they have 3+ reviews, so volume alone can't buy a badge.
// `requestLimit` is how many open requests (pending + approved) the member
// may hold at once – trusted members get a little more room.
const TIERS = [
  { key: 'seedling', name: 'Seedling', icon: '🌱', given: 0, handovers: 0, kudos: 0, requestLimit: 2,
    blurb: 'Welcome to the kampung! Every journey starts with one blessing.' },
  { key: 'sprout', name: 'Sprout', icon: '🌿', given: 1, handovers: 1, kudos: 0, requestLimit: 3,
    blurb: 'You have passed on your first toy. The kampung is growing!' },
  { key: 'kind', name: 'Kind Neighbour', icon: '🌼', given: 3, handovers: 4, kudos: 2, minRating: 4.0, requestLimit: 3,
    blurb: 'Families nearby know they can count on you.' },
  { key: 'hero', name: 'Kampung Hero', icon: '🌳', given: 8, handovers: 10, kudos: 6, minRating: 4.0, requestLimit: 4,
    blurb: 'A pillar of the neighbourhood. Your blessings travel far.' },
  { key: 'keeper', name: 'Blessing Keeper', icon: '🌟', given: 20, handovers: 25, kudos: 15, minRating: 4.0, requestLimit: 5,
    blurb: 'Legendary generosity. Thank you for keeping the kampung spirit alive.' },
];

const METRICS = [
  { key: 'given', label: 'Toys given' },
  { key: 'handovers', label: 'Completed handovers' },
  { key: 'kudos', label: 'Kudos (4★+ from different neighbours)' },
];

const statsStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM requests r JOIN toys t ON t.id = r.toy_id
      WHERE r.status = 'completed' AND t.giver_id = :id) AS given,
    (SELECT COUNT(*) FROM requests r
      WHERE r.status = 'completed' AND r.requester_id = :id) AS received,
    (SELECT COUNT(DISTINCT from_id) FROM feedback WHERE to_id = :id AND rating >= 4) AS kudos,
    (SELECT COUNT(*) FROM feedback WHERE to_id = :id) AS reviews,
    (SELECT AVG(rating) FROM feedback WHERE to_id = :id) AS avg_rating,
    (SELECT COUNT(*) FROM requests WHERE requester_id = :id AND status = 'no_show') AS no_shows,
    (SELECT COUNT(*) FROM toys WHERE giver_id = :id AND status IN ('available','reserved') AND hidden_at IS NULL) AS listed
`);

function statsFor(userId) {
  const s = statsStmt.get({ id: userId });
  return {
    given: s.given,
    received: s.received,
    handovers: s.given + s.received,
    kudos: s.kudos,
    reviews: s.reviews,
    avgRating: s.avg_rating == null ? null : Math.round(s.avg_rating * 10) / 10,
    noShows: s.no_shows,
    listed: s.listed,
  };
}

function meetsTier(stats, tier) {
  if (stats.given < tier.given || stats.handovers < tier.handovers || stats.kudos < tier.kudos) return false;
  if (tier.minRating && stats.reviews >= 3 && stats.avgRating < tier.minRating) return false;
  return true;
}

/** Current tier, next tier, and per-metric progress toward the next tier. */
function tierFor(userId) {
  const stats = statsFor(userId);
  let index = 0;
  TIERS.forEach((t, i) => { if (meetsTier(stats, t)) index = i; });
  const tier = TIERS[index];
  const next = TIERS[index + 1] || null;
  const progress = next
    ? METRICS.map((m) => ({
        ...m,
        have: stats[m.key],
        need: next[m.key],
        pct: next[m.key] === 0 ? 100 : Math.min(100, Math.round((stats[m.key] / next[m.key]) * 100)),
      }))
    : [];
  const ratingBlocked = !!(next && next.minRating && stats.reviews >= 3 && stats.avgRating < next.minRating);
  const overallPct = progress.length
    ? Math.round(progress.reduce((a, p) => a + p.pct, 0) / progress.length)
    : 100;
  return { tier, next, stats, progress, overallPct, ratingBlocked, index };
}

module.exports = { TIERS, METRICS, tierFor, statsFor, meetsTier };
