'use strict';

const fs = require('fs');
const path = require('path');

const EVENTS_DIR = path.join(__dirname, '..', 'events');

// Pull date and time straight out of the ISO string instead of going through
// Date — that keeps the event's own local time, whatever timezone the server
// happens to run in.
const ymd  = iso => (String(iso).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const hhmm = iso => (String(iso).match(/T(\d{2}:\d{2})/)       || [])[1] || '';

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
// shown for orientation but cannot be picked.
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
        sessions: items.map(e => ({
          id: String(e.id),
          number: null,
          title: e.title,
          type: null,
          host: e.host || null,
          room: e.room || null,
          description: e.description || null,
          selectable: isSession(e),
        })),
      };
    });
  },
};

const ADAPTERS = [barcampBoardV1, sessionPlanV1];

// ── Loading ────────────────────────────────────────────────────────────────

function loadRegistry() {
  return JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, 'index.json'), 'utf8'));
}

function eventConfig(eventId) {
  const registry = loadRegistry();
  const id = eventId || registry.default;
  const cfg = registry.events.find(e => e.id === id);
  if (!cfg) {
    throw new Error(`Unknown event "${id}" — known events: ${registry.events.map(e => e.id).join(', ')}`);
  }
  return cfg;
}

function loadBoard(eventId) {
  const cfg = eventConfig(eventId);
  const file = path.join(EVENTS_DIR, cfg.dataFile);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  const adapter = ADAPTERS.find(a => a.detect(raw));
  if (!adapter) {
    throw new Error(
      `${cfg.dataFile}: unrecognised format. Expected a "timeslots" or an "entries" array ` +
      `(see events/_example.session-plan.json).`
    );
  }

  const timeslots = adapter.normalize(raw);
  const days = [...new Set(timeslots.map(s => s.date).filter(Boolean))].sort();

  return {
    event: { id: cfg.id, name: cfg.name, title: cfg.title, hashtag: cfg.hashtag },
    format: adapter.id,
    days,
    timeslots,
  };
}

module.exports = { loadBoard, eventConfig, ADAPTERS };
