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

1. **A working Tampermonkey userscript** (`src/*.user.js`) that runs
   directly on hub.infomentor.se, riding on the browser's existing login
   session, fetching InfoMentor's internal JSON endpoints and rendering
   a custom dashboard (IndexedDB cache, neobrutalist UI). This works
   today, but only in the one browser where you're already logged in —
   no phone access, no background sync, and it stops working the moment
   that browser's session expires.

2. **An early, incomplete, unreviewed start on a self-hosted server**
   (`server/`) — a cookie-jar-based HTTP client, no framework chosen
   yet. This was started before agreeing on the approach with the human
   and should **not** be treated as a decided direction. A future
   session should evaluate whether to keep, adapt, or throw it away.

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

## Explicit non-decisions (as of this note)

Nothing about the implementation is locked in. All of the following
should be discussed and decided at the start of the next working
session, not assumed:

- Language/runtime and framework for the backend.
- Storage (database vs. flat files, etc).
- Where this runs (local machine, home server/NAS, something else) and
  how it's reachable from a phone (same network? something more?).
- Whether to keep, adapt, or discard the `server/` folder's current
  contents.
- Whether/how much of the existing userscript's UI, CSS, and rendering
  logic gets reused for the new frontend.
- Auth for accessing the dashboard itself (does anyone on the home
  network get in, or does it need its own login?).

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
- The **username/password login flow has not been reverse-engineered or
  confirmed yet**. An old (~2019) script implementing a password login
  flow was found during research, but should not be ported blindly —
  treat its exact steps/field names as unverified and confirm
  empirically (e.g., fetch the real login page and inspect its actual
  form fields) rather than guessing from a stale script.

## Repo layout

```
src/*.user.js       Working browser userscript (capture tool + dashboard)
docs/api-notes.md   Confirmed InfoMentor API reference
tools/shape.js       Capture analysis helper (structure only, no personal data)
captures/            Gitignored — personal capture exports
server/              Early, unreviewed, incomplete backend start — not a decided direction
```
