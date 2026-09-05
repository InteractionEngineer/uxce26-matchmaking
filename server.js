const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { createBoardStore } = require('./lib/board');
const { mountAdmin } = require('./lib/admin');

// Loaded lazily: the QR code is a nice-to-have on one page, and a missing module
// must never be the reason nobody can log their sessions.
let qrLib;
function qrcode() {
  if (qrLib === undefined) {
    try { qrLib = require('qrcode'); }
    catch (err) { qrLib = null; console.error(`  ⚠  qrcode module unavailable (${err.message}) — /share works without the code`); }
  }
  return qrLib;
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENT = process.env.EVENT || null; // null → default from events/index.json
const POLL_MS = Number(process.env.POLL_MS) || 60000;
const PUBLIC_URL = process.env.PUBLIC_URL || null; // falls back to the request's own host
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null; // unset → no /admin routes at all

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

const store = createBoardStore({ eventId: EVENT, dataDir: DATA_DIR, pollMs: POLL_MS });
const CONFIG = store.config;
const EVENT_ID = CONFIG.id;

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // the admin pages post plain forms

// ── HTML templating ────────────────────────────────────────────────────────
// Placeholders in the static pages are filled per request: the [LEGAL_*] ones
// from env vars, the event ones from events/index.json. Placeholders without a
// value stay visible as-is.
// The URL people scan. Behind the reverse proxy the forwarded headers carry the
// public host; PUBLIC_URL overrides both.
function shareUrl(req) {
  if (PUBLIC_URL) {
    // Always absolute: a QR code without a scheme is a search term to most
    // camera apps, not a link — they offer to google the host instead of
    // opening it. PUBLIC_URL is hand-written, so don't trust it to carry one.
    const url = PUBLIC_URL.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function renderHtml(file, req, res) {
  let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const subs = {
    '[First name Last name]': process.env.LEGAL_NAME,
    '[Street and house number]': process.env.LEGAL_STREET,
    '[Postal code City]': process.env.LEGAL_CITY,
    '[Country]': process.env.LEGAL_COUNTRY,
    '[contact@example.com]': process.env.LEGAL_EMAIL,
    '[App name]': CONFIG.name,
    '[Share URL]': shareUrl(req),
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

app.get(['/', '/index.html'], (req, res) => renderHtml('index.html', req, res));
app.get('/legal.html', (req, res) => renderHtml('legal.html', req, res));
app.get(['/share', '/share.html'], (req, res) => renderHtml('share.html', req, res));

// QR code for the share page — rendered server-side so the app carries no CDN
// dependency and keeps working on venue wifi.
const qrCache = new Map();
app.get('/qr.svg', async (req, res) => {
  const url = shareUrl(req);
  const lib = qrcode();
  if (!lib) return res.status(503).send('<!-- qrcode module unavailable -->');
  try {
    if (!qrCache.has(url)) {
      qrCache.set(url, await lib.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }));
    }
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(qrCache.get(url));
  } catch (err) {
    res.status(500).send(`<!-- ${err.message} -->`);
  }
});

// Admin routes exist only when a token is configured — otherwise an
// unconfigured deployment answers 404 and reveals nothing.
if (ADMIN_TOKEN) mountAdmin(app, { db, eventId: EVENT_ID, config: CONFIG, adminToken: ADMIN_TOKEN, shareUrl });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', (_req, res) => res.json(store.board));

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

  // A token the browser still holds but there is no row for — a lost volume, a
  // restored backup. Re-create the row under that same token so the person
  // keeps their identity instead of turning into a second row. Must be a
  // well-formed UUID nobody else holds; `token` is the primary key.
  const reusable = typeof token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) &&
    !db.prepare('SELECT 1 FROM users WHERE token = ?').get(token);
  const newToken = reusable ? token : randomUUID();

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

// Listen first, load the board after. Whatever goes wrong with the board — an
// unreachable source, a malformed file — must degrade to an empty board behind a
// working server, never to a process that never binds and a 502 at the proxy.
app.listen(PORT, () => {
  console.log(`\n  ${CONFIG.title} — ${CONFIG.name}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Event: ${EVENT_ID} · data: ${DATA_DIR}`);
  console.log(ADMIN_TOKEN ? `  Admin: /admin` : `  Admin: off (no ADMIN_TOKEN)`);
  console.log(CONFIG.source
    ? `  Source: ${CONFIG.source} (polled every ${Math.round(POLL_MS / 1000)}s)`
    : `  Source: events/${CONFIG.dataFile}`);
});

store.init()
  .then(() => {
    store.startPolling();
    const board = store.board;
    console.log(`  Board: ${board.format} · ${board.timeslots.length} timeslots · ${store.sessionCount} sessions`);
    if (store.sessionCount === 0) console.log(`  ⚠  No sessions on the board yet`);
  })
  .catch(err => console.error(`  ⚠  Board init failed (${err.message}) — serving an empty board`));
