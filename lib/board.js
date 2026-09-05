'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const EVENTS_DIR = path.join(__dirname, '..', 'events');
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// Pull date and time straight out of the ISO string instead of going through
// Date — that keeps the event's own local time, whatever timezone the server
// happens to run in.
const ymd  = iso => (String(iso).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const hhmm = iso => (String(iso).match(/T(\d{2}:\d{2})/)       || [])[1] || '';

// Session numbers are how people actually refer to a session ("were you in 42?"),
// so take one wherever the export offers it — an explicit field, or a "#42 " the
// board put in front of the title.
function titleAndNumber(entry) {
  for (const key of ['number', 'sessionNumber', 'no']) {
    const v = entry[key];
    if (v != null && String(v).trim() !== '' && Number.isFinite(Number(v))) {
      return { title: String(entry.title || '').trim(), number: Number(v) };
    }
  }
  const m = String(entry.title || '').match(/^#\s*(\d{1,4})[\s.:—–-]+(.+)$/);
  if (m) return { title: m[2].trim(), number: Number(m[1]) };
  return { title: String(entry.title || '').trim(), number: null };
}

// ── Format adapters ────────────────────────────────────────────────────────
// Every adapter recognises one source format and normalises it to the canonical
// board shape (timeslots → sessions) that the API and the client work with.
// To support a new export format, add an adapter here — nothing else changes.

// The Barcamp board scraped for #uxce26: timeslots with numbered sessions.
const barcampBoardV1 = {
  id: 'barcamp-board-v1',
  detect: raw => Array.isArray(raw && raw.timeslots),
  normalize: raw => raw.timeslots.map((slot, i) => ({
    id: slot.id || `slot-${i + 1}`,
    date: slot.date || '',
    label: slot.label || '',
    time: slot.time || '',
    kind: 'sessions',
    sessions: (slot.sessions || []).map(s => ({
      id: String(s.number),
      number: s.number,
      title: s.title || '',
      type: s.type || null,
      host: null,
      room: null,
      description: null,
      selectable: true,
    })),
  })),
};

// The session-plan export used from #uxchh26 on: a flat list of entries with
// absolute start/end times, rooms and hosts. Entries that share a start time
// become one timeslot; entries with kind "event" (breaks, intro, photo) are
// context only and cannot be picked.
const sessionPlanV1 = {
  id: 'session-plan-v1',
  detect: raw => Array.isArray(raw && raw.entries),
  normalize: raw => {
    const entries = raw.entries
      .filter(e => e && e.startAt && e.title)
      .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt))); // stable: keeps file order within a slot

    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.startAt)) groups.set(e.startAt, []);
      groups.get(e.startAt).push(e);
    }

    const sessionCountPerDay = {};
    return [...groups.entries()].map(([startAt, items], i) => {
      const date = ymd(startAt);
      const isSession = e => (e.kind || 'session') === 'session';
      const hasSession = items.some(isSession);

      const start = hhmm(startAt);
      const ends = items.map(e => hhmm(e.endAt)).filter(Boolean).sort();
      const end = ends[ends.length - 1] || '';

      let label = '';
      if (hasSession) {
        sessionCountPerDay[date] = (sessionCountPerDay[date] || 0) + 1;
        label = `Session ${sessionCountPerDay[date]}`;
      }

      return {
        id: `slot-${i + 1}`,
        date,
        label,
        time: end ? `${start}–${end}` : start,
        kind: hasSession ? 'sessions' : 'programme',
        sessions: items.map(e => {
          const { title, number } = titleAndNumber(e);
          return {
            id: String(e.id),
            number,
            title,
            type: null,
            host: e.host || null,
            room: e.room || null,
            description: e.description || null,
            selectable: isSession(e),
          };
        }),
      };
    });
  },
};

const ADAPTERS = [barcampBoardV1, sessionPlanV1];

// ── Normalising ────────────────────────────────────────────────────────────

function normalize(raw, origin) {
  const adapter = ADAPTERS.find(a => a.detect(raw));
  if (!adapter) {
    throw new Error(
      `${origin}: unrecognised format. Expected a "timeslots" or an "entries" array ` +
      `(see events/_example.session-plan.json).`
    );
  }
  const timeslots = adapter.normalize(raw);
  return {
    format: adapter.id,
    days: [...new Set(timeslots.map(s => s.date).filter(Boolean))].sort(),
    timeslots,
    // Short content hash — the client polls and re-renders only when this moves.
    version: createHash('sha1').update(JSON.stringify(timeslots)).digest('hex').slice(0, 12),
  };
}

const countSessions = board =>
  board.timeslots.reduce((n, s) => n + s.sessions.filter(x => x.selectable).length, 0);

// ── Event registry ─────────────────────────────────────────────────────────

function eventConfig(eventId) {
  const registry = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, 'index.json'), 'utf8'));
  const id = eventId || registry.default;
  const cfg = registry.events.find(e => e.id === id);
  if (!cfg) {
    throw new Error(`Unknown event "${id}" — known events: ${registry.events.map(e => e.id).join(', ')}`);
  }
  return cfg;
}

// ── Board store ────────────────────────────────────────────────────────────
// Holds the board in memory. When the event config names a `source`, that URL is
// the single source of truth: it is polled in the background and every response
// is snapshotted to disk. Requests are always served from memory, so the app
// never waits on the source — and never breaks when the source is unreachable.

function createBoardStore({ eventId, dataDir, pollMs = 60000, log = console.log }) {
  const config = eventConfig(eventId);
  const snapshotFile = path.join(dataDir, `${config.id}.agenda.json`);

  let board = null;
  let etag = null;
  let timer = null;
  let lastCheckedAt = null;

  const payload = () => ({ event: { id: config.id, name: config.name, title: config.title, hashtag: config.hashtag }, ...board });

  function adopt(raw, origin) {
    const next = normalize(raw, origin);
    // A source that momentarily answers with an empty board must never wipe one
    // we already have — losing the programme mid-event is far worse than serving
    // one that is a minute stale.
    if (board && countSessions(next) === 0 && countSessions(board) > 0) {
      log(`  ⚠  ${origin} has no sessions — keeping the ${countSessions(board)} we already have`);
      return false;
    }
    const changed = !board || board.version !== next.version;
    board = { ...next, source: origin, updatedAt: new Date().toISOString() };
    return changed;
  }

  function loadFile(file, origin) {
    try {
      return adopt(JSON.parse(fs.readFileSync(file, 'utf8')), origin);
    } catch (err) {
      if (err.code !== 'ENOENT') log(`  ⚠  ${origin}: ${err.message}`);
      return false;
    }
  }

  async function fetchSource() {
    const res = await fetch(config.source, {
      headers: etag ? { 'If-None-Match': etag } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 304) return { status: 'not-modified' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_SOURCE_BYTES) throw new Error(`response too large (${declared} bytes)`);
    const text = await res.text();
    if (text.length > MAX_SOURCE_BYTES) throw new Error(`response too large (${text.length} bytes)`);

    return { status: 'ok', raw: JSON.parse(text), etag: res.headers.get('etag') };
  }

  // Returns true when the board actually changed.
  async function refresh() {
    if (!config.source) return false;
    try {
      const result = await fetchSource();
      lastCheckedAt = new Date().toISOString();
      if (result.status === 'not-modified') return false;

      const changed = adopt(result.raw, config.source);
      etag = result.etag;
      if (changed) {
        // Snapshot every accepted response — this is what boots the app when the
        // source is down.
        try { fs.writeFileSync(snapshotFile, JSON.stringify(result.raw)); }
        catch (err) { log(`  ⚠  could not write snapshot: ${err.message}`); }
        log(`  ↻ Board updated from source — ${countSessions(board)} sessions`);
      }
      return changed;
    } catch (err) {
      lastCheckedAt = new Date().toISOString();
      log(`  ⚠  Source unreachable (${err.message}) — serving ${board ? 'the last known board' : 'nothing yet'}`);
      return false;
    }
  }

  async function init() {
    // Least fresh first, so each step that works overwrites the one before it.
    if (config.dataFile) loadFile(path.join(EVENTS_DIR, config.dataFile), `events/${config.dataFile}`);
    if (config.source) {
      loadFile(snapshotFile, 'snapshot');
      await refresh();
    }
    return board;
  }

  function startPolling() {
    if (!config.source || timer) return;
    timer = setInterval(() => { refresh().catch(() => {}); }, pollMs);
    timer.unref?.();
  }

  // Start out with an empty but well-formed board, so a request that arrives
  // before init() finishes — or after it failed — still gets something the
  // client can render.
  adopt({ entries: [] }, 'empty');

  return {
    config,
    init,
    refresh,
    startPolling,
    stop: () => { clearInterval(timer); timer = null; },
    get board() { return payload(); },
    get sessionCount() { return countSessions(board); },
    get status() { return { source: config.source || null, lastCheckedAt, version: board?.version, updatedAt: board?.updatedAt }; },
  };
}

module.exports = { createBoardStore, eventConfig, normalize, ADAPTERS };
