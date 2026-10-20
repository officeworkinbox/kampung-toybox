# 🧸 Kampung Toybox

*Pass on the joy, neighbour to neighbour.*

Kampung Toybox lets neighbours in Singapore give away pre-loved toys as **blessings** to families nearby. Each member belongs to one URA planning area, set from their postal code when they sign up. They only ever see, request and give toys inside that area, and the server enforces this on every request.

> **Why "Kampung Toybox"?** *Kampung* is the village spirit Singaporeans still talk about: neighbours who look out for each other. Other names considered: **BlessBox**, **Toy Tumbuh** ("grow"), **HandMeJoy**, **Void Deck Toys**.

---

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is nothing native to compile and no database server to run).

```bash
npm install
npm start
```

Open http://localhost:3000. The first start creates `data/toybox.db` and loads the demo neighbourhoods automatically.

| Command | What it does |
|---|---|
| `npm start` | Starts the app on port 3000 (`PORT=4000 npm start` to change). Seeds demo data if the DB is empty. |
| `npm run seed` | **Wipes** the database and uploads, then re-creates the demo data. |

### Demo accounts

Every demo account uses the password **`kampung-demo-1`**.

| Email | Area | Tier | Notes |
|---|---|---|---|
| `aisha@demo.sg` | Tampines | 🌼 Kind Neighbour | 3 toys given; has a pending request from Wei Ling on the train set |
| `ben@demo.sg` | Tampines | 🌿 Sprout | Gave 1, received 1 |
| `weiling@demo.sg` | Tampines | 🌱 Seedling | Received 1, waiting on the train set |
| `raj@demo.sg` | Tampines | 🌱 Seedling | One giveaway away from Sprout |
| `meihua@demo.sg` | Ang Mo Kio | 🌿 Sprout | Has a pending request from Daniel |
| `daniel@demo.sg` | Ang Mo Kio | 🌱 Seedling | |

Log in as a Tampines member and an Ang Mo Kio member to see that each area only shows its own toys.

### Signing up a new account

Use any Singapore postal code, for example `520300` (Tampines), `560406` (Ang Mo Kio) or `730888` (Woodlands). The one-time verification code is **stubbed**. Outside production (`NODE_ENV` is not `production`) it is shown on the verify page and printed to the server console.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | (unset) | `production` turns on secure cookies, `trust proxy` and HTTPS upgrade, and hides the dev OTP |
| `SESSION_SECRET` | auto-generated into `data/.session-secret` | Cookie signing secret |
| `DATA_DIR` | `./data` | Where the SQLite DB and uploaded photos live |
| `SEED_DEMO` | `true` | Set to `false` to start with an empty database |

---

## How it works

1. **Sign up** with name, email, password, postal code and block/street. The postal code is mapped to a planning area.
2. **Verify** with a 6-digit one-time code (stubbed; see below). Until then you can't see or request any toys.
3. **Share** a toy: title, description, condition, age range and 1 to 4 photos.
4. **Request** a toy in your area with a short note saying who it's for.
5. The **giver reviews** requests, along with each requester's tier, handovers, rating, no-shows and account age, then approves one family. The toy becomes *reserved*, other pending requests are declined, and the two sides see each other's email so they can arrange a meet-up.
6. The approved requester sees a **6-digit handover code**. At the meet-up the giver types that code in to **confirm the handover**. The toy becomes *given*.
7. Both sides leave **1 to 5★ feedback**, which feeds reputation and tiers.

## Area lock (server-enforced)

- `src/areas.js` maps the first two digits of a postal code (the **postal sector**) to the planning area where most of its addresses fall. Unknown sectors are rejected at sign-up.
- A member's `planning_area` is fixed at sign-up and stored on the user row. Every toy copies its giver's area when it's created.
- Every query and action checks the area on the server:
  - The feed and search only query `toys.planning_area = <your area>`.
  - Toy pages, **photos** (served through `/photos/:id`, never as static files), requests, reports and neighbour profiles return **404** when the area doesn't match.
  - Request actions (approve, decline, cancel, complete, feedback) check that you are a party to the request and in the same area.
- Tested in the browser: a Tampines member gets 404 for an Ang Mo Kio toy page, its photo, a request POST to it, a report about it, and an Ang Mo Kio member's profile. Searching for the toy's name doesn't leak it either.

*Limitation:* the sector table is an approximation, because a few sectors straddle planning-area boundaries. In production, replace `lookupArea()` with the OneMap API (postal code → coordinates → planning-area polygon).

---

## Checking that requests are genuine

No single check stops bad actors, so several light checks are layered together. Each one has a cost, and the aim was to keep the app easy to use for genuine families.

| # | Check | How it works here | Trade-offs |
|---|---|---|---|
| 1 | **Verified neighbourhood** | Postal code → planning area at sign-up, plus a one-time code "sent to your address". Unverified accounts can't see or request toys. **Stubbed:** the code is generated, hashed (SHA-256), expires after 10 minutes and allows 5 attempts, but it's shown on screen instead of being sent. | Real address proof needs a paid channel: a posted letter (slow, cheap, strong), SMS (fast but only proves a phone number) or Singpass/MyInfo (strongest, but needs a government integration). A postal code alone can be faked, so until a real channel is wired up this only proves intent. |
| 2 | **A note on why they're asking** | Required, 20 to 500 characters, shown to the giver. | Adds friction, which is the point. It's hard to verify, but it gives givers a human signal and puts off bulk requesters. Some genuine families may find writing a note awkward. |
| 3 | **Limit on open requests** | Pending plus approved requests are capped by tier: 2 for Seedlings, rising to 5. | Stops "request everything" behaviour. A brand-new family with real needs has to wait for replies. |
| 4 | **Anti-hoarding window** | At most 4 toys *received* per rolling 30 days, whatever the tier. | Slows down resellers. A large family might hit it. Easy to tune in `src/rules.js`. |
| 5 | **Giver approves each request** | Nothing is handed out automatically. The giver sees the note, tier, handovers, average rating, no-show count and account age before choosing. | Puts the judgement with the person who knows the toy. Adds a step for givers, and an unpopular requester may wait. |
| 6 | **Reputation from completed handovers** | Feedback can only be left after a confirmed handover, once per side. *Kudos* count **distinct** neighbours, so one friend can't inflate your score. | Newcomers start with no reputation, so trust takes time to build. Two colluding accounts could still trade feedback once (see below). |
| 7 | **No-show tracking** | A giver can mark an approved requester as a no-show. Two no-shows in 60 days pauses new requests. "Plans changed, release" is available for blameless cancellations. | Gives givers a lever that could be misused. It's visible to future givers rather than banning anyone outright. |
| 8 | **Reporting and flagging** | Report a listing or a member with a reason. When **3 distinct neighbours** report a listing it's hidden and its pending requests are declined. 3 distinct reporters on a member **pauses** the account. One report per person per target. | Community moderation is fast and cheap, but a group could brigade someone. Real deployments need a moderator queue to review and reverse these. That's out of scope here; the threshold is in `src/rules.js`. |
| 9 | **Handover confirmation code** | The approved requester gets a random 6-digit code. The giver must enter it to mark the toy as given. Only completed handovers count towards tiers and feedback. | Proves the two parties were in touch, not that the toy changed hands. It stops a giver from claiming handovers on their own. Two colluding accounts can still fake one. |

**What this doesn't stop:** one person running two accounts in the same area and trading toys between them to farm tiers. Mitigations, in order of cost: tie verification to a real channel (letter, SMS or Singpass) so each account costs effort; count kudos from distinct neighbours (done); have moderators review tier jumps for tiers with real perks. Tiers here only unlock a slightly higher request limit, so there's little reason to cheat.

### Other security measures

- Passwords hashed with **bcrypt** (cost 12, via `bcryptjs`). Login always runs a bcrypt compare, even for unknown emails, so response timing doesn't reveal which emails exist. Logins, sign-ups and OTP attempts are rate-limited.
- **Sessions** are stored in SQLite. Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` in production, the session is regenerated on login and sign-up, and it expires after 7 days of rolling inactivity.
- **CSRF** synchronizer token on every POST. For photo uploads it's checked after multer parses the form, and the uploaded files are deleted if the check fails.
- **Input validation** with `zod` on every form. Condition, age range and report reason are allow-listed.
- **Uploads:** at most 4 files of 5 MB each, random filenames, MIME allow-list **plus a magic-byte check** (JPEG, PNG, WEBP or GIF). Rejected files are deleted. Photos are served with `nosniff` and a sandboxing CSP.
- **Helmet** CSP: scripts and styles come only from this site; no inline scripts.

---

## Membership tiers

Tiers are **earned, never bought**, and are recalculated live from completed activity (`src/tiers.js`).

| Tier | Toys given | Completed handovers | Kudos | Rating | Open requests allowed |
|---|---|---|---|---|---|
| 🌱 **Seedling** | 0 | 0 | 0 | — | 2 |
| 🌿 **Sprout** | 1 | 1 | 0 | — | 3 |
| 🌼 **Kind Neighbour** | 3 | 4 | 2 | ≥ 4.0★ | 3 |
| 🌳 **Kampung Hero** | 8 | 10 | 6 | ≥ 4.0★ | 4 |
| 🌟 **Blessing Keeper** | 20 | 25 | 15 | ≥ 4.0★ | 5 |

- **Toys given:** handovers you confirmed as the giver.
- **Completed handovers:** confirmed handovers in either role, so being a reliable recipient counts too.
- **Kudos:** the number of *different* neighbours who rated you 4★ or 5★.
- **Rating:** from Kind Neighbour up, your average must be at least 4.0★ once you have 3 or more reviews. A badge can't be bought with volume alone.

Badges appear in the header, on toy cards, on toy pages, in the giver's request review and on profiles. **My Kampung** and **/tiers** show a progress bar for each requirement of the next tier. When a confirmed handover takes you up a tier, you get a "You've grown into a …!" message.

---

## Project layout

```
src/
  server.js          Express app, security middleware, routing
  db.js              node:sqlite connection and schema
  session-store.js   express-session store backed by SQLite
  areas.js           postal sector → planning area
  rules.js           community limits and request eligibility (canRequest)
  tiers.js           tier definitions, stats and progress
  middleware.js      current user, CSRF, auth guards, flash messages
  routes/auth.js     sign-up, login, logout, OTP verification
  routes/toys.js     feed, upload, toy page, request, withdraw, photos, reports
  routes/requests.js approve / decline / cancel / release / complete / feedback, My Kampung, profiles, tiers
views/               EJS templates
public/              CSS and a small progressive-enhancement script
scripts/seed.js      demo data
data/                SQLite DB, uploaded photos, session secret (git-ignored)
```

## Tested end to end in the browser

- Sign-up: validation errors (short password, missing guideline consent), a postal code with no matching area rejected, and a valid Tampines postal code accepted.
- OTP: a wrong code rejected, the correct code verifies. Unverified users are redirected away from toys and photos.
- Login: a wrong password gives a generic error, and the correct password works.
- Upload: a fake `.png` (text content) rejected by the magic-byte check and deleted from disk. A real PNG uploaded and shown.
- Request: a note that's too short rejected. Two valid requests sent. A third blocked by the Seedling limit (2). Requesting your own toy blocked.
- Area lock: 404 for an Ang Mo Kio toy, photo, request, report and profile when logged in as a Tampines member. No leak through search.
- CSRF: a POST without the token gets 403.
- Approval: approving one request reserves the toy and auto-declines the competing request.
- Handover: a wrong code rejected. The requester's code (read from the requester's own page) completes the handover, and the toy is marked given.
- Feedback left on both sides.
- Tier progression: a new member goes from 🌱 Seedling to 🌿 Sprout after confirming their first giveaway. The progress bars, header badge and request limit (2 → 3) all update.
- Reporting a toy in your own area works.
- Mobile layout at 375 px with no horizontal scroll.

## Not built yet (future work)

- A real OTP channel (posted letter, SMS or Singpass/MyInfo) and the OneMap API for exact planning areas.
- A moderator dashboard to review reports and un-hide or un-pause accounts.
- Changing address (moving house), with re-verification and cancellation of open requests.
- In-app messaging to arrange handovers. Today, once a request is approved, each side sees the other's email, and only then.
- Email notifications.
