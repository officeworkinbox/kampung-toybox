const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { db, tx } = require('../db');
const { RULES, REPORT_REASONS } = require('../rules');
const { TIERS, METRICS, tierFor } = require('../tiers');
const { flash, requireVerified } = require('../middleware');

const router = express.Router();
router.use(requireVerified);

/** Loads a request plus its toy, only if the viewer is the giver or the requester. */
function loadRequest(req, next) {
  const r = db.prepare(`SELECT r.*, t.giver_id, t.title AS toy_title, t.status AS toy_status, t.planning_area,
      g.display_name AS giver_name, q.display_name AS requester_name
    FROM requests r JOIN toys t ON t.id = r.toy_id
    JOIN users g ON g.id = t.giver_id JOIN users q ON q.id = r.requester_id
    WHERE r.id = ?`).get(Number(req.params.id) || 0);
  const mine = r && (r.giver_id === req.user.id || r.requester_id === req.user.id)
    && r.planning_area === req.user.planning_area;
  if (!mine) {
    const err = new Error("We couldn't find that request.");
    err.status = 404;
    next(err);
    return null;
  }
  return r;
}

function back(res, r) { res.redirect(`/toys/${r.toy_id}`); }

// Giver approves one request: toy is reserved, other pending requests are let down gently.
router.post('/requests/:id/approve', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.giver_id !== req.user.id) return next(Object.assign(new Error('Only the giver can approve.'), { status: 403 }));
  if (r.status !== 'pending' || r.toy_status !== 'available') {
    flash(req, 'warn', 'This request can no longer be approved.'); return back(res, r);
  }
  const requester = db.prepare('SELECT suspended_at FROM users WHERE id = ?').get(r.requester_id);
  if (requester.suspended_at) { flash(req, 'warn', 'This neighbour is paused pending review.'); return back(res, r); }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  tx(() => {
    db.prepare(`UPDATE requests SET status = 'approved', handover_code = ?, decided_at = datetime('now') WHERE id = ?`).run(code, r.id);
    db.prepare(`UPDATE toys SET status = 'reserved' WHERE id = ?`).run(r.toy_id);
    db.prepare(`UPDATE requests SET status = 'declined', decided_at = datetime('now')
      WHERE toy_id = ? AND id != ? AND status = 'pending'`).run(r.toy_id, r.id);
  });
  flash(req, 'success', `Approved! ${r.requester_name} will see a handover code. Ask them for it when you meet.`);
  back(res, r);
});

router.post('/requests/:id/decline', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.giver_id !== req.user.id || r.status !== 'pending') { flash(req, 'warn', 'Nothing to decline.'); return back(res, r); }
  db.prepare(`UPDATE requests SET status = 'declined', decided_at = datetime('now') WHERE id = ?`).run(r.id);
  flash(req, 'info', 'Request declined.');
  back(res, r);
});

// Requester withdraws (pending or approved). An approved toy goes back on the shelf.
router.post('/requests/:id/cancel', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.requester_id !== req.user.id || !['pending', 'approved'].includes(r.status)) {
    flash(req, 'warn', 'This request can no longer be cancelled.'); return res.redirect('/me');
  }
  tx(() => {
    db.prepare(`UPDATE requests SET status = 'cancelled', decided_at = datetime('now') WHERE id = ?`).run(r.id);
    if (r.status === 'approved') db.prepare(`UPDATE toys SET status = 'available' WHERE id = ?`).run(r.toy_id);
  });
  flash(req, 'info', 'Request cancelled. Thanks for letting your neighbour know.');
  res.redirect('/me');
});

// Giver ends an approved handover. `no_show` counts against the requester; `release` doesn't.
router.post('/requests/:id/release', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.giver_id !== req.user.id || r.status !== 'approved') { flash(req, 'warn', 'Nothing to release.'); return back(res, r); }
  const noShow = req.body.reason === 'no_show';
  tx(() => {
    db.prepare(`UPDATE requests SET status = ?, decided_at = datetime('now') WHERE id = ?`).run(noShow ? 'no_show' : 'cancelled', r.id);
    db.prepare(`UPDATE toys SET status = 'available' WHERE id = ?`).run(r.toy_id);
  });
  flash(req, 'info', noShow ? 'Marked as a no-show. The toy is available again.' : 'Handover released. The toy is available again.');
  back(res, r);
});

// Giver confirms the handover by typing the code the recipient shows them in person.
router.post('/requests/:id/complete', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.giver_id !== req.user.id || r.status !== 'approved') { flash(req, 'warn', 'This handover is not waiting for confirmation.'); return back(res, r); }
  const code = String(req.body.code || '').trim();
  const ok = /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(r.handover_code));
  if (!ok) { flash(req, 'warn', "That code doesn't match. Ask the family to read it from their My Kampung page."); return back(res, r); }
  const before = tierFor(req.user.id).tier;
  tx(() => {
    db.prepare(`UPDATE requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(r.id);
    db.prepare(`UPDATE toys SET status = 'given' WHERE id = ?`).run(r.toy_id);
  });
  const after = tierFor(req.user.id).tier;
  flash(req, 'success', after.key !== before.key
    ? `Blessing delivered! 🎉 You've grown into a ${after.icon} ${after.name}!`
    : `Blessing delivered! 🎉 Thank you for passing on "${r.toy_title}".`);
  res.redirect('/me');
});

const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(300).default(''),
});

router.post('/requests/:id/feedback', (req, res, next) => {
  const r = loadRequest(req, next); if (!r) return;
  if (r.status !== 'completed') { flash(req, 'warn', 'Feedback opens once the handover is confirmed.'); return res.redirect('/me'); }
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) { flash(req, 'warn', 'Pick a rating from 1 to 5 stars.'); return res.redirect('/me'); }
  const toId = r.giver_id === req.user.id ? r.requester_id : r.giver_id;
  const info = db.prepare('INSERT OR IGNORE INTO feedback (request_id, from_id, to_id, rating, comment) VALUES (?, ?, ?, ?, ?)')
    .run(r.id, req.user.id, toId, parsed.data.rating, parsed.data.comment);
  flash(req, info.changes ? 'success' : 'info', info.changes ? 'Thanks for the feedback!' : 'You already left feedback for this handover.');
  res.redirect('/me');
});

// ---------- My Kampung dashboard ----------

router.get('/me', (req, res) => {
  const uid = req.user.id;
  const myToys = db.prepare(`SELECT t.*,
      (SELECT id FROM toy_photos p WHERE p.toy_id = t.id ORDER BY position LIMIT 1) AS photo_id,
      (SELECT COUNT(*) FROM requests r WHERE r.toy_id = t.id AND r.status = 'pending') AS pending,
      (SELECT u.display_name FROM requests r JOIN users u ON u.id = r.requester_id
        WHERE r.toy_id = t.id AND r.status = 'approved') AS approved_for
    FROM toys t WHERE t.giver_id = ? AND t.status != 'withdrawn'
    ORDER BY CASE t.status WHEN 'reserved' THEN 0 WHEN 'available' THEN 1 ELSE 2 END, t.created_at DESC`).all(uid);
  const myRequests = db.prepare(`SELECT r.*, t.title AS toy_title, t.giver_id, u.display_name AS giver_name,
      (SELECT id FROM toy_photos p WHERE p.toy_id = t.id ORDER BY position LIMIT 1) AS photo_id,
      (SELECT rating FROM feedback f WHERE f.request_id = r.id AND f.from_id = r.requester_id) AS my_rating
    FROM requests r JOIN toys t ON t.id = r.toy_id JOIN users u ON u.id = t.giver_id
    WHERE r.requester_id = ? ORDER BY CASE r.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.created_at DESC
    LIMIT 30`).all(uid);
  const givenNeedingFeedback = db.prepare(`SELECT r.id, t.title AS toy_title, u.display_name AS requester_name
    FROM requests r JOIN toys t ON t.id = r.toy_id JOIN users u ON u.id = r.requester_id
    WHERE t.giver_id = ? AND r.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.request_id = r.id AND f.from_id = ?)`).all(uid, uid);
  const active = myRequests.filter((r) => ['pending', 'approved'].includes(r.status)).length;
  res.render('me', { title: 'My Kampung', trust: tierFor(uid), myToys, myRequests, givenNeedingFeedback, active, RULES });
});

// ---------- Neighbour profiles (same area only) ----------

router.get('/neighbours/:id', (req, res, next) => {
  const n = db.prepare(`SELECT id, display_name, planning_area, created_at, verified_at, suspended_at FROM users WHERE id = ?`)
    .get(Number(req.params.id) || 0);
  if (!n || n.planning_area !== req.user.planning_area || !n.verified_at) {
    return next(Object.assign(new Error("That neighbour isn't in your area."), { status: 404 }));
  }
  const trust = tierFor(n.id);
  const listings = db.prepare(`SELECT t.id, t.title, t.age_range,
      (SELECT id FROM toy_photos p WHERE p.toy_id = t.id ORDER BY position LIMIT 1) AS photo_id
    FROM toys t WHERE t.giver_id = ? AND t.status = 'available' AND t.hidden_at IS NULL ORDER BY t.created_at DESC`).all(n.id);
  const reviews = db.prepare(`SELECT f.rating, f.comment, f.created_at, u.display_name AS from_name
    FROM feedback f JOIN users u ON u.id = f.from_id WHERE f.to_id = ? ORDER BY f.created_at DESC LIMIT 10`).all(n.id);
  const reported = !!db.prepare('SELECT 1 FROM reports WHERE reporter_id = ? AND user_id = ?').get(req.user.id, n.id);
  res.render('neighbour', { title: n.display_name, n, trust, listings, reviews, REPORT_REASONS, reported });
});

router.get('/tiers', (req, res) => {
  res.render('tiers', { title: 'Kampung tiers', TIERS, METRICS, trust: tierFor(req.user.id), RULES });
});

module.exports = router;
