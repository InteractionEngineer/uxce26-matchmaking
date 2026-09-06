# UXcamp Matchmaker

A web app for Barcamp attendees to find each other based on which sessions they went to. Each participant picks the sessions they attended, optionally adds a LinkedIn URL, and the app ranks other participants by how many sessions they have in common.

One deployment serves one event, selected via the `EVENT` env var. Currently configured:

| Event id | Event | Board comes from |
|---|---|---|
| `uxchh26` (default) | UXcamp Hamburg 2026 | Live agenda source, `session-plan-v1` |
| `uxce26` | UXcamp Europe 2026 (Berlin) | `events/uxce26.json`, `barcamp-board-v1` |

Live during the event (and for ~30 days after) at **https://uxchh26.jona.one** (`#uxce26` ran at **https://uxce26.jona.one**). After that, per the privacy policy, all participant data is wiped.

---

## Background

A Barcamp has no pre-published programme: anyone who wants to host a session pitches it on the first morning, the crowd votes, and six to ten parallel tracks emerge in real time. Because sessions are self-selected, session overlap is a much stronger proxy for shared interests than a fixed conference track — and the people you keep ending up in the same rooms with but never speak to stay off your radar entirely. The app surfaces exactly those.

Built during #uxce26 (Berlin, May 2026): server and core flow on the night between day 1 and day 2, day 2's programme dropped in over lunch. That was the point — a real, deployed product end-to-end rather than a demo.

---

## What the app does

- **Pick your sessions.** Grouped by day → timeslot → pitches, mirroring the board; each timeslot shows a count. Ticks hit `localStorage` at once and the server when you leave the tab, so dropped wifi never costs a selection.
- **Save your profile.** Name (required) and LinkedIn URL (optional). The server mints a UUID; that token in `localStorage` is the only identity, there is no password.
- **See your matches.** Others ranked by overlap, with their full session list, the specific overlaps and their LinkedIn link.
- **Share it.** QR code, native share sheet, copy button. The QR is rendered server-side, so it works on venue wifi with no CDN in the loop; the screen stays awake on that tab.

---

## Stack

| Layer | What |
|---|---|
| Server | Node.js + Express, single `server.js` |
| DB | SQLite via `better-sqlite3`, WAL mode |
| Client | Vanilla HTML/CSS/JS in one `public/index.html` — no bundler, no transpiler |
| Identity | UUID token in `localStorage`, no auth |
| Hosting | Docker + Docker Compose, designed to sit behind a reverse proxy |

Both HTML pages are served through `renderHtml` in `server.js`, which substitutes `[App name]`, `[Share URL]`, `[Event name]`, `[Last updated]` and the `LEGAL_*` placeholders per request. Placeholders without a value stay visible as-is.

---

## Repo layout

```
.
├── server.js                     # Express server, API routes, SQLite setup
├── Dockerfile                    # Native deps in a build stage, lean runtime, non-root, healthcheck
├── docker-compose.yml            # /data volume, external proxy network
├── lib/
│   ├── board.js                  # Event registry, format adapters, live-source store
│   └── admin.js                  # /admin, mounted only when ADMIN_TOKEN is set
├── events/
│   ├── index.json                # Event registry
│   ├── uxchh26.json              # Empty — fallback for the live source
│   ├── uxce26.json               # Scraped Barcamp board
│   └── _example.session-plan.json
├── public/
│   ├── index.html                # The entire client
│   └── legal.html                # Imprint + privacy policy
├── Source-Backup/                # Raw scrape of the #uxce26 board, kept for reference
└── data/                         # SQLite DB + agenda snapshot (gitignored)
```

---

## Running it

```bash
npm install
npm run dev          # nodemon, or: npm start
```

Then open http://localhost:3000. With Docker: `docker compose up -d --build`.

Environment variables (all optional):

| Var | Default | What |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where `uxcamp.db` and the agenda snapshot live |
| `EVENT` | `default` from `events/index.json` | Which event this instance serves |
| `POLL_MS` | `60000` | How often the live agenda source is polled |
| `ADMIN_TOKEN` | — | Enables `/admin`. Unset means the routes do not exist |
| `PUBLIC_URL` | derived from the request | The URL shown and encoded into the QR code. **Set it behind a proxy** — otherwise the host comes from `X-Forwarded-Host`/`Host`, which the client controls; anything that is not a bare hostname falls back to `http://localhost` |
| `LEGAL_*` | — | `NAME`, `STREET`, `CITY`, `COUNTRY`, `EMAIL` — fill the imprint placeholders in `public/legal.html` |

`docker-compose.yml` expects an external network `public_proxymanager` (nginx-proxy-manager). To expose the port directly instead, drop the `networks` block and add a `ports: ["3000:3000"]` mapping. The container runs as non-root `app`, persists to a named volume at `/data`, and has a healthcheck against `/api/sessions`.

---

## API

JSON throughout. No auth: the token in the URL is the only credential, which is acceptable for the lifespan and threat model of a Barcamp side-project. There is deliberately no way to look up a token from a name.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | The normalised board for the active event, plus `event`, `format`, `days` and `version` |
| `GET` | `/api/users/:token` | Load profile by token |
| `POST` | `/api/users` | Create (no token in body) or update (token in body) |
| `GET` | `/api/matches/:token` | Other users ranked by session overlap |
| `GET` | `/qr.svg` | QR code for the app's public URL, as SVG |
| `GET` | `/admin` | Admin dashboard (only when `ADMIN_TOKEN` is set) |

---

## Admin

`/admin` manages the rows of the active event. It exists **only when `ADMIN_TOKEN` is set** — otherwise the routes are never registered and an unconfigured deployment answers 404, giving away nothing.

```bash
ADMIN_TOKEN=$(openssl rand -base64 24) docker compose up -d
```

Sign in with that token; it is then held in an `HttpOnly; SameSite=Strict` cookie scoped to `/admin` for 12 hours (`Secure` over https). `SameSite=Strict` is also the CSRF defence. Every response is `no-store` and `noindex`.

Login is limited to **three attempts per hour per IP and twenty in total**. `req.ip` only follows `X-Forwarded-For` when the connection came from a private address, otherwise rotating the header would make the per-IP limit free to skip. Both counters are checked *before* the token, so a correct token during a lockout is refused too. They live in memory — restarting the container is the way out if you lock yourself out. Basic Auth at the proxy is a cheap second layer.

What it does:

| | |
|---|---|
| **Participants** | Every row for the event, most recently updated first, with session count, token and inline **rename** |
| **Recovery link** | Copies `<app url>/?t=<token>`. Opening it signs that browser back in as them and strips the parameter from the URL — how you rescue someone whose browser lost its token. Send it to them and no one else |
| **Duplicates** | Rows sharing a name, normally one person whose browser lost its token. Merging keeps the most recently updated row, unions the session ticks, takes the first LinkedIn URL it finds, and deletes the rest |
| **Delete** | One row, for a deletion request |
| **Wipe** | Every row of the event, confirmed by typing the event id. The privacy policy promises this within 30 days |

---

## Data model

One table, `users`: `token` (TEXT PRIMARY KEY, server-generated UUID), `name`, `linkedin`, `sessions` (JSON array of session id strings), `event` (every query is scoped to it, so one database can hold several events), `updated_at`.

Matching is a set intersection on session ids within one event, sorted by overlap size and then by how many sessions the other person attended, so richer profiles surface higher on ties. Ids are compared as strings, so rows written before the format change (numeric ids) still line up.

**A deploy must not sign anyone out.** The container restarts on every push, and the token in `localStorage` is the only identity there is:

- A failed `/api/sessions` no longer takes the whole boot with it, and the event id (which namespaces the storage keys) falls back to the last one seen rather than to `default`.
- A failed profile lookup never clears the token — the browser stays signed in and retries on the next load.
- `POST /api/users` re-creates a missing row **under the token the browser sent**, when that is a well-formed UUID nobody holds. A lost volume costs one save instead of an identity.

Storage keys are namespaced `<key>:<event>`; the pre-namespace `_token`/`_name`/`_li`/`_picked` are adopted on boot. Two migration blocks at the top of `server.js` handle a pre-token `users` table and a table without the `event` column (existing rows default to `uxce26`); on a fresh database neither does anything.

---

## Session data

`events/index.json` is the registry — one entry per event, naming the data file, the display name and the event wording for `legal.html`. An entry may also carry a `source` URL, which then becomes the single source of truth and demotes `dataFile` to a fallback (see below).

```json
{
  "id": "uxchh26",
  "dataFile": "uxchh26.json",
  "name": "#uxchh26 Matchmaker",
  "title": "UXcamp Hamburg 2026",
  "hashtag": "#uxchh26",
  "legal": { "eventName": "UXcamp Hamburg 2026", "lastUpdated": "September 2026" },
  "source": "https://uxcamphh26.backplane.live/agenda.json"
}
```

The data is used **as exported** — `lib/board.js` picks an adapter by the payload's shape:

| Adapter | Recognised by | Used for |
|---|---|---|
| `barcamp-board-v1` | top-level `timeslots` array | The scraped `#uxce26` board: timeslots holding numbered sessions |
| `session-plan-v1` | top-level `entries` array | Session-plan export: flat entries with `startAt`/`endAt`, `room`, `host`, `kind` |

Both normalise to one canonical shape, so the client only ever sees one format:

```
{ event, format, version, days: [...], timeslots: [
  { id, date, label, time, kind: "sessions" | "programme",
    sessions: [ { id, number, title, type, host, room, description, selectable } ] } ] }
```

In `session-plan-v1`, entries sharing a `startAt` become one timeslot. Times and dates are read straight out of the ISO strings, so the event's local time survives any server timezone.

Everything beyond the session itself stays deliberately quiet, because ticking a session you sat in only needs its title:

- `"kind": "event"` entries (breaks, photo, wrap-up) are not selectable, render as a thin muted line and disappear while searching.
- `room` and `host` are one grey line under the title, to tell similar pitches apart.
- `number` comes from a `number`/`sessionNumber`/`no` field or a `#42` in front of the title (then stripped). A purely numeric query matches the number from the front: `4` finds #4 and #42, not "Top 4 mistakes".
- `description` is normalised but neither displayed nor searched.

**Adding an event:** point a registry entry at the agenda URL (or drop an export into `events/`) and set `EVENT`. **Adding a format:** add an adapter to `ADAPTERS` in `lib/board.js` — nothing else changes.

---

## Live source

A Barcamp board is not finished when the app goes up: sessions get pitched all morning while people are already ticking boxes. So when a registry entry has a `source`, the board is pulled from there.

`/api/sessions` always answers from memory — no request ever waits on the source, and the source being down never reaches a user. The store polls `source` every `POLL_MS` with the previous `ETag`, so an unchanged board costs a 304, and snapshots each accepted response to `DATA_DIR/<event>.agenda.json`.

**Boot order**, least fresh first, each step overwriting the last one that worked:

```
events/<dataFile>  →  DATA_DIR/<event>.agenda.json  →  live fetch
```

The server starts even if all three fail; the client then shows "the board isn't up yet". `events/uxchh26.json` is intentionally empty — it exists so a board can be pasted in by hand if the source is unreachable at a moment when it matters. Editing it has no effect while the source answers.

**Guards**, because this is third-party data on the critical path: 8s timeout, 2 MB cap, an adapter has to recognise the payload, and **a response with zero sessions never replaces a board that has some**. Losing the programme mid-event is much worse than serving one that is a minute stale.

**Client.** The page polls `/api/sessions` every 60s and compares `version`. On a change it re-renders in place — selections, search and scroll survive — and toasts how many sessions appeared; picks whose session was pulled from the board are dropped, with a toast saying so. Polling pauses while the tab is hidden and fires once when it comes back.

---

## Open items

Feature requests collected during and after the event: speaker names and room names on session cards (originally omitted for privacy), profile picture from LinkedIn, a clearer affordance that the match card links to LinkedIn, topics/session history across years, search within matches, a map of participants by LinkedIn location, and a dedicated "your match card" view separate from the editable list.

Known bug: a duplicate row can appear after closing the tab — `/admin` merges them.
