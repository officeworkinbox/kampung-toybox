const crypto = require('node:crypto');
const { db } = require('./db');
const { tierFor } = require('./tiers');

const userStmt = db.prepare(`SELECT id, email, display_name, postal_code, address_line, planning_area,
  verified_at, suspended_at, created_at FROM users WHERE id = ?`);

/** Loads req.user from the session and exposes common locals to views. */
function loadUser(req, res, next) {
  const id = req.session.userId;
  req.user = id ? userStmt.get(id) || null : null;
  if (id && !req.user) delete req.session.userId;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.myTier = req.user && req.user.verified_at ? tierFor(req.user.id) : null;
  res.locals.path = req.path;
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

/** Synchronizer-token CSRF check for every state-changing request. */
function csrfCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  const ok = sent.length === expected.length && expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) {
    const err = new Error('Your form expired. Please go back, refresh the page and try again.');
    err.status = 403;
    return next(err);
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    flash(req, 'info', 'Please log in first.');
    return res.redirect('/login');
  }
  next();
}

/** Logged in AND neighbourhood verified AND not suspended. */
function requireVerified(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (!req.user.verified_at) return res.redirect('/verify');
  if (req.user.suspended_at) {
    const err = new Error('Your account is paused while the community team reviews some reports. Please contact support.');
    err.status = 403;
    return next(err);
  }
  next();
}

module.exports = { loadUser, flash, csrfCheck, requireLogin, requireVerified };
