// Admin surface for one event's rows. Mounted only when ADMIN_TOKEN is set —
// without it the routes do not exist at all, so an unconfigured deployment
// answers 404 and gives away nothing.
//
// The threat model is a side project that holds names, LinkedIn URLs and
// session ticks for a few days. One shared token, a cookie, and a hard login
// limit is proportionate; roles, password hashing and a session table are not.

const { timingSafeEqual } = require('crypto');

const COOKIE = 'uxadmin';
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 60 * 1000;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Constant-time, and never throws on a length mismatch.
function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Behind the reverse proxy req.ip is the proxy. The forwarded header is
// spoofable, but the limit only has to stop someone hammering the form — the
// token itself is what has to be strong.
const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

function mountAdmin(app, { db, eventId, config, adminToken, shareUrl }) {
  const attempts = new Map(); // ip → { count, resetAt }

  function attemptState(ip) {
    const entry = attempts.get(ip);
    if (!entry || Date.now() > entry.resetAt) return { count: 0, resetAt: 0 };
    return entry;
  }

  function guard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (sameToken(readCookie(req, COOKIE) || '', adminToken)) return next();
    res.status(401).send(page('Sign in', loginForm(attemptState(clientIp(req)))));
  }

  function setCookie(req, res) {
    const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
    res.setHeader('Set-Cookie', [
      `${COOKIE}=${encodeURIComponent(adminToken)}`,
      'Path=/admin',
      'HttpOnly',
      'SameSite=Strict',   // also the CSRF defence: no cross-site POST carries this
      'Max-Age=43200',
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; '));
  }

  // ── Views ────────────────────────────────────────────────────────────────
  const page = (title, body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} – ${esc(config.name)} admin</title>
<style>
  :root { --primary:#1d4ed8; --bg:#f8fafc; --card:#fff; --text:#0f172a; --muted:#64748b;
          --border:#e2e8f0; --danger:#b91c1c; --danger-bg:#fef2f2; --r:12px; --rs:8px; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
       background:var(--bg);color:var(--text);font-size:15px;line-height:1.5}
  header{background:var(--card);border-bottom:1px solid var(--border);padding:12px 20px}
  .hdr{max-width:960px;margin:0 auto;display:flex;align-items:center;gap:12px}
  .brand{font-size:15px;font-weight:800;color:var(--primary);letter-spacing:-.3px;margin-right:auto}
  main{max-width:960px;margin:0 auto;padding:24px 20px 60px}
  h2{font-size:17px;font-weight:700;letter-spacing:-.2px;margin:28px 0 10px}
  h2:first-child{margin-top:0}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;
     letter-spacing:.4px;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:var(--muted)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .scroll{overflow-x:auto}
  .btn{display:inline-flex;align-items:center;justify-content:center;padding:7px 13px;
       border-radius:var(--rs);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;
       border:1.5px solid var(--border);background:var(--card);color:var(--text);text-decoration:none}
  .btn:hover{background:var(--bg)}
  .btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}
  .btn-danger{color:var(--danger);border-color:#fecaca;background:var(--danger-bg)}
  .btn-lg{padding:11px 18px;font-size:15px;width:100%}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1.5px solid var(--border);
       border-radius:var(--rs);font-size:15px;font-family:inherit;background:var(--card);color:var(--text)}
  input:focus{outline:none;border-color:var(--primary)}
  form.inline{display:inline}
  .stack{display:flex;flex-direction:column;gap:12px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .note{font-size:13px;color:var(--muted);margin-top:8px}
  .warn{background:var(--danger-bg);border:1px solid #fecaca;border-radius:var(--r);padding:14px}
  .warn h2{margin:0 0 6px;color:var(--danger)}
  .login{max-width:340px;margin:14vh auto;padding:0 20px}
  .err{color:var(--danger);font-size:13.5px;font-weight:600}
  .pill{display:inline-block;background:#eff6ff;color:var(--primary);border-radius:999px;
        padding:1px 8px;font-size:12px;font-weight:700}
</style></head>
<body>${body}</body></html>`;

  const loginForm = ({ count }) => {
    const left = Math.max(0, MAX_ATTEMPTS - count);
    return `<div class="login"><div class="stack">
      <div><div class="brand">${esc(config.name)}</div><div class="muted">Admin</div></div>
      <form method="POST" action="/admin/login" class="stack">
        <input type="password" name="token" placeholder="Admin token" autofocus autocomplete="off">
        <button class="btn btn-primary btn-lg" type="submit">Sign in</button>
      </form>
      ${count > 0 ? `<div class="err">Wrong token. ${left} of ${MAX_ATTEMPTS} attempts left this hour.</div>` : ''}
      <div class="note">Three attempts per hour. Restarting the container clears the counter.</div>
    </div></div>`;
  };

  const lockedOut = resetAt => page('Locked', `<div class="login"><div class="stack">
      <div class="brand">${esc(config.name)}</div>
      <div class="warn"><h2>Too many attempts</h2>
      <div>Try again after ${esc(new Date(resetAt).toISOString().slice(11, 16))} UTC,
      or restart the container to clear the counter.</div></div>
    </div></div>`);

  function dashboard(req) {
    const rows = db.prepare(
      `SELECT token, name, sessions, updated_at FROM users WHERE event = ?
       ORDER BY updated_at DESC`).all(eventId);

    const byName = new Map();
    for (const r of rows) {
      const key = r.name.trim().toLowerCase();
      byName.set(key, (byName.get(key) || 0) + 1);
    }
    const dupes = [...byName].filter(([, n]) => n > 1);
    const base = shareUrl(req);

    const list = rows.map(r => {
      const count = (() => { try { return JSON.parse(r.sessions).length; } catch { return 0; } })();
      const dupe = byName.get(r.name.trim().toLowerCase()) > 1;
      const jsName = esc(r.name).replace(/'/g, "\\'");
      return `<tr>
        <td>
          <form class="inline row" method="POST" action="/admin/rename">
            <input type="hidden" name="token" value="${esc(r.token)}">
            <input type="text" name="name" value="${esc(r.name)}" aria-label="Name" style="max-width:190px">
            <button class="btn" type="submit">rename</button>
          </form>
          ${dupe ? '<span class="pill">dupe</span>' : ''}
          <div class="mono muted">${esc(r.token)}</div></td>
        <td class="num">${count}</td>
        <td class="muted" style="white-space:nowrap">${esc(r.updated_at)}</td>
        <td class="num">
          <button class="btn" type="button"
            onclick="navigator.clipboard.writeText('${esc(base)}/?t=${esc(r.token)}').then(()=>{this.textContent='copied'})">
            recovery link</button>
          <form class="inline" method="POST" action="/admin/delete"
                onsubmit="return confirm('Delete ${jsName}? This cannot be undone.')">
            <input type="hidden" name="token" value="${esc(r.token)}">
            <button class="btn btn-danger" type="submit">delete</button>
          </form>
        </td></tr>`;
    }).join('');

    const dupeBlock = dupes.length ? `
      <h2>Duplicates</h2>
      <div class="card" style="padding:14px"><div class="stack">
        <div class="muted">Same name, several rows — usually one person whose browser lost its
        token. Merging keeps the most recently updated row, unions the session ticks, and
        deletes the rest.</div>
        ${dupes.map(([name, n]) => `<div class="row">
          <strong>${esc(name)}</strong><span class="muted">${n} rows</span>
          <form class="inline" method="POST" action="/admin/merge" style="margin-left:auto"
                onsubmit="return confirm('Merge ${n} rows named ${esc(name).replace(/'/g, "\\'")}?')">
            <input type="hidden" name="name" value="${esc(name)}">
            <button class="btn btn-primary" type="submit">merge</button>
          </form></div>`).join('')}
      </div></div>` : '';

    return page('Admin', `
      <header><div class="hdr">
        <span class="brand">${esc(config.name)}</span>
        <span class="muted">${esc(eventId)}</span>
        <form class="inline" method="POST" action="/admin/logout">
          <button class="btn" type="submit">Sign out</button></form>
      </div></header>
      <main>
        <h2>Participants <span class="muted">(${rows.length})</span></h2>
        <div class="card scroll"><table>
          <tr><th>Name / token</th><th class="num">Sessions</th><th>Updated</th><th></th></tr>
          ${list || '<tr><td colspan="4" class="muted">No rows yet.</td></tr>'}
        </table></div>
        <div class="note">A recovery link signs that person back in on whatever device opens it.
        Send it only to them.</div>

        ${dupeBlock}

        <h2>Delete everything</h2>
        <div class="warn">
          <h2>Wipe all ${rows.length} rows for ${esc(eventId)}</h2>
          <div class="muted">The privacy policy promises deletion within 30 days of the event.
          Type the event id to confirm.</div>
          <form method="POST" action="/admin/wipe" class="row" style="margin-top:10px">
            <input type="text" name="confirm" placeholder="${esc(eventId)}" autocomplete="off" style="max-width:200px">
            <button class="btn btn-danger" type="submit">Delete all</button>
          </form>
        </div>
      </main>`);
  }

  // ── Routes ───────────────────────────────────────────────────────────────
  app.post('/admin/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ip = clientIp(req);
    const state = attemptState(ip);

    if (state.count >= MAX_ATTEMPTS) return res.status(429).send(lockedOut(state.resetAt));

    if (sameToken(req.body?.token || '', adminToken)) {
      attempts.delete(ip);
      setCookie(req, res);
      return res.redirect('/admin');
    }

    const resetAt = state.resetAt || Date.now() + WINDOW_MS;
    const next = { count: state.count + 1, resetAt };
    attempts.set(ip, next);
    console.log(`  ⚠  Failed admin login from ${ip} (${next.count}/${MAX_ATTEMPTS})`);
    if (next.count >= MAX_ATTEMPTS) return res.status(429).send(lockedOut(resetAt));
    res.status(401).send(page('Sign in', loginForm(next)));
  });

  app.post('/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.redirect('/admin');
  });

  app.get('/admin', guard, (req, res) => res.send(dashboard(req)));

  // Names are what everyone else sees in their match list, so a typo or something
  // rude is fixed here rather than by deleting the row.
  app.post('/admin/rename', guard, (req, res) => {
    const name = (req.body?.name || '').trim().slice(0, 80);
    if (name) {
      db.prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE token = ? AND event = ?`)
        .run(name, req.body?.token || '', eventId);
    }
    res.redirect('/admin');
  });

  app.post('/admin/delete', guard, (req, res) => {
    db.prepare('DELETE FROM users WHERE token = ? AND event = ?').run(req.body?.token || '', eventId);
    res.redirect('/admin');
  });

  // One person, several rows: keep the row they touched last (most likely the
  // device still in their hand), give it every session tick from the others.
  app.post('/admin/merge', guard, (req, res) => {
    const name = (req.body?.name || '').trim();
    const rows = db.prepare(
      `SELECT * FROM users WHERE event = ? AND lower(trim(name)) = lower(?)
       ORDER BY updated_at DESC`).all(eventId, name);

    if (rows.length > 1) {
      const keep = rows[0];
      const sessions = new Set();
      let linkedin = '';
      for (const r of rows) {
        try { JSON.parse(r.sessions).forEach(s => sessions.add(String(s))); } catch {}
        if (!linkedin && r.linkedin) linkedin = r.linkedin;
      }
      db.transaction(() => {
        db.prepare(`UPDATE users SET sessions = ?, linkedin = ?, updated_at = datetime('now')
                    WHERE token = ?`).run(JSON.stringify([...sessions]), linkedin, keep.token);
        for (const r of rows.slice(1)) db.prepare('DELETE FROM users WHERE token = ?').run(r.token);
      })();
      console.log(`  Merged ${rows.length} rows for "${name}" into ${keep.token}`);
    }
    res.redirect('/admin');
  });

  app.post('/admin/wipe', guard, (req, res) => {
    if ((req.body?.confirm || '').trim() !== eventId) return res.redirect('/admin');
    const { changes } = db.prepare('DELETE FROM users WHERE event = ?').run(eventId);
    console.log(`  ⚠  Wiped ${changes} rows for ${eventId}`);
    res.redirect('/admin');
  });
}

module.exports = { mountAdmin };
