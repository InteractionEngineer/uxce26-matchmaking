# UXcamp Matchmaker

A web app for Barcamp attendees to find each other based on which sessions they went to. Each participant picks the sessions they attended, optionally adds a LinkedIn URL, and the app ranks other participants by how many sessions they have in common.

One deployment serves one event, selected via the `EVENT` env var. Currently configured:

| Event id | Event | Data format |
|---|---|---|
| `uxchh26` (default) | UXcamp Hamburg 2026 | `session-plan-v1` |
| `uxce26` | UXcamp Europe 2026 (Berlin) | `barcamp-board-v1` |

Live during the event (and for ~30 days after) at **https://uxchh26.jona.one** (`#uxce26` ran at **https://uxce26.jona.one**). After that, per the privacy policy, all participant data is wiped.

---

## Background

**UX Camp Europe** is a *Barcamp*: an unconference with no pre-published programme. On the first morning, anyone who wants to host a session pitches it, the crowd votes, and the schedule for the next two days emerges in real time. The result is six to ten parallel tracks of small, conversational sessions on whatever the community is currently chewing on.

Two patterns at #uxce26 (Berlin, May 2026) motivated the project:

- Because sessions are self-selected, **session overlap is a fairly strong proxy for shared interests** — much more so than at a conference with a fixed track.
- People you actually talk to during a session get added to your contacts naturally. The trickier case is the people you keep ending up in the same rooms with but never end up speaking to — they stay off your radar even though the overlap is obvious in hindsight.

The app surfaces those high-overlap participants as a starting point for conversations that otherwise would not happen.

It was built during the conference itself: the server and core flow on the night of the blow-out party between day 1 and day 2, with day 2's programme dropped in during the day-2 lunch break. That was also the point — to vibe-code a real, deployed product end-to-end rather than a demo.

---

## What the app does

- **Pick your sessions.** Sessions are grouped by day → timeslot → list of pitches, mirroring the Barcamp board. Tap to mark the ones you attended. Each timeslot shows a count.
- **Save your profile.** Name (required) and LinkedIn URL (optional). On save, the server mints a UUID and the browser stores it in `localStorage` — that token is the only identity, there is no password.
- **See your matches.** Other participants ranked by number of overlapping sessions — including the full list of sessions each of them attended, the specific overlaps, and their LinkedIn link if provided.
- **Share it.** `/share` is a full-screen QR code of the app's own URL, plus a native share sheet and a copy button — for handing the app to someone mid-conversation. The QR is rendered server-side, so it works on venue wifi with no CDN in the loop.

---

## Stack

| Layer | What |
|---|---|
| Server | Node.js + Express, single `server.js` |
| DB | SQLite via `better-sqlite3`, WAL mode |
| Client | Vanilla HTML/CSS/JS in one `public/index.html`, served to the browser as-is (no bundler, no transpiler) |
| Identity | UUID token in `localStorage`, no auth |
| Hosting | Docker + Docker Compose, designed to sit behind a reverse proxy |

**Session data** lives in `events/`, one file per event, and is normalised by a format adapter at startup (see "Session data" below). The `#uxce26` board was scraped from https://planner.berlin/board with AI assistance; from `#uxchh26` on, the session-plan export is used directly.

---

## Repo layout

```
.
├── server.js                     # Express server, API routes, SQLite setup
├── package.json
├── Dockerfile                    # Builds native deps in a first stage, then copies into a lean runtime image; runs as a non-root user, with a healthcheck
├── docker-compose.yml            # Volume for /data, expects external proxy network
├── lib/
│   └── board.js                  # Event registry + format adapters → canonical board
├── events/
│   ├── index.json                # Which events exist, their names and legal wording
│   ├── uxchh26.json              # UXcamp Hamburg 2026 — session-plan export
│   ├── uxce26.json               # UXcamp Europe 2026 — scraped Barcamp board
│   └── _example.session-plan.json # Reference for the session-plan format
├── public/
│   ├── index.html                # The entire client
│   ├── share.html                # Full-screen QR code for sharing the app
│   └── legal.html                # Imprint + privacy policy, placeholders filled at request time
└── data/                         # SQLite DB (gitignored), created on first run
    └── uxcamp.db
```

---

## Running it

### Locally

```bash
npm install
npm run dev          # nodemon
# or
npm start
```

Then open http://localhost:3000.

Environment variables (all optional):

| Var | Default | What |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where `uxcamp.db` lives |
| `EVENT` | `default` from `events/index.json` | Which event this instance serves |
| `POLL_MS` | `60000` | How often the live agenda source is polled |
| `ADMIN_TOKEN` | — | Enables `/admin`. Unset means the routes do not exist |
| `PUBLIC_URL` | derived from the request | The URL encoded into the share QR code. Only needed if the proxy does not send `X-Forwarded-Proto`/`-Host` |
| `LEGAL_NAME` | — | Substituted into `legal.html` at request time |
| `LEGAL_STREET` | — | " |
| `LEGAL_CITY` | — | " |
| `LEGAL_COUNTRY` | — | " |
| `LEGAL_EMAIL` | — | " |

The `LEGAL_*` vars fill the placeholders in `public/legal.html`. If unset, the placeholders show literally.

### With Docker

```bash
docker compose up -d --build
```

The bundled `docker-compose.yml` assumes an external Docker network called `public_proxymanager` (nginx-proxy-manager setup). To expose the port directly instead, drop the `networks` block and add:

```yaml
ports:
  - "3000:3000"
```

The container runs as a non-root `app` user, persists data to a named volume mounted at `/data`, and has a healthcheck against `/api/sessions`.

---

## API

JSON throughout. No auth — the token in the URL is the only credential, which is acceptable for the lifespan and threat model of a Barcamp side-project.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | The normalised board for the active event, plus `event`, `format` and `days` |
| `GET` | `/api/users/:token` | Load profile by token |
| `GET` | `/api/users/search/:name` | Case-insensitive exact-name lookup (server endpoint exists; not currently used by the client) |
| `POST` | `/api/users` | Create (no token in body) or update (token in body) |
| `GET` | `/api/matches/:token` | Other users ranked by session overlap |
| `GET` | `/admin` | Admin dashboard (only when `ADMIN_TOKEN` is set) |
| `GET` | `/share` | Full-screen QR code page |
| `GET` | `/qr.svg` | QR code for the app's public URL, as SVG |

---

## Admin

`/admin` manages the rows of the active event. It exists **only when `ADMIN_TOKEN` is set** — otherwise the routes are never registered and an unconfigured deployment answers 404, giving away nothing.

```bash
ADMIN_TOKEN=$(openssl rand -base64 24) docker compose up -d
```

Sign in with that token; it is then held in a `HttpOnly; SameSite=Strict` cookie scoped to `/admin` for 12 hours (`Secure` too, whenever the request arrived over https). `SameSite=Strict` is also the CSRF defence — no cross-site form post carries the cookie. Every response is `no-store` and `noindex`.

**Three login attempts per hour, per IP.** The limit is checked before the token is, so a correct token during a lockout is refused too — otherwise every request would be a free guess. The counter lives in memory, so restarting the container clears it. That is the way out if you lock yourself out. Putting Basic Auth in front of `/admin` at the proxy is a cheap second, independent layer.

What it does:

| | |
|---|---|
| **Participants** | Every row for the event, newest first, with session count and token |
| **Recovery link** | Copies `<app url>/?t=<token>` for one person. Opening it signs that browser back in as them and strips the parameter from the URL. This is how you rescue someone whose browser lost its token — send it to them and no one else |
| **Duplicates** | Rows sharing a name, which is normally one person whose browser lost its token. Merging keeps the most recently updated row (most likely the device still in their hand), unions the session ticks, takes the first LinkedIn URL it finds, and deletes the rest. The other devices lose their token — if one of them is still open and saves, it recreates a duplicate |
| **Delete** | One row, for a deletion request |
| **Wipe** | Every row of the event, confirmed by typing the event id. The privacy policy promises this within 30 days |
| **Export CSV** | Token, name, LinkedIn, sessions, timestamp |

## Data model

One table, `users`:

| Column | Type | Notes |
|---|---|---|
| `token` | TEXT PRIMARY KEY | UUID, server-generated |
| `name` | TEXT NOT NULL | Free text |
| `linkedin` | TEXT | Optional URL |
| `sessions` | TEXT | JSON array of session ids (strings) |
| `event` | TEXT NOT NULL | Event id — every query is scoped to it, so one database can hold several events |
| `updated_at` | TEXT | `datetime('now')` |

Matching is a set intersection on session ids within one event, sorted by overlap size and then by how many sessions the other person attended (so richer profiles surface higher on ties). Ids are compared as strings, so rows written before the format change (numeric ids) still line up.

**A deploy must not sign anyone out.** The container restarts on every push, so for a few seconds the API is gone — and the token in `localStorage` is the only identity there is. Three things follow from that:

- A failed `/api/sessions` no longer takes the whole boot with it, and the event id (which decides the storage key namespace) falls back to the last one seen rather than to `default`.
- A failed profile lookup never clears the token. The browser stays signed in on what it has and retries on the next load.
- `POST /api/users` re-creates a missing row **under the token the browser sent**, when that is a well-formed UUID nobody holds. A lost volume costs one save instead of an identity plus a duplicate row.

Storage keys are namespaced `<key>:<event>`; the pre-namespace `_token`/`_name`/`_li`/`_picked` are adopted on boot.

Two small migration blocks at the top of `server.js` run on startup: one drops an older `users` table from before tokens existed, one adds the `event` column to a table that predates multi-event support (existing rows default to `uxce26`). On a fresh database neither does anything.

---

## Session data

`events/index.json` is the registry. Each entry names a data file, the app's display name and the event-specific wording used in `public/legal.html`:

```json
{
  "id": "uxchh26",
  "dataFile": "uxchh26.json",
  "name": "#uxchh26 Matchmaker",
  "title": "UXcamp Hamburg 2026",
  "hashtag": "#uxchh26",
  "legal": {
    "eventName": "UXcamp Hamburg 2026",
    "attendees": "attendees",
    "lastUpdated": "September 2026"
  }
}
```

An entry may also carry a `source` URL. That URL is then the single source of truth and `dataFile` drops to a last-resort fallback (see "Live source" below).

The data itself is used **as exported** — `lib/board.js` picks the matching adapter by looking at the payload's shape and normalises it:

| Adapter | Recognised by | Used for |
|---|---|---|
| `barcamp-board-v1` | top-level `timeslots` array | The scraped `#uxce26` board: timeslots holding numbered sessions |
| `session-plan-v1` | top-level `entries` array | Session-plan export: flat entries with `startAt`/`endAt`, `room`, `host`, `kind` |

Both normalise to the same canonical shape, so the client only ever sees one format:

```
{ event, format, days: [...], timeslots: [
  { id, date, label, time, kind: "sessions" | "programme",
    sessions: [ { id, number, title, type, host, room, description, selectable } ] } ] }
```

In `session-plan-v1`, entries that share a `startAt` become one timeslot. Times and dates are read straight out of the ISO strings, so the event's local time is preserved regardless of the server's timezone.

Everything the format carries beyond the session itself stays deliberately quiet, because picking a session you sat in only needs its title:

- `"kind": "event"` entries (arrival, breaks, group photo, wrap-up) are not sessions and can't be picked. They render as a thin muted line — time and title, nothing else — and disappear while searching. Delete an entry from the JSON and it's gone from the view entirely.
- `room` and `host` appear as one quiet grey line under the title, to tell two similar pitches apart.
- `number` is read from a `number`/`sessionNumber`/`no` field, or from a `#42` in front of the title (which is then stripped so it isn't shown twice). Numbers are how people actually refer to a session, so a purely numeric search query matches the number from the front — `4` finds #4 and #42, but not "Top 4 mistakes".
- `description` is normalised but not displayed and not searched — it's pitch copy, not something you need in order to tick a box.

**Adding a new event:** point a registry entry at the agenda URL (or drop an export into `events/`), set `EVENT` on the deployment. **Adding a new format:** add an adapter to `ADAPTERS` in `lib/board.js` — nothing else changes.

---

## Live source

A Barcamp board is not finished when the app goes up: sessions get pitched all morning and land on the board while people are already ticking boxes. So when a registry entry has a `source`, the board is pulled from there rather than from the repo.

**Serving.** `/api/sessions` always answers from memory. No request ever waits on the source, and the source being down never returns an error to a user.

**Refreshing.** The store polls `source` every `POLL_MS` with the previous `ETag` in `If-None-Match`, so an unchanged board costs a 304. Each accepted response is snapshotted to `DATA_DIR/<event>.agenda.json`.

**Boot order** — least fresh first, each step overwriting the last one that worked:

```
events/<dataFile>  →  DATA_DIR/<event>.agenda.json  →  live fetch
```

The server starts even if all three fail; the client then shows "the board isn't up yet". `events/uxchh26.json` is intentionally empty — it exists so a board can be pasted in by hand if the source is unreachable at a moment when it matters.

**Guards**, because this is third-party data on the critical path: 8s timeout, 2 MB cap, an adapter has to recognise the payload, and **a response with zero sessions never replaces a board that has some**. Losing the programme mid-event is much worse than serving one that is a minute stale.

**Client.** The page polls `/api/sessions` every 60s and compares `version` (a content hash of the normalised board). On a change it re-renders in place — selections, search and scroll survive — and toasts "N new sessions on the board". Polling pauses while the tab is hidden and fires once immediately when it comes back.

---

## Open items

Feature requests collected during and after the event:

- Speaker names on session cards (originally omitted for privacy)
- Room names on session cards
- Profile picture from LinkedIn
- Clearer affordance that the match card links to LinkedIn
- Topics / session history across years
- Search within people / matches
- Map of participants based on LinkedIn location
- A dedicated "your match card" view, separate from the editable list

Bugs:

- Duplicate user after closing the tab (reported case: Corinna)
