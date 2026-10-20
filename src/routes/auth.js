const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { db } = require('../db');
const { lookupArea } = require('../areas');
const { RULES } = require('../rules');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', BCRYPT_COST);
const SHOW_DEV_OTP = process.env.NODE_ENV !== 'production';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('error', { title: 'Slow down', status: 429,
    message: 'Too many attempts. Please wait a few minutes and try again.' }),
});

const signupSchema = z.object({
  display_name: z.string().trim().min(2, 'Name must be at least 2 characters').max(40, 'Name is too long')
    .regex(/^[\p{L}\p{M}0-9 .'-]+$/u, 'Name can only use letters, numbers, spaces and . \' -'),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(120),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128, 'Password is too long'),
  postal_code: z.string().trim().regex(/^\d{6}$/, 'Postal code must be 6 digits'),
  address_line: z.string().trim().min(4, 'Enter your block and street').max(120, 'Address is too long'),
  guidelines: z.literal('on', { errorMap: () => ({ message: 'Please agree to the kampung guidelines' }) }),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(1).max(128),
});

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Generates a one-time code, stores its hash and returns the plain code. */
function issueOtp(userId) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(`UPDATE users SET otp_hash = ?, otp_expires_at = datetime('now', ?), otp_attempts = 0 WHERE id = ?`)
    .run(hashOtp(code), `+${RULES.OTP_TTL_MINUTES} minutes`, userId);
  // STUB: in production this goes out by SMS or a letter to the address on file.
  console.log(`[otp] verification code for user ${userId}: ${code}`);
  return code;
}

function firstErrors(zodError) {
  const errors = {};
  for (const issue of zodError.issues) {
    const key = issue.path[0] || 'form';
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/toys');
  res.render('signup', { title: 'Join the kampung', values: {}, errors: {} });
});

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    const values = { ...req.body, password: '' };
    if (!parsed.success) {
      return res.status(400).render('signup', { title: 'Join the kampung', values, errors: firstErrors(parsed.error) });
    }
    const data = parsed.data;
    const area = lookupArea(data.postal_code);
    if (!area) {
      return res.status(400).render('signup', { title: 'Join the kampung', values,
        errors: { postal_code: "We couldn't match that postal code to a Singapore planning area." } });
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email);
    if (exists) {
      return res.status(400).render('signup', { title: 'Join the kampung', values,
        errors: { email: 'That email already has an account. Try logging in.' } });
    }
    const hash = await bcrypt.hash(data.password, BCRYPT_COST);
    const { lastInsertRowid } = db.prepare(`INSERT INTO users
      (email, password_hash, display_name, postal_code, address_line, planning_area)
      VALUES (?, ?, ?, ?, ?, ?)`).run(data.email, hash, data.display_name, data.postal_code, data.address_line, area);
    const userId = Number(lastInsertRowid);
    const code = issueOtp(userId);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = userId;
      if (SHOW_DEV_OTP) req.session.devOtp = code;
      flash(req, 'success', `Welcome! Your postal code puts you in ${area}. One last step: confirm your code.`);
      res.redirect('/verify');
    });
  } catch (err) { next(err); }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/toys');
  res.render('login', { title: 'Welcome back', values: {}, error: null });
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    const fail = () => res.status(401).render('login', { title: 'Welcome back',
      values: { email: req.body.email || '' }, error: 'That email and password combination did not match.' });
    if (!parsed.success) return fail();
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(parsed.data.email);
    // Always run bcrypt so response time doesn't reveal whether the email exists.
    const ok = await bcrypt.compare(parsed.data.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return fail();
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.redirect('/toys');
    });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('kt.sid');
    res.redirect('/');
  });
});

router.get('/verify', requireLogin, (req, res) => {
  if (req.user.verified_at) return res.redirect('/toys');
  res.render('verify', { title: 'Verify your neighbourhood', error: null, devOtp: req.session.devOtp || null });
});

router.post('/verify', requireLogin, authLimiter, (req, res) => {
  if (req.user.verified_at) return res.redirect('/toys');
  const code = String(req.body.code || '').trim();
  const row = db.prepare(`SELECT otp_hash, otp_attempts, otp_expires_at > datetime('now') AS fresh
    FROM users WHERE id = ?`).get(req.user.id);
  const render = (error) => res.status(400).render('verify', { title: 'Verify your neighbourhood', error,
    devOtp: req.session.devOtp || null });

  if (!row.otp_hash || !row.fresh) return render('That code has expired. Send yourself a new one below.');
  if (row.otp_attempts >= RULES.OTP_MAX_ATTEMPTS) return render('Too many wrong tries. Send yourself a new code below.');
  const match = /^\d{6}$/.test(code) &&
    crypto.timingSafeEqual(Buffer.from(hashOtp(code)), Buffer.from(row.otp_hash));
  if (!match) {
    db.prepare('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = ?').run(req.user.id);
    return render('That code did not match. Please check and try again.');
  }
  db.prepare(`UPDATE users SET verified_at = datetime('now'), otp_hash = NULL, otp_expires_at = NULL,
    otp_attempts = 0 WHERE id = ?`).run(req.user.id);
  delete req.session.devOtp;
  flash(req, 'success', `You're verified! Here are the blessings waiting in ${req.user.planning_area}.`);
  res.redirect('/toys');
});

router.post('/verify/resend', requireLogin, authLimiter, (req, res) => {
  if (req.user.verified_at) return res.redirect('/toys');
  const code = issueOtp(req.user.id);
  if (SHOW_DEV_OTP) req.session.devOtp = code;
  flash(req, 'info', 'A fresh code is on its way.');
  res.redirect('/verify');
});

module.exports = router;
