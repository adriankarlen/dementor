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
  works** for this account — this removes that obstacle entirely and is
  why the project is now pivoting to a proper self-hosted app instead of
  a browser-only trick.

## Current state

Two things exist in this repo so far:

1. **A working Tampermonkey userscript** (`userscript/*.user.js`) that runs
   directly on hub.infomentor.se, riding on the browser's existing login
   session, fetching InfoMentor's internal JSON endpoints and rendering
   a custom dashboard (IndexedDB cache, neobrutalist UI). This works
   today, but only in the one browser where you're already logged in —
   no phone access, no background sync, and it stops working the moment
   that browser's session expires.

2. **An early start on a self-hosted server** (`server/`) — a
   cookie-jar-based HTTP client with no framework, started before
   agreeing on the approach. It's since been evaluated (see "Decided
   architecture" below): `server/lib/cookieJar.js` and `httpClient.js`
   are being kept and ported into the new SvelteKit server code
   (translated to TS) as the basis for talking to InfoMentor — solid,
   dependency-free, framework-agnostic groundwork. The rest of
   `server/` predates the framework decision and will be rebuilt under
   SvelteKit's own project structure.

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

## What's wanted next

A self-hosted web app (not just a browser userscript) that:

- Logs into InfoMentor itself, using username/password — no BankID, no
  dependency on a live browser session.
- Is usable from a phone as well as desktop (this is a hard requirement
  from the human, not a nice-to-have).
- Presents Lärlogg posts, the calendar, and the newsletter in a nicer,
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
  `hub.infomentor.se/`. `tools/probe-login.ts` handles this generically
  by looping on relay-page-detection rather than assuming a fixed hop
  count, and confirms authentication by successfully calling
  `communication/communication/appData` afterward. See that file for
  the full flow notes and `tools/lib/` for the reusable HTTP/cookie/HTML
  helpers (ported from `server/lib/`) it's built on.

## Repo layout

```
userscript/*.user.js  Working browser userscript (capture tool + dashboard)
docs/api-notes.md     Confirmed InfoMentor API reference
tools/shape.js        Capture analysis helper (structure only, no personal data)
captures/             Gitignored — personal capture exports
server/               Early backend start; lib/ (cookie jar, http client) is being
                      ported into the new SvelteKit app, rest will be rebuilt there
tools/probe-login.ts  Standalone script confirming the InfoMentor login flow;
                      run locally with real credentials, see file header
tools/lib/            Ported cookie jar / http client / HTML-scraping helpers
                      used by tools/probe-login.ts (and, later, the app itself)
```
