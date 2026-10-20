const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { db, DATA_DIR } = require('./db');
const SqliteStore = require('./session-store');
const { loadUser, csrfCheck } = require('./middleware');
const { TIERS } = require('./tiers');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';

// Session secret: from the environment, or generated once and kept in data/.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

// First run: load the demo neighbourhood so there's something to look at.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get() && process.env.SEED_DEMO !== 'false') {
  require('../scripts/seed').seed({ quiet: false });
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'"],
      // Only style="" attributes (progress bar widths) may be inline; no inline <style> or scripts.
      styleSrcAttr: ["'unsafe-inline'"],
      scriptSrc: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
}));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(session({
  name: 'kt.sid',
  secret: sessionSecret(),
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(loadUser);
// Multipart (photo upload) requests are CSRF-checked inside their route, after multer parses them.
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : csrfCheck(req, res, next)));

app.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.verified_at ? '/toys' : '/verify');
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM requests WHERE status = 'completed') AS blessings,
      (SELECT COUNT(DISTINCT planning_area) FROM users WHERE verified_at IS NOT NULL) AS areas,
      (SELECT COUNT(*) FROM toys WHERE status = 'available' AND hidden_at IS NULL) AS available`).get();
  res.render('home', { title: 'Pass on the joy', stats, TIERS });
});

app.use(require('./routes/auth'));
app.use(require('./routes/requests'));
app.use(require('./routes/toys'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', status: 404, message: "We couldn't find that page." });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : 'Oops',
    status,
    message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Kampung Toybox is running at http://localhost:${PORT}`);
});
