// Demo data: two neighbourhoods (Tampines and Ang Mo Kio), a few members at
// different tiers, sample toys with illustrated photos, and a little history.
//
//   npm run seed     -> wipes the database and uploads, then re-creates the demo
//
// The server also calls seed() automatically on first start when the DB is empty.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db, tx, UPLOAD_DIR } = require('../src/db');
const { lookupArea } = require('../src/areas');

const DEMO_PASSWORD = 'kampung-demo-1';

const USERS = [
  // Tampines (postal sector 52)
  { key: 'aisha', name: 'Aisha Rahman', email: 'aisha@demo.sg', postal: '520201', address: 'Blk 201 Tampines St 21' },
  { key: 'ben', name: 'Ben Tan', email: 'ben@demo.sg', postal: '521145', address: 'Blk 145 Tampines Ave 5' },
  { key: 'weiling', name: 'Wei Ling', email: 'weiling@demo.sg', postal: '529510', address: 'Blk 510 Tampines Central 1' },
  { key: 'raj', name: 'Raj Kumar', email: 'raj@demo.sg', postal: '520866', address: 'Blk 866 Tampines St 83' },
  // Ang Mo Kio (postal sector 56)
  { key: 'meihua', name: 'Mei Hua', email: 'meihua@demo.sg', postal: '560406', address: 'Blk 406 Ang Mo Kio Ave 10' },
  { key: 'daniel', name: 'Daniel Lim', email: 'daniel@demo.sg', postal: '560321', address: 'Blk 321 Ang Mo Kio Ave 3' },
];

// [giver, title, description, condition, age, emoji, colour]
const TOYS = [
  ['aisha', 'Wooden train set (30 pieces)', 'Classic wooden railway with a bridge, two engines and 24 tracks. A couple of scratches but everything clicks together. My boys played with it for years!', 'Gently used', '3-5 years', '🚂', '#ffd9b3'],
  ['aisha', 'Baby activity gym', 'Soft play mat with hanging toys, mirror and crinkle leaves. Washed and sun-dried.', 'Like new', '0-12 months', '🧸', '#d8ecff'],
  ['aisha', 'Picture books bundle (12 books)', 'Mix of English and Chinese picture books: Very Hungry Caterpillar, Guess How Much I Love You and more.', 'Well loved', '1-2 years', '📚', '#fde2e4'],
  ['ben', 'LEGO Classic creative box', 'About 500 bricks with windows and wheels, in the original box. Counted, a few pieces may be missing.', 'Gently used', '6-8 years', '🧱', '#fff1b8'],
  ['ben', 'Kids scooter (3 wheels)', 'Light-up wheels, adjustable handle. Brake works well. Pick up from void deck.', 'Gently used', '3-5 years', '🛴', '#d4f5e2'],
  ['raj', 'Dinosaur figure collection', 'Ten rubbery dinosaurs including T-Rex and Triceratops. Great for bath time too.', 'Well loved', '3-5 years', '🦖', '#e6f6d5'],
  ['meihua', 'Kitchen play set', 'Pretend kitchen with pots, pans and play food. Some stickers peeling.', 'Gently used', '3-5 years', '🍳', '#ffe4cc'],
  ['meihua', '100-piece jigsaw puzzle', 'Singapore skyline puzzle, all pieces present (we counted twice!).', 'Like new', '6-8 years', '🧩', '#e3e1ff'],
  ['daniel', 'Remote control car', 'Needs 4 AA batteries. Steering is a little loose but it still zooms.', 'Needs a little fixing', '6-8 years', '🏎️', '#ffd6d6'],
];

// Past handovers that give the demo members a history (completed 1-4 months ago).
// [giver, receiver, title, emoji, colour, daysAgo, ratingForGiver, ratingForReceiver, comment]
const HISTORY = [
  ['aisha', 'weiling', 'Stacking rings', '🍩', '#ffe8d1', 120, 5, 5, 'So thoughtful, even washed everything!'],
  ['aisha', 'ben', 'Toy xylophone', '🎶', '#e0f0ff', 95, 5, 5, 'Lovely neighbour, thank you Aisha.'],
  ['aisha', 'raj', 'Bath boats', '⛵', '#d9f2ff', 70, 4, 5, 'Smooth pickup at the void deck.'],
  ['ben', 'aisha', 'Shape sorter', '🔷', '#f0e6ff', 60, 5, 5, 'Ben was right on time.'],
  ['meihua', 'daniel', 'Magnetic drawing board', '🖍️', '#fff3c4', 45, 5, 5, 'My girl loves it, thank you!'],
];

// Open requests so givers have something to review.
// [requester, toyTitle, note]
const PENDING = [
  ['weiling', 'Wooden train set (30 pieces)', 'My son Ethan just turned 4 and is obsessed with trains. We are at Blk 510, happy to collect any weekday evening.'],
  ['daniel', 'Kitchen play set', 'My daughter loves helping me cook. She would be so happy to have her own kitchen. Can collect this Saturday.'],
];

function toySvg(emoji, colour, title) {
  const safe = title.replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <rect width="800" height="600" fill="${colour}"/>
  <circle cx="660" cy="110" r="140" fill="#ffffff" opacity=".35"/>
  <circle cx="110" cy="520" r="170" fill="#ffffff" opacity=".25"/>
  <text x="400" y="330" font-size="230" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
  <text x="400" y="545" font-size="34" font-family="Segoe UI, sans-serif" font-weight="700" fill="#2d2a26" opacity=".7" text-anchor="middle">${safe}</text>
</svg>`;
}

function writePhoto(toyId, emoji, colour, title) {
  const filename = `seed-${crypto.randomBytes(8).toString('hex')}.svg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), toySvg(emoji, colour, title));
  db.prepare(`INSERT INTO toy_photos (toy_id, filename, mime, position) VALUES (?, ?, 'image/svg+xml', 0)`).run(toyId, filename);
}

function reset() {
  db.exec(`DELETE FROM feedback; DELETE FROM reports; DELETE FROM requests; DELETE FROM toy_photos;
           DELETE FROM toys; DELETE FROM sessions; DELETE FROM users;`);
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
}

function seed({ quiet = false } = {}) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 12);
  const ids = {};
  tx(() => {
    for (const u of USERS) {
      const area = lookupArea(u.postal);
      const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, password_hash, display_name, postal_code,
        address_line, planning_area, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-150 days'), datetime('now', '-150 days'))`)
        .run(u.email, hash, u.name, u.postal, u.address, area);
      ids[u.key] = Number(lastInsertRowid);
    }
    const area = (key) => lookupArea(USERS.find((u) => u.key === key).postal);

    for (const [giver, receiver, title, emoji, colour, days, rGiver, rReceiver, comment] of HISTORY) {
      const ago = `-${days} days`;
      const toyId = Number(db.prepare(`INSERT INTO toys (giver_id, planning_area, title, description, condition, age_range, status, created_at)
        VALUES (?, ?, ?, ?, 'Gently used', '1-2 years', 'given', datetime('now', ?, '-7 days'))`)
        .run(ids[giver], area(giver), title, `${title}, passed on with love.`, ago).lastInsertRowid);
      writePhoto(toyId, emoji, colour, title);
      const reqId = Number(db.prepare(`INSERT INTO requests (toy_id, requester_id, note, status, handover_code, decided_at, completed_at, created_at)
        VALUES (?, ?, 'We would love this for our little one, thank you!', 'completed', '000000', datetime('now', ?, '-3 days'), datetime('now', ?), datetime('now', ?, '-5 days'))`)
        .run(toyId, ids[receiver], ago, ago, ago).lastInsertRowid);
      db.prepare(`INSERT INTO feedback (request_id, from_id, to_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
        .run(reqId, ids[receiver], ids[giver], rGiver, comment, ago);
      db.prepare(`INSERT INTO feedback (request_id, from_id, to_id, rating, comment, created_at) VALUES (?, ?, ?, ?, 'Friendly and on time.', datetime('now', ?))`)
        .run(reqId, ids[giver], ids[receiver], rReceiver, ago);
    }

    const toyIds = {};
    TOYS.forEach(([giver, title, description, condition, age, emoji, colour], i) => {
      const toyId = Number(db.prepare(`INSERT INTO toys (giver_id, planning_area, title, description, condition, age_range, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`)
        .run(ids[giver], area(giver), title, description, condition, age, `-${TOYS.length - i} hours`).lastInsertRowid);
      writePhoto(toyId, emoji, colour, title);
      toyIds[title] = toyId;
    });

    for (const [requester, title, note] of PENDING) {
      db.prepare(`INSERT INTO requests (toy_id, requester_id, note) VALUES (?, ?, ?)`).run(toyIds[title], ids[requester], note);
    }
  });

  if (!quiet) {
    console.log('Seeded demo neighbourhoods. Every demo account uses the password:', DEMO_PASSWORD);
    for (const u of USERS) console.log(`  ${u.email.padEnd(18)} ${lookupArea(u.postal)}`);
  }
}

module.exports = { seed, reset, DEMO_PASSWORD };

if (require.main === module) {
  reset();
  seed();
}
