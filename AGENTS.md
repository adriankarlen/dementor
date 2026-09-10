# AGENTS.md

## What this project is

A personal tool for viewing InfoMentor (the Swedish preschool/school
communication platform at hub.infomentor.se) in a faster, nicer way than
InfoMentor's own website — for two kids, on both desktop and phone.

## Background

- InfoMentor's own site is slow, especially loading the photos/videos
  attached to daily "Lärlogg" (learning log) posts.
- What we're consuming from it: daily Lärlogg posts (text + photos/videos
  per kid), a monthly newsletter ("Nyheter"), a shared calendar
  ("Kalender"), and a documents section.
- Login was originally assumed to require BankID (Swedish e-ID), which
  makes any kind of unattended/background access hard (BankID needs a
  live phone approval). It turns out **username/password login also
  works** for this account — this removed that obstacle and made the
  self-hosted app possible without a live browser session.

## Current state

1. **The self-hosted SvelteKit app** (`src/`) is the main implementation.
   It logs into InfoMentor, caches section data in SQLite, and serves
   desktop and phone views. Lärlogg publishes recent posts incrementally
   and fetches older history only on demand. Media is cached on disk;
   videos use byte ranges and can be repaired to MP4 after playback fails.
   See `docs/learnlog-loading.md` for the current behavior and regression tests.

2. **The working Tampermonkey prototype** (`userscript/*.user.js`) is
   retained as a reference and capture tool. It runs directly on
   hub.infomentor.se using that browser's existing login session and an
   IndexedDB cache; it is not the backend for the SvelteKit app.

The HTTP/cookie helpers have been ported to TypeScript in
`src/lib/server/infomentor/`. The app and manual tools share that
implementation. The obsolete JavaScript copies under `server/` and the
intermediate `tools/lib/` copies are no longer part of the source tree.

Also in the repo:

- `docs/api-notes.md` — InfoMentor's real internal API endpoints
  (Lärlogg, calendar, news, documents, pupil switching), confirmed
  against a live network capture. This is durable, stack-independent
  knowledge worth keeping regardless of what gets built next.
- `tools/shape.js` — a dev tool that summarizes a network capture
  file's *structure* (field names, endpoint shapes) without echoing
  personal content, safe to share/inspect.
- `captures/` — gitignored; personal capture exports go here, never
  committed.

## Product requirements

The self-hosted app must:

- Log into InfoMentor itself, using username/password — no BankID, no
  dependency on a live browser session.
- Be usable from a phone as well as desktop (this is a hard requirement
  from the human, not a nice-to-have).
- Present Lärlogg posts, the calendar, and the newsletter in a nicer,
  faster way than the real site, with photos/videos loading quickly.

There is **no constraint against using normal dependencies** — an
earlier pass over-indexed on a zero-dependency server for its own sake;
that was not requested and shouldn't be repeated. Pick whatever's
simplest and well-supported.

## Decided architecture

Decided in the session that started the self-hosted rebuild. Treat
these as settled unless a future session explicitly revisits them.

- **Language/framework**: TypeScript on Node, using **SvelteKit** with
  `adapter-node` (self-hosted, long-running process — *not*
  `adapter-vercel`/serverless, whose ephemeral filesystem is
  incompatible with a local SQLite file or on-disk media cache;
  confirmed, not assumed).
- **Storage**: SQLite via Node's built-in **`node:sqlite`** (no extra
  dependency). Used loosely, closer to a KV/cache store than a
  normalized schema — one table per section (Lärlogg, calendar, news,
  documents) holding the synced JSON plus a `synced_at` timestamp, since
  this is fundamentally a rebuildable cache of InfoMentor's own API
  responses, not a source of truth. **Media files (photos/videos) live
  as plain files on disk**, not in the database — that's the part that
  actually needs to load fast.
- **UI kit**: [`neobrutalism-svelte`](https://neobrutalism-svelte.flenze.com)
  (built on `shadcn-svelte` + Tailwind CSS v4), components added
  individually via the `shadcn-svelte` CLI as needed.
- **Dashboard auth**: *none.* The InfoMentor login IS the auth —
  see the next bullet. No `users` table, no `sessions` table, no
  password hashing, no `pnpm create-user`. The only credential is
  the parent's InfoMentor password, entered on the dashboard login
  form.
- **InfoMentor auth**: each parent enters their InfoMentor
  username/password on the login form. The dance runs immediately;
  what persists for the lifetime of the dashboard session is the
  resulting InfoMentor session cookie, held in process memory only
  (a module-level `Map<sessionToken, InfoMentorSession>`), keyed by
  an opaque random session token held as an HttpOnly cookie. No
  separate dashboard password, no encrypted credential table, no
  master key. On logout, the in-memory entry is dropped. If
  InfoMentor's own session expires mid-session, the next call throws
  a typed error and the UI prompts for the InfoMentor password
  again. Both parents' fetches go into the same shared on-disk
  cache, so a parent whose InfoMentor login only sees one pupil
  still benefits from another parent's fetch covering the other
  pupil. **No background scheduled sync** — the cache is populated
  on first nav to each section, on demand, with cached data shown
  immediately.
- **Hosting**: a small VPS (provider not yet chosen — a separate,
  later task), reached over HTTPS via a reverse proxy (Caddy, for its
  automatic certificate handling) on a subdomain of an existing domain.
  **Tailscale was considered and ruled out**: it needs the client app
  installed on every device, including the phone, and the target phone
  is company-managed (MDM), which typically blocks installing VPN
  profiles/apps. Since the dashboard is internet-facing rather than
  VPN-gated, its own login (above) is the real security boundary.
- **Userscript reuse**: `userscript/dashboard.user.js`'s visual design/CSS may
  be used for inspiration, but the rendering logic will be rebuilt
  against a real backend API instead of IndexedDB — not a direct port.

Still open, deliberately deferred rather than decided:

- Which VPS provider, and exact provisioning/deployment steps.

## Hard-won facts about InfoMentor (keep respecting these regardless of stack)

- InfoMentor uses at least three unrelated ID schemes for the same
  pupil (see `docs/api-notes.md`) — the pupil-switcher ID is the one
  obtainable without already being logged in as that pupil.
- The Lärlogg media thumbnail endpoint only serves pre-generated sizes;
  requesting an arbitrary width/height returns `200 OK` with an empty
  body, not an error. Don't rewrite thumbnail URLs.
- Lärlogg entry `text` (and news `content`) are pre-formatted HTML from
  InfoMentor, not plain text — render accordingly, don't HTML-escape
  them.
- Media URLs are same-origin relative paths on hub.infomentor.se. From
  inside a browser page this meant no CORS issues; from a server making
  its own HTTP requests, CORS/CSP mostly don't apply at all, but this
  should be reconfirmed once real requests are flowing.
- The username/password login flow is **fully confirmed** (2026-09-04,
  verified against a real account via `tools/probe-login.ts`):
  `hub.infomentor.se` redirects to an auto-submitting relay form that
  hands an `oauth_token` off to `infomentor.se/swedish/production/mentor/`,
  which serves a classic ASP.NET WebForms login page. Confirmed field
  names: `login_ascx$txtNotandanafn` (username), `login_ascx$txtLykilord`
  (password), `login_ascx$btnLogin` (submit) — plus the usual
  `__VIEWSTATE`/`__VIEWSTATEGENERATOR`/`__EVENTVALIDATION` hidden fields,
  which must be scraped fresh per request, not hardcoded. On success,
  the flow relays **twice** — login lands back on `hub.infomentor.se`,
  but that page is itself another auto-submit relay (fresh `oauth_token`)
  back through `infomentor.se`, which finally lands authenticated on
  `hub.infomentor.se/`. `src/lib/server/infomentor/login.ts` loops on
  relay-page detection rather than assuming a fixed hop count, and
  confirms authentication by successfully calling
  `communication/communication/appData` afterward. `tools/probe-login.ts`
  calls this same implementation for manual checks. The reusable
  HTTP/cookie/HTML helpers live alongside `login.ts`.

## Repo layout

```
src/routes/                 SvelteKit pages and authenticated API/media routes
src/lib/server/             SQLite cache, section sync, media and video handling
src/lib/server/infomentor/   Shared login, HTTP, cookie and session helpers
userscript/*.user.js        Browser prototype and capture tool
docs/api-notes.md           Confirmed InfoMentor API reference
docs/learnlog-loading.md    Current loading/media behavior and regression tests
tools/probe-login.ts        Manual login check using the app implementation
tools/check-*.ts            Backend and browser regression checks
tools/fixtures/             Synthetic test media
tools/shape.js              Capture analysis helper (structure only)
captures/                   Personal capture exports (gitignored)
data/                       Rebuildable SQLite and media cache (gitignored)
```
