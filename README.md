# infomentor-dashboard

A personal userscript that replaces InfoMentor's slow web UI with a fast,
locally cached view of your kids' Lärlogg posts, calendar, and newsletters.

Runs entirely in your browser as a userscript on `hub.infomentor.se`. No
server, no cron job, no BankID automation — it rides on the normal login
session you already have after signing in with BankID.

## Why a userscript and not a separate website

A userscript executes as part of the real `hub.infomentor.se` page, so its
`fetch()`/XHR calls are same-origin: no CORS blocking, no cookie
`SameSite` issues. A separately hosted site trying to call InfoMentor's
API directly would hit both of those walls.

## Status: Phase 1 — capture / discovery

InfoMentor's actual API endpoints may have changed since any of the old
reverse-engineering projects were written, and testing requires a real
BankID-authenticated session I don't have. So step one is a script that
**only observes** — it logs every network call InfoMentor's own frontend
makes, without changing anything on the page.

Once we've seen the real endpoint shapes (Lärlogg entries, calendar,
newsletter, pupil switching, media URLs), Phase 2 replaces this with the
actual fetch + render + IndexedDB cache dashboard.

## Install (Phase 1)

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension (Chrome, Firefox, Edge all supported).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the placeholder content and paste in the contents of
   [`src/capture.user.js`](src/capture.user.js).
4. Save (`Cmd+S`).
5. Visit `https://hub.infomentor.se` and log in as usual.

You should see a small **"🧰 IM Capture"** button in the bottom-right
corner of the page.

## Usage

1. Click around the site like you normally would:
   - Open **Lärlogg**, open a single post if that navigates anywhere.
   - Switch to your other child (top right).
   - Open **Kalender**.
   - Open **Information** (the monthly newsletter).
   - Scroll down lists to trigger pagination/"load more".
2. Click the **🧰 IM Capture** button to open the log panel.
3. Optionally filter by URL to narrow things down.
4. Click **Export JSON** to download the captured log.

## ⚠️ Before sharing the export

The captured log will contain real content from your kids' feed —
names, text, photo/video URLs, possibly class/group names. Don't commit
the raw export to this repo (the `captures/` folder is gitignored for
this reason) and don't paste it somewhere public.

When sharing findings back for Phase 2, either:
- redact names/personal text and just share the **structure** (field
  names, endpoint paths, pagination shape), or
- describe what you see and I'll infer the shape from that.

## Repo layout

```
src/capture.user.js   Phase 1 userscript (network capture + log viewer)
captures/             Local scratch space for your exported JSON (gitignored)
```

## Roadmap

- [x] Phase 1: capture real endpoint shapes
- [ ] Phase 2: implement real fetch/parse logic for Lärlogg, calendar, news, pupil switching
- [ ] Phase 2: IndexedDB schema for entries + media metadata
- [ ] Phase 2: media caching strategy (thumbnails in IndexedDB, larger media via Cache API)
- [ ] Phase 2: dashboard UI (per-child tabs, "new" indicators, calendar view)
- [ ] Phase 2: session-expired detection + re-login prompt
