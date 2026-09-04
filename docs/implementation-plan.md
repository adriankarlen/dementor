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

## Phase 1 — dashboard auth (you + your wife) ✅

- `users` table: id, username (UNIQUE COLLATE NOCASE), display_name,
  password_hash, password_salt, created_at.
- `sessions` table: opaque random token (256 bits), user_id, expires_at.
  Simpler than a signed cookie scheme — the cookie just carries the
  token, validity is a DB lookup, no JWT/signing library needed.
- Password hashing via Node's built-in `crypto.scrypt` (per-user salt,
  timing-safe verification).
- Login form (username + password), logout (POST only — no GET so a
  stray `<img src>` can't log you out), `hooks.server.ts` redirecting
  unauthenticated requests to `/login` (with a `?redirect=` param so
  the post-login redirect lands back on the original page).
- Open-redirect protection: only same-origin paths accepted as the
  post-login `redirect=` value; `//evil` and `https://evil` are
  rejected.
- `tools/create-user.ts` CLI to create the two accounts, with a
  `CREATE_USER_UPDATE=1` flag to rotate a password. Interactive (TTY
  prompts) or non-interactive (env vars). In non-TTY mode the script
  refuses to silently fall back to prompts and instead errors with the
  missing env var name.
- **Done when**: the app is fully login-gated and you and your wife each
  have a working account.

Verified end-to-end against the running dev server: unauthed `/` → 303
to `/login?redirect=%2F`; successful POST `/login` → 303 with
`HttpOnly; SameSite=Lax` (and `Secure` in production builds) cookie;
authenticated GET / → renders greeting; `/logout` POST → cookie
cleared and session row deleted; expired/tampered tokens rejected and
their cookies cleared on the next request.

## Phase 2 — InfoMentor account linking

- `infomentor_credentials` table: user id, InfoMentor username,
  encrypted password (AES-256-GCM: iv + ciphertext + auth tag), keyed by
  a server-side master key from an env var.
- Settings page: each parent enters their own InfoMentor username/
  password once.
- "Test connection" action reusing the confirmed login flow from
  `tools/probe-login.ts` (ported into `src/lib/server/infomentor/` as
  real app code, not a standalone script anymore) — reports success/
  failure without ever displaying the stored password again.
- **Done when**: both of you can link your real InfoMentor accounts
  through the UI and get a clear success/failure result.

## Phase 3 — InfoMentor client + sync core

- Port `tools/lib/{cookieJar,httpClient}.ts` into
  `src/lib/server/infomentor/` as the shared HTTP layer.
- Implement the endpoints from `docs/api-notes.md`: pupil switch,
  `appData`, Lärlogg, calendar, news, documents.
- Pupil registration: try auto-discovering each parent's accessible
  pupils by scraping the pupil-switcher links from an authenticated
  page (same `/Account/PupilSwitcher/SwitchPupil/{id}` pattern the
  userscript's README has you find manually) — if that doesn't pan out
  cleanly, fall back to the userscript's manual "paste the switch ID"
  settings flow.
- Sync orchestrator, run per parent (per `AGENTS.md`): log in, switch to
  each registered pupil, pull each section, upsert into the cache
  tables (JSON blob + `synced_at`, not a normalized schema).
  Detect "already synced" the same way the userscript does — Lärlogg
  `id` is monotonically increasing, no need to parse the Swedish date
  strings.
- Session-expiry detection (mirroring the userscript's) so a failed
  sync produces a clear error, not a silent gap.
- **Done when**: a manual "sync now" pulls real data for both kids into
  SQLite, for both parents' logins independently.

## Phase 4 — media caching

- On sync, download each new media item's bytes to disk
  (`media/<fileId>.<ext>`), tracked in a small `media` table (fileId →
  local path, content type, which entry it belongs to).
- A SvelteKit route serves these files with correct `Content-Type` and
  cache headers.
- Respect the confirmed constraint: use `thumbnailUrl`/`fileUrl` exactly
  as InfoMentor returns them, never rewritten.
- **Done when**: a synced Lärlogg post's photos load from local disk,
  not from InfoMentor, on every view after the first sync.

## Phase 5 — frontend UI

- Per-kid tabs, section tabs (Lärlogg / Kalender / Nyheter / Documents),
  built with `neobrutalism-svelte` components pulled in as needed.
- Lärlogg `text` and news `content` render via `{@html}` (they're
  confirmed pre-formatted HTML from InfoMentor, not user input needing
  escaping — see `AGENTS.md`).
- Calendar grouped by day; photo/video lightbox for Lärlogg media.
- Reference `src/dashboard.user.js`'s (now `userscript/dashboard.user.js`)
  visual design for inspiration per the earlier decision, not a direct
  port.
- **Done when**: you can browse both kids' Lärlogg, calendar, and news
  from a phone browser, end to end, against real synced data.

## Phase 6 — sync scheduling

- Start manual-only ("Sync now" button) through Phases 0–5 — simplest,
  avoids background-job complexity while everything else is still
  moving.
- Once stable: an interval timer inside the long-running `adapter-node`
  process (no external cron needed) triggering sync automatically, e.g.
  every N hours per parent.
- **Done when**: data refreshes on its own without you remembering to
  click sync, and a failed background sync surfaces somewhere visible
  in the UI rather than failing silently.

## Phase 7 — deployment

- VPS provisioning (provider still TBD, per `AGENTS.md`).
- `adapter-node` build (`node build/index.js`), kept alive via systemd
  (or similar) so it survives reboots.
- Caddy reverse proxy on the chosen subdomain, automatic HTTPS.
- **Done when**: the dashboard is reachable over HTTPS on your phone,
  outside your home network, behind its own login.

## Open questions to confirm before Phase 0 starts

1. Confirm the `src/` → `userscript/` rename (or tell me the
   alternative you'd prefer).
2. Anything in this plan you want reordered, split up further, or
   dropped for a v1?
