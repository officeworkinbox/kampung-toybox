const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const { z } = require('zod');
const { db, tx, UPLOAD_DIR } = require('../db');
const { RULES, CONDITIONS, AGE_RANGES, REPORT_REASONS, canRequest } = require('../rules');
const { tierFor } = require('../tiers');
const { flash, csrfCheck, requireVerified } = require('../middleware');

const router = express.Router();
router.use(requireVerified);

// ---------- helpers ----------

/** Loads a toy only if it is in the viewer's planning area (or is the viewer's own). */
function toyInArea(user, id) {
  const toy = db.prepare(`SELECT t.*, u.display_name AS giver_name, u.email AS giver_email FROM toys t
    JOIN users u ON u.id = t.giver_id WHERE t.id = ?`).get(Number(id) || 0);
  if (!toy) return null;
  if (toy.giver_id === user.id) return toy;
  if (toy.planning_area !== user.planning_area || toy.hidden_at) return null;
  return toy;
}

function notFound(next) {
  const err = new Error("We couldn't find that toy in your neighbourhood.");
  err.status = 404;
  next(err);
}

/** Same-origin path from the Referer header, for redirecting back after a form. */
function safeBack(req) {
  try {
    const url = new URL(req.get('referer') || '', `http://${req.get('host')}`);
    if (url.host === req.get('host')) return url.pathname + url.search;
  } catch { /* fall through */ }
  return '/toys';
}

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Checks the file's leading bytes really match an allowed raster format. */
function sniffImage(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (MIME_EXT[file.mimetype] || '')),
  }),
  limits: { fileSize: RULES.MAX_PHOTO_MB * 1024 * 1024, files: RULES.MAX_PHOTOS, fields: 20 },
  fileFilter: (req, file, cb) => cb(null, Boolean(MIME_EXT[file.mimetype])),
});

function removeFiles(files) {
  for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
}

const toySchema = z.object({
  title: z.string().trim().min(3, 'Give the toy a short name (3+ characters)').max(80, 'Title is too long'),
  description: z.string().trim().min(15, 'Tell families a bit more (15+ characters)').max(1000, 'Description is too long'),
  condition: z.enum(CONDITIONS, { errorMap: () => ({ message: 'Choose a condition' }) }),
  age_range: z.enum(AGE_RANGES, { errorMap: () => ({ message: 'Choose an age range' }) }),
});

const requestSchema = z.object({
  note: z.string().trim()
    .min(RULES.NOTE_MIN, `Please share a little more (at least ${RULES.NOTE_MIN} characters)`)
    .max(RULES.NOTE_MAX, `Please keep it under ${RULES.NOTE_MAX} characters`),
});

// ---------- browse ----------

router.get('/toys', (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim().slice(0, 60),
    age: AGE_RANGES.includes(req.query.age) ? req.query.age : '',
    condition: CONDITIONS.includes(req.query.condition) ? req.query.condition : '',
  };
  const where = [`t.planning_area = :area`, `t.status = 'available'`, `t.hidden_at IS NULL`];
  const params = { area: req.user.planning_area };
  if (filters.q) { where.push(`(t.title LIKE :q OR t.description LIKE :q)`); params.q = `%${filters.q}%`; }
  if (filters.age) { where.push('t.age_range = :age'); params.age = filters.age; }
  if (filters.condition) { where.push('t.condition = :cond'); params.cond = filters.condition; }
  const toys = db.prepare(`SELECT t.*, u.display_name AS giver_name,
      (SELECT id FROM toy_photos p WHERE p.toy_id = t.id ORDER BY position LIMIT 1) AS photo_id,
      (SELECT COUNT(*) FROM requests r WHERE r.toy_id = t.id AND r.status = 'pending') AS pending
    FROM toys t JOIN users u ON u.id = t.giver_id
    WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT 60`).all(params);
  for (const t of toys) t.giverTier = tierFor(t.giver_id).tier;
  const neighbours = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE planning_area = ? AND verified_at IS NOT NULL`)
    .get(req.user.planning_area).n;
  res.render('toys', { title: `Blessings in ${req.user.planning_area}`, toys, filters, CONDITIONS, AGE_RANGES, neighbours });
});

router.get('/toys/new', (req, res) => {
  res.render('toy-new', { title: 'Share a blessing', values: {}, errors: {}, CONDITIONS, AGE_RANGES, RULES });
});

router.post('/toys', upload.array('photos', RULES.MAX_PHOTOS), (req, res, next) => {
  // Multipart bodies are parsed by multer, so CSRF is checked here rather than globally.
  csrfCheck(req, res, (err) => {
    if (err) { removeFiles(req.files); return next(err); }
    const files = req.files || [];
    const parsed = toySchema.safeParse(req.body);
    const errors = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path[0]] ??= i.message;
    const photos = [];
    for (const f of files) {
      const mime = sniffImage(f.path);
      if (mime) photos.push({ ...f, mime }); else errors.photos = 'Photos must be JPG, PNG, WEBP or GIF images.';
    }
    if (!photos.length && !errors.photos) errors.photos = 'Add at least one photo so families can see the toy.';
    if (Object.keys(errors).length) {
      removeFiles(files);
      return res.status(400).render('toy-new', { title: 'Share a blessing', values: req.body, errors, CONDITIONS, AGE_RANGES, RULES });
    }
    const d = parsed.data;
    const toyId = tx(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO toys (giver_id, planning_area, title, description, condition, age_range)
        VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, req.user.planning_area, d.title, d.description, d.condition, d.age_range);
      const ins = db.prepare('INSERT INTO toy_photos (toy_id, filename, mime, position) VALUES (?, ?, ?, ?)');
      photos.forEach((p, i) => ins.run(lastInsertRowid, p.filename, p.mime, i));
      return Number(lastInsertRowid);
    });
    flash(req, 'success', `Thank you! "${d.title}" is now visible to families in ${req.user.planning_area}.`);
    res.redirect(`/toys/${toyId}`);
  });
});

// Multer errors (too big, too many files) come back as a friendly form error.
router.use('/toys', (err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  removeFiles(req.files);
  const message = err.code === 'LIMIT_FILE_SIZE' ? `Each photo must be under ${RULES.MAX_PHOTO_MB} MB.`
    : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can add up to ${RULES.MAX_PHOTOS} photos.`
    : 'Upload failed. Please try again.';
  res.status(400).render('toy-new', { title: 'Share a blessing', values: req.body || {}, errors: { photos: message }, CONDITIONS, AGE_RANGES, RULES });
});

router.get('/toys/:id', (req, res, next) => {
  const toy = toyInArea(req.user, req.params.id);
  if (!toy) return notFound(next);
  const photos = db.prepare('SELECT id FROM toy_photos WHERE toy_id = ? ORDER BY position').all(toy.id);
  const giver = tierFor(toy.giver_id);
  const isGiver = toy.giver_id === req.user.id;
  let requests = [];
  if (isGiver) {
    requests = db.prepare(`SELECT r.*, u.display_name, u.email, u.created_at AS member_since FROM requests r
      JOIN users u ON u.id = r.requester_id WHERE r.toy_id = ?
      ORDER BY CASE r.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.created_at`).all(toy.id);
    for (const r of requests) r.trust = tierFor(r.requester_id);
  }
  const mine = isGiver ? null
    : db.prepare('SELECT * FROM requests WHERE toy_id = ? AND requester_id = ?').get(toy.id, req.user.id);
  const eligibility = isGiver || mine ? null : canRequest(req.user, toy);
  const reported = !!db.prepare('SELECT 1 FROM reports WHERE reporter_id = ? AND toy_id = ?').get(req.user.id, toy.id);
  res.render('toy', { title: toy.title, toy, photos, giver, isGiver, requests, mine, eligibility,
    RULES, REPORT_REASONS, reported, noteValue: '', noteError: null });
});

router.post('/toys/:id/request', (req, res, next) => {
  const toy = toyInArea(req.user, req.params.id);
  if (!toy) return notFound(next);
  const gate = canRequest(req.user, toy);
  if (!gate.ok) { flash(req, 'warn', gate.reason); return res.redirect(`/toys/${toy.id}`); }
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    const photos = db.prepare('SELECT id FROM toy_photos WHERE toy_id = ? ORDER BY position').all(toy.id);
    return res.status(400).render('toy', { title: toy.title, toy, photos, giver: tierFor(toy.giver_id), isGiver: false,
      requests: [], mine: null, eligibility: gate, RULES, REPORT_REASONS, reported: false,
      noteValue: req.body.note || '', noteError: parsed.error.issues[0].message });
  }
  db.prepare('INSERT INTO requests (toy_id, requester_id, note) VALUES (?, ?, ?)').run(toy.id, req.user.id, parsed.data.note);
  flash(req, 'success', `Request sent to ${toy.giver_name}. You'll see their reply on My Kampung.`);
  res.redirect(`/toys/${toy.id}`);
});

router.post('/toys/:id/withdraw', (req, res, next) => {
  const toy = toyInArea(req.user, req.params.id);
  if (!toy || toy.giver_id !== req.user.id) return notFound(next);
  if (toy.status !== 'available') {
    flash(req, 'warn', 'Release or finish the approved handover before withdrawing this toy.');
    return res.redirect(`/toys/${toy.id}`);
  }
  tx(() => {
    db.prepare(`UPDATE toys SET status = 'withdrawn' WHERE id = ?`).run(toy.id);
    db.prepare(`UPDATE requests SET status = 'declined', decided_at = datetime('now') WHERE toy_id = ? AND status = 'pending'`).run(toy.id);
  });
  flash(req, 'info', `"${toy.title}" has been withdrawn.`);
  res.redirect('/me');
});

// ---------- photos (area-checked, never served statically) ----------

router.get('/photos/:id', (req, res, next) => {
  const photo = db.prepare(`SELECT p.filename, p.mime, t.id AS toy_id FROM toy_photos p JOIN toys t ON t.id = p.toy_id
    WHERE p.id = ?`).get(Number(req.params.id) || 0);
  if (!photo || !toyInArea(req.user, photo.toy_id)) return res.sendStatus(404);
  const file = path.join(UPLOAD_DIR, path.basename(photo.filename));
  res.set({
    'Content-Type': photo.mime,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

// ---------- reporting ----------

router.post('/report', (req, res, next) => {
  const schema = z.object({
    toy_id: z.coerce.number().int().positive().optional(),
    user_id: z.coerce.number().int().positive().optional(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(500).default(''),
  }).refine((v) => !!v.toy_id !== !!v.user_id);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { flash(req, 'warn', 'Please choose a reason for the report.'); return res.redirect(safeBack(req)); }
  const { toy_id, user_id, reason, details } = parsed.data;

  if (toy_id) {
    const toy = toyInArea(req.user, toy_id);
    if (!toy || toy.giver_id === req.user.id) return notFound(next);
    db.prepare('INSERT OR IGNORE INTO reports (reporter_id, toy_id, reason, details) VALUES (?, ?, ?, ?)')
      .run(req.user.id, toy.id, reason, details);
    const n = db.prepare('SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE toy_id = ?').get(toy.id).n;
    if (n >= RULES.REPORTS_TO_HIDE_TOY) {
      tx(() => {
        db.prepare(`UPDATE toys SET hidden_at = datetime('now') WHERE id = ? AND hidden_at IS NULL`).run(toy.id);
        db.prepare(`UPDATE requests SET status = 'declined', decided_at = datetime('now') WHERE toy_id = ? AND status = 'pending'`).run(toy.id);
      });
    }
    flash(req, 'info', 'Thanks for looking out for the kampung. Our community team will take a look.');
    return res.redirect(n >= RULES.REPORTS_TO_HIDE_TOY ? '/toys' : `/toys/${toy.id}`);
  }

  const target = db.prepare('SELECT id, planning_area FROM users WHERE id = ?').get(user_id);
  if (!target || target.id === req.user.id || target.planning_area !== req.user.planning_area) return notFound(next);
  db.prepare('INSERT OR IGNORE INTO reports (reporter_id, user_id, reason, details) VALUES (?, ?, ?, ?)')
    .run(req.user.id, target.id, reason, details);
  const n = db.prepare('SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE user_id = ?').get(target.id).n;
  if (n >= RULES.REPORTS_TO_SUSPEND_USER) {
    db.prepare(`UPDATE users SET suspended_at = datetime('now') WHERE id = ? AND suspended_at IS NULL`).run(target.id);
  }
  flash(req, 'info', 'Thanks for letting us know. Our community team will review this neighbour.');
  res.redirect(`/neighbours/${target.id}`);
});

module.exports = router;
