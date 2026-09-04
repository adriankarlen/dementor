# Implementation plan

Working plan for building the self-hosted app decided in `AGENTS.md`
("Decided architecture"). Phased so each step produces something
runnable/testable rather than one big build. Update this file as phases
complete or plans change — it's meant to stay accurate, not be a
snapshot.

## Before Phase 0: one repo-layout decision

SvelteKit's own convention wants `src/routes/`, `src/lib/`, etc. at the
repo root. This repo's `src/` currently holds the two `.user.js`
userscript files, which would collide.

**Proposed**: `git mv src/ userscript/` (preserves history), freeing up
`src/` for the SvelteKit app at the repo root — no separate `app/`
subdirectory, no nested project. Doing this as the first step of Phase 0
unless you'd rather keep the userscript files where they are and put the
new app in a subdirectory instead.

## Phase 0 — scaffold

- `npx sv create` (or equivalent) at repo root: SvelteKit, TypeScript,
  `@sveltejs/adapter-node`.
- Tailwind CSS v4 via its Vite plugin (no PostCSS config needed for v4).
- `shadcn-svelte` init, then pull in `neobrutalism-svelte` components
  one at a time as the UI needs them (not all up front).
- `node:sqlite` — no ORM, raw SQL (matches the "cache, not a real
  database" framing in `AGENTS.md`). One `src/lib/server/db.ts` module
  opening the file and exposing prepared statements.
- `.env.example` documenting required vars (session secret, credential
  encryption key, InfoMentor isn't in here — those are per-parent and
  entered through the app itself, not env vars).
- **Done when**: `npm run dev` serves an empty SvelteKit page, and a
  throwaway script can open the SQLite file and run a query.

## Phase 1 — dashboard auth ⛔ superseded

Built as planned (`users` + `sessions` tables, scrypt hashing, login
form, logout, `hooks.server.ts` gate, `tools/create-user.ts` CLI),
verified end-to-end, and then deliberately removed during the Phase 2
work. The reasoning: the dashboard password wasn't gating anything the
InfoMentor password wasn't already gating (anyone with the IM password
can see the kids' data directly on hub.infomentor.se; the dashboard
just presents the same data in a nicer UI). Two passwords were
friction without security.

The infrastructure still exists in git history if you want to revive
it (`git log --diff-filter=D --name-only -- 'src/lib/server/auth/*'
'tools/create-user.ts'`). For the current design, see Phase 2 below.

## Phase 2 — InfoMentor login (no separate dashboard auth) ✅

## Phase 2 — InfoMentor login (no separate dashboard auth) ✅

The current design has **no dashboard user accounts**. The InfoMentor
username/password entered on the login form is the only credential;
the dashboard session is just an opaque random token whose only
meaning is "look up the InfoMentor cookie jar in memory."

- Login form: InfoMentor username + password (two fields, no
  "Dashboard" group).
- On submit:
  1. Run the InfoMentor login dance (port of `tools/probe-login.ts`
     into `src/lib/server/infomentor/login.ts`) with the creds from
     the form.
  2. Mint a random UUID, store it as the session token. Attach the
     resulting InfoMentor cookie jar to that token in a module-level
     `Map<sessionToken, InfoMentorSession>`, where
     `InfoMentorSession = { username, cookieJar, loggedInAt, lastUsedAt }`.
     Single-process, in-memory only — no row in the DB.
  3. Set the session cookie (HttpOnly, SameSite=Lax, Secure in prod,
     no `expires` — lives until logout or server restart).
  4. Redirect to `/`. Section pages trigger their own fetches in
     Phase 3.
- When InfoMentor's own session expires mid-dashboard-session, the
  next API call throws a typed `InfoMentorSessionExpiredError`. The
  frontend catches it and shows a small "InfoMentor-sessionen har
  gått ut, logga in igen" panel that takes only the InfoMentor
  password (dashboard session stays alive). On submit, the
  InfoMentor login dance runs again with the same stored username,
  cookie jar is replaced in the map, and the original request
  retries.
- On `/logout` POST, delete the entry from the InfoMentor-session
  map and clear the cookie.
- `src/lib/server/infomentor/` holds the single source of truth for
  the HTTP layer (`cookieJar.ts`, `httpClient.ts`, `htmlForms.ts`,
  `login.ts`, `session.ts`, `errors.ts`, `types.ts`, `index.ts`).
  `tools/probe-login.ts` calls into `login.ts` — same code path.
- **Done when**: a parent can log in, see the InfoMentor username
  confirmed on the dashboard ("Inloggad på InfoMentor som
  <username>"), and log out cleanly.

Verified end-to-end: login form has only the two InfoMentor fields;
unauthed `/` redirects to `/login`; correct IM creds → 303 with
session cookie + dashboard renders greeting with username; logout
clears the map entry and cookie; wrong creds surface InfoMentor's
own localized rejection message verbatim.

## Phase 3 — per-section cache + fetch-on-demand ✅

Same SQLite, different lifecycle. The cache is the source of truth
for what the dashboard renders; InfoMentor is a fetcher that appends
to it. Per-section cache tables with composite primary keys so the
append-only invariant is enforced by the schema:

- `pupils (switch_id PRIMARY KEY, display_name, last_seen_at)` —
  discovered per session by scraping the pupil-switcher page.
- `learnlog_entries (pupil_switch_id, entry_id, json, synced_at)`
  PRIMARY KEY (pupil_switch_id, entry_id).
- `calendar_entries (pupil_switch_id, entry_id, json, synced_at)`
  PRIMARY KEY (pupil_switch_id, entry_id).
- `news_entries (entry_id, json, synced_at)` PRIMARY KEY (entry_id) —
  news is global per parent, not per pupil, per `docs/api-notes.md`.
- `documents (entry_id, json, synced_at)` PRIMARY KEY (entry_id).

No `infomentor_credentials` table, no encryption code.

Fetch behaviour, per the agreed "lazy with cached data + refresh
signal" model:

- On first navigation to a section, fire the fetch in the background;
  the page renders immediately from cache and shows a "Hämtar
  senaste…" indicator that clears when the fetch resolves.
- Per-section "latest only" strategy, leveraging the existing
  per-ID monotonicity from `docs/api-notes.md`:
  - **Lärlogg**: GET page 1, pageSize 10. While the highest entry
    seen in the response isn't already in the cache, fetch the next
    page. Stop on first hit. (Same algorithm the existing userscript
    uses.)
  - **Calendar**: fetch current month + previous month (timezone
    safety), upsert by entry_id. Small windows, no need for ID tricks.
  - **News**: full refetch (`pageSize: -1` per the API notes),
    upsert by id. List is ≤12 items, cheap.
  - **Documents**: full refetch, same shape as news.
- Cache is **append-only**: never delete on fetch. If InfoMentor
  deletes a Lärlogg post after we cached it, we keep showing the stale
  copy. Acceptable for the scale here; revisit if it bites.

Multi-pupil aggregation:

- On first nav to a section, fetch for **every** pupil the current
  parent can see (per the `pupils` table populated by the
  switcher-page scrape during Phase 2 login). Switch pupils
  programmatically via `GET /Account/PupilSwitcher/SwitchPupil/{id}`
  per `docs/api-notes.md`.
- Unified views across pupils:
  - **Lärlogg**: all entries from all pupils, sorted by `id` desc,
    tagged with a pupil label so two kids' posts on the same day
    stay distinguishable. No per-kid tab — single feed, both kids
    interleaved.
  - **Calendar**: all entries from all pupils, grouped by day, each
    entry tagged with its pupil label.
  - **News** / **Documents**: union across pupils, deduped by id.

If a parent's InfoMentor login only sees one pupil but the household
has two kids, the other parent's login will fill in the missing
pupil on their next login. Both parents write to the same shared
cache, so the second parent's fetch naturally extends the first
parent's.

- **Done when**: from a single dashboard login, navigating to
  Lärlogg / Kalender / Nyheter / Documents shows entries from every
  pupil this parent's InfoMentor account can access, with a
  "Hämtar senaste…" indicator during the refresh; cache survives
  logout; a second parent logging in after the first sees their
  own additional pupils and their entries merged in.

## Phase 4 — media caching

- On cache write of a Lärlogg entry that has media, download each
  new media item's bytes to disk (`media/<fileId>.<ext>`),
  recorded in a `media` table (file_id → local path, content type,
  pupil_switch_id + entry_id so a delete of the entry can clean up
  its media later — though with append-only cache this is rare).
- A SvelteKit route serves these files with correct `Content-Type`
  and cache headers.
- Respect the confirmed constraint: use `thumbnailUrl`/`fileUrl`
  exactly as InfoMentor returns them, never rewritten (see
  `docs/api-notes.md`).
- **Done when**: a cached Lärlogg post's photos load from local
  disk, not from InfoMentor, on every view after the first fetch.

## Phase 5 — frontend UI

- Section pages for Lärlogg / Kalender / Nyheter / Documents with
  the "cached data + refreshing indicator" pattern from Phase 3.
  No per-kid tab — single unified feed per section with a small
  pupil label per entry.
- Lärlogg `text` and news `content` render via `{@html}` (they're
  confirmed pre-formatted HTML from InfoMentor, not user input
  needing escaping — see `AGENTS.md`).
- Calendar grouped by day; photo/video lightbox for Lärlogg media.
- Reference `userscript/dashboard.user.js`'s visual design for
  inspiration per the earlier decision, not a direct port.
- **Done when**: you can browse both kids' Lärlogg, calendar, and
  news from a phone browser, end to end, against real fetched data.

## Phase 6 — deployment

- VPS provisioning (provider still TBD, per `AGENTS.md`).
- `adapter-node` build (`node build/index.js`), kept alive via systemd
  (or similar) so it survives reboots.
- Caddy reverse proxy on the chosen subdomain, automatic HTTPS.
- **Done when**: the dashboard is reachable over HTTPS on your phone,
  outside your home network, behind its own login.
