const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

app.use(express.json());

// Serve legal.html with env-var substitutions
app.get('/legal.html', (_req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'legal.html'), 'utf8');
  const subs = {
    '[First name Last name]': process.env.LEGAL_NAME,
    '[Street and house number]': process.env.LEGAL_STREET,
    '[Postal code City]': process.env.LEGAL_CITY,
    '[Country]': process.env.LEGAL_COUNTRY,
    '[contact@example.com]': process.env.LEGAL_EMAIL,
  };
  for (const [placeholder, value] of Object.entries(subs)) {
    if (value) {
      html = html.split(`<span class="placeholder">${placeholder}</span>`).join(value);
      html = html.split(placeholder).join(value);
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use(express.static(path.join(__dirname, 'public')));

const SESSIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'uxcamp2026_sessions.json'), 'utf8')
);

app.get('/api/sessions', (_req, res) => res.json(SESSIONS));

// Load by token (exact match — used on return visit via localStorage)
app.get('/api/users/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, sessions: JSON.parse(row.sessions) });
});

// Search by name (case-insensitive — used for cross-device recovery)
app.get('/api/users/search/:name', (req, res) => {
  const rows = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?)').all(req.params.name);
  res.json(rows.map(r => ({ ...r, sessions: JSON.parse(r.sessions) })));
});

// Create (no token) or update (token provided)
app.post('/api/users', (req, res) => {
  const { token, name, linkedin = '', sessions = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  const n = name.trim();
  const li = linkedin.trim();
  const s = JSON.stringify(sessions);

  if (token) {
    const exists = db.prepare('SELECT 1 FROM users WHERE token = ?').get(token);
    if (exists) {
      db.prepare(
        `UPDATE users SET name=?, linkedin=?, sessions=?, updated_at=datetime('now') WHERE token=?`
      ).run(n, li, s, token);
      const row = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
      return res.json({ ...row, sessions: JSON.parse(row.sessions) });
    }
  }

  // New user — generate a token
  const newToken = randomUUID();
  db.prepare('INSERT INTO users (token, name, linkedin, sessions) VALUES (?, ?, ?, ?)').run(newToken, n, li, s);
  const row = db.prepare('SELECT * FROM users WHERE token = ?').get(newToken);
  res.json({ ...row, sessions: JSON.parse(row.sessions) });
});

// Matches ranked by session overlap
app.get('/api/matches/:token', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE token = ?').get(req.params.token);
  if (!me) return res.status(404).json({ error: 'Not found' });

  const mine = new Set(JSON.parse(me.sessions));
  const others = db.prepare('SELECT * FROM users WHERE token != ?').all(req.params.token);

  const matches = others
    .map(u => {
      const theirs = JSON.parse(u.sessions);
      const common = theirs.filter(s => mine.has(s));
      return { name: u.name, linkedin: u.linkedin, overlap: common.length, totalSessions: theirs.length, sessions: theirs, commonSessions: common };
    })
    .filter(m => m.totalSessions > 0)
    .sort((a, b) => b.overlap - a.overlap || b.totalSessions - a.totalSessions);

  res.json(matches);
});

app.listen(PORT, () => {
  console.log(`\n  UXcamp 2026 Matchmaking`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Data: ${DATA_DIR}\n`);
});
