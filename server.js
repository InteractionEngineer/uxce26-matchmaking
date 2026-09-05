const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { loadBoard, eventConfig } = require('./lib/board');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENT = process.env.EVENT || null; // null → default from events/index.json

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'uxcamp.db'));
db.pragma('journal_mode = WAL');

// Migrate old schema (name-keyed) to token-keyed if needed
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (cols.length > 0 && !cols.includes('token')) {
  console.log('  Migrating schema to token-based identity…');
  db.exec('DROP TABLE users');
}

db.exec(`CREATE TABLE IF NOT EXISTS users (
  token      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  linkedin   TEXT NOT NULL DEFAULT '',
  sessions   TEXT NOT NULL DEFAULT '[]',
  event      TEXT NOT NULL DEFAULT 'uxce26',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Rows from before multi-event support all belong to the first event
if (cols.length > 0 && cols.includes('token') && !cols.includes('event')) {
  console.log('  Adding event column to users…');
  db.exec(`ALTER TABLE users ADD COLUMN event TEXT NOT NULL DEFAULT 'uxce26'`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_event ON users(event)');

const BOARD = loadBoard(EVENT);
const CONFIG = eventConfig(EVENT);
const EVENT_ID = CONFIG.id;

app.use(express.json());

// ── HTML templating ────────────────────────────────────────────────────────
// Placeholders in the static pages are filled per request: the [LEGAL_*] ones
// from env vars, the event ones from events/index.json. Placeholders without a
// value stay visible as-is.
function renderHtml(file, res) {
  let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const subs = {
    '[First name Last name]': process.env.LEGAL_NAME,
    '[Street and house number]': process.env.LEGAL_STREET,
    '[Postal code City]': process.env.LEGAL_CITY,
    '[Country]': process.env.LEGAL_COUNTRY,
    '[contact@example.com]': process.env.LEGAL_EMAIL,
    '[App name]': CONFIG.name,
    '[Event name]': CONFIG.legal?.eventName,
    '[Last updated]': CONFIG.legal?.lastUpdated,
  };
  for (const [placeholder, value] of Object.entries(subs)) {
    if (value) {
      html = html.split(`<span class="placeholder">${placeholder}</span>`).join(value);
      html = html.split(placeholder).join(value);
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get(['/', '/index.html'], (_req, res) => renderHtml('index.html', res));
app.get('/legal.html', (_req, res) => renderHtml('legal.html', res));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', (_req, res) => res.json(BOARD));

// Load by token (exact match — used on return visit via localStorage)
app.get('/api/users/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE token = ? AND event = ?').get(req.params.token, EVENT_ID);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, sessions: JSON.parse(row.sessions) });
});

// Search by name (case-insensitive — used for cross-device recovery)
app.get('/api/users/search/:name', (req, res) => {
  const rows = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?) AND event = ?').all(req.params.name, EVENT_ID);
  res.json(rows.map(r => ({ ...r, sessions: JSON.parse(r.sessions) })));
});

// Create (no token) or update (token provided)
app.post('/api/users', (req, res) => {
  const { token, name, linkedin = '', sessions = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  const n = name.trim();
  const li = linkedin.trim();
  const s = JSON.stringify(sessions.map(String));

  if (token) {
    const exists = db.prepare('SELECT 1 FROM users WHERE token = ? AND event = ?').get(token, EVENT_ID);
    if (exists) {
      db.prepare(
        `UPDATE users SET name=?, linkedin=?, sessions=?, updated_at=datetime('now') WHERE token=? AND event=?`
      ).run(n, li, s, token, EVENT_ID);
      const row = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
      return res.json({ ...row, sessions: JSON.parse(row.sessions) });
    }
  }

  // New user — generate a token
  const newToken = randomUUID();
  db.prepare('INSERT INTO users (token, name, linkedin, sessions, event) VALUES (?, ?, ?, ?, ?)').run(newToken, n, li, s, EVENT_ID);
  const row = db.prepare('SELECT * FROM users WHERE token = ?').get(newToken);
  res.json({ ...row, sessions: JSON.parse(row.sessions) });
});

// Matches ranked by session overlap
app.get('/api/matches/:token', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE token = ? AND event = ?').get(req.params.token, EVENT_ID);
  if (!me) return res.status(404).json({ error: 'Not found' });

  // Session ids are strings in the current data format and numbers in older
  // rows — compare as strings so both line up.
  const mine = new Set(JSON.parse(me.sessions).map(String));
  const others = db.prepare('SELECT * FROM users WHERE token != ? AND event = ?').all(req.params.token, EVENT_ID);

  const matches = others
    .map(u => {
      const theirs = JSON.parse(u.sessions).map(String);
      const common = theirs.filter(s => mine.has(s));
      return { name: u.name, linkedin: u.linkedin, overlap: common.length, totalSessions: theirs.length, sessions: theirs, commonSessions: common };
    })
    .filter(m => m.totalSessions > 0)
    .sort((a, b) => b.overlap - a.overlap || b.totalSessions - a.totalSessions);

  res.json(matches);
});

app.listen(PORT, () => {
  const pickable = BOARD.timeslots.reduce((n, s) => n + s.sessions.filter(x => x.selectable).length, 0);
  console.log(`\n  ${CONFIG.title} — ${CONFIG.name}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Event: ${EVENT_ID} · format: ${BOARD.format} · ${BOARD.timeslots.length} timeslots · ${pickable} sessions`);
  if (pickable === 0) console.log(`  ⚠  No sessions yet — fill in events/${CONFIG.dataFile}`);
  console.log(`  Data: ${DATA_DIR}\n`);
});
