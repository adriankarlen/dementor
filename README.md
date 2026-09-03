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

## Status: Phase 2 — real dashboard

Phase 1 (a passive network-capture userscript) confirmed the real,
current API endpoints against a live session, so Phase 2 builds against
ground truth instead of guessing at old, possibly-stale endpoint names.
See [`docs/api-notes.md`](docs/api-notes.md) for the confirmed endpoint
reference.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension (Chrome, Firefox, Edge all supported).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the placeholder content and paste in the contents of
   [`src/dashboard.user.js`](src/dashboard.user.js).
4. Save (`Cmd+S`).
5. Visit `https://hub.infomentor.se` and log in as usual.
6. Click the **📋 Dashboard** button, bottom-right, and add each child
   under the ⚙️ settings screen (see below for how to find their ID).

If you still have `src/capture.user.js` installed from Phase 1, disable
it — no need to run both at once. Keep the file around; it's handy if
InfoMentor changes something and we need to re-capture.

## Adding a child

InfoMentor uses more than one ID scheme for the same child. The one
the dashboard needs is the **pupil switcher ID**:

1. On the real InfoMentor site, click the user/pupil icon top-right.
2. Right-click a child's name in the dropdown → **Inspect**.
3. Find the link — it looks like
   `/Account/PupilSwitcher/SwitchPupil/1234567`. The number at the end
   is the switch ID.
4. In the dashboard's ⚙️ settings screen, add the child's name and that
   ID.

Do this once per child (switch to the other one first so *their* name
shows up as a clickable link in the dropdown, then repeat).

## Usage

Hit **🔄 Sync**. The dashboard flips through each configured child
(using the switch-pupil call), pulls Lärlogg, calendar, newsletters and
documents for each, and caches everything — including media — in
IndexedDB / the Cache Storage API. Browsing afterwards is instant and
doesn't touch InfoMentor's servers again until you sync.

## Capturing more data (only if something breaks or is missing)

If a section stops working or we need to learn a new endpoint, re-enable
`src/capture.user.js`, click around the relevant part of the real site,
export the JSON from the 🧰 panel into `captures/`, and run:

```
node tools/shape.js captures/<file>.json [urlSubstring]
```

This prints the *structure* of requests/responses (field names, types)
without echoing personal text, safe to share.

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
src/capture.user.js    Phase 1 userscript (network capture + log viewer)
src/dashboard.user.js  Phase 2 userscript (the real dashboard)
tools/shape.js         Dev tool: structural (non-personal) summary of a capture file
captures/              Local scratch space for exported JSON (gitignored)
docs/api-notes.md      Confirmed endpoint reference
```

## Roadmap

- [x] Phase 1: capture real endpoint shapes
- [x] Phase 2: fetch/parse logic for Lärlogg, calendar, news, documents, pupil switching
- [x] Phase 2: IndexedDB schema for entries + media metadata
- [x] Phase 2: media caching via Cache Storage API, lazy-loaded thumbnails
- [x] Phase 2: dashboard UI (per-child tabs, section tabs, calendar day-grouping)
- [x] Phase 2: session-expired detection
- [ ] "New since last visit" badges per section
- [ ] Confirm `fileType` values beyond "Image" (video rendering is implemented but unverified)
- [ ] Learn `learnLogType` filter values (currently hardcoded to `0` / "Alla")
- [ ] Auto-sync on an interval instead of manual button only
