# #uxce26 Matchmaker

A web app for attendees of **UX Camp Europe 2026** to find each other based on which sessions they went to. Each participant picks the sessions they attended, optionally adds a LinkedIn URL, and the app ranks other participants by how many sessions they have in common.

Live during the event (and for ~30 days after) at **https://uxce26.jona.one**. After that, per the privacy policy, all participant data is wiped.

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

---

## Stack

| Layer | What |
|---|---|
| Server | Node.js + Express, single `server.js` |
| DB | SQLite via `better-sqlite3`, WAL mode |
| Client | Vanilla HTML/CSS/JS in one `public/index.html`, served to the browser as-is (no bundler, no transpiler) |
| Identity | UUID token in `localStorage`, no auth |
| Hosting | Docker + Docker Compose, designed to sit behind a reverse proxy |

**Session data** in `uxcamp2026_sessions.json` was scraped from https://planner.berlin/board with AI assistance and frozen for this event. For future runs this step can be detached from the source, generalised across events, and automated further.

---

## Repo layout

```
.
├── server.js                     # Express server, API routes, SQLite setup
├── package.json
├── Dockerfile                    # Builds native deps in a first stage, then copies into a lean runtime image; runs as a non-root user, with a healthcheck
├── docker-compose.yml            # Volume for /data, expects external proxy network
├── uxcamp2026_sessions.json      # The Barcamp board (timeslots × sessions)
├── public/
│   ├── index.html                # The entire client
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
| `GET` | `/api/sessions` | The Barcamp board |
| `GET` | `/api/users/:token` | Load profile by token |
| `GET` | `/api/users/search/:name` | Case-insensitive exact-name lookup (server endpoint exists; not currently used by the client) |
| `POST` | `/api/users` | Create (no token in body) or update (token in body) |
| `GET` | `/api/matches/:token` | Other users ranked by session overlap |

---

## Data model

One table, `users`:

| Column | Type | Notes |
|---|---|---|
| `token` | TEXT PRIMARY KEY | UUID, server-generated |
| `name` | TEXT NOT NULL | Free text |
| `linkedin` | TEXT | Optional URL |
| `sessions` | TEXT | JSON array of session numbers (`number` field from `uxcamp2026_sessions.json`) |
| `updated_at` | TEXT | `datetime('now')` |

Matching is a set intersection on session numbers, sorted by overlap size and then by how many sessions the other person attended (so richer profiles surface higher on ties).

There's a small migration block at the top of `server.js` that drops an older `users` table (from before tokens existed) if it finds one. On a fresh database it doesn't run.

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
