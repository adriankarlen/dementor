# Lärlogg loading

## Page and sync

- The server renders **four cached entries** initially. `/api/learnlog` reads
  four more from SQLite at a time. Its cursor includes both entry ID and pupil
  switch ID, since a shared post can appear for both children.
- The Lärlogg page uses `@tanstack/svelte-query` v6 (`createInfiniteQuery`). The
  query client belongs to that page instance, not a process-global variable.
  SvelteKit supplies the first page for SSR; Query owns subsequent feed data.
- An intersection observer loads the next page near the bottom. A **Visa fler
  inlägg** button also works with a keyboard. Images use native lazy loading.
  This is pagination, not virtualization: cards already viewed stay mounted.
- `POST /api/sync/learnlog` starts an on-demand metadata job and returns **202**.
  `GET` at the same URL reports progress/errors. The UI checks every 1.5 seconds
  while it runs and refreshes the currently loaded query pages after changes.
- The job first saves the latest **four posts per pupil**, then fills missing
  history in 25-item batches. It makes at most eight history calls per pupil
  per run. If more remain, **Hämta äldre inlägg** continues the saved position.
  This limit prevents one visit from scanning an unlimited archive.
- Sync position is stored in `learnlog_sync` (migrations 3–4). The known-ID
  baseline is captured before fetching new entries and kept across resumes.
  A full page of baseline entries stops catch-up; numeric ID order does not.
  Completion is recorded only after catch-up finishes. Interrupted and capped
  runs resume, with an overlap page because InfoMentor uses offset pagination.
  Very large deletions/reordering upstream remain a limitation of that API.
- A repeated set of page IDs pauses history instead of failing the whole sync
  or falsely marking the archive complete. Saved entries remain visible, and
  the UI explains the pause. **Hämta äldre inlägg** retries from the saved position.
- Concurrent starts from the same dashboard session join one job. Metadata
  jobs from both parents are serialized because they update shared positions.
  A job stops taking new pages after logout or reauthentication. There is no
  scheduled sync and no stored password.

## Media

- Feed and lightbox filmstrip tiles are **images**, never video elements.
  Only the selected item in an **open** lightbox can mount a video player.
  Closing it removes that player.
- `/media/{id}?thumbnail=1` resolves the exact thumbnail URL from cached post
  metadata and fetches it with the parent's server-held InfoMentor cookies.
  It does not change width/height parameters. Thumbnails have a separate
  `.thumbnail` disk cache and a 5 MiB limit.
- `/media/{id}` serves a cached full file, or downloads it when opened. Full
  files have a 256 MiB limit. The first open waits for the complete download
  before range playback; subsequent opens use disk. Upstream range support
  has not been assumed.
- Each download streams to a temporary file. Only complete, non-empty 200
  responses are published by rename. Thumbnails are validated by their image
  signatures, not the upstream MIME header: generic or missing headers do not
  reject valid image bytes. Our media route serves the detected image MIME.
  HTML/JSON/non-image thumbnails are rejected. Unknown-length downloads stop
  at the byte limit.
- A recognized login/relay page signals session expiry. A resource 401/403
  alone does not: the handler checks `communication/appData` before reporting
  expiry. Generic HTML errors and file-access denials remain media failures;
  they do not fail the metadata sync job.
- Empty legacy files are not considered valid cache hits. They are replaced
  on demand when InfoMentor supplies valid bytes, never re-saved as empty files.
- If a **video thumbnail** is empty, missing, or not an image (including generic
  non-login HTML), the route returns a fixed local SVG play placeholder marked
  **Förhandsvisning saknas**. It is not a frame from the video. No full video
  is downloaded to make a preview. The placeholder never replaces a real
  `.thumbnail` cache entry, and a real thumbnail is still used when available.
- Known unavailable thumbnails have a one-hour, per-session backoff; other
  download failures have a one-minute backoff. Missing video posters are not
  logged as errors repeatedly. Auth errors still propagate, and unrelated
  image/download failures still return 503 rather than being hidden.
- Switching pupil and fetching its metadata or media run in one per-cookie-jar
  queue. Background metadata cannot switch pupils during a media download.
  Repeated requests for the same file and variant share a download.
- Cached files support single byte ranges, suffix ranges, HEAD and ETags.
  Only the requested disk range is streamed; response cancellation closes
  the stream. Unsatisfiable requests still correctly return 416.

## Diagnostics

`[dementor] learnlog page=... size=... items=... ms=...` measures a metadata
request including any required pupil switch, excluding time waiting in the
session queue. It prints no names, entry text or credentials.

`[dementor] media <id>: thumbnail HTTP ... content-type=... content-length=...
received-bytes=... — ...` records upstream response metadata on failure, without
logging cookies, URLs or response bodies. The received byte count is included
when a complete non-empty download reached validation.

`empty media response` means InfoMentor returned no bytes. A full file cannot
be recovered until the upstream endpoint supplies it. The earlier flood of
browser 416 errors was traced to zero-byte local files, not established to be
normal browser probing.

## Tests

```sh
pnpm test                          # offline backend regressions
pnpm exec playwright install chromium
pnpm test:browser                  # synthetic account, disposable DB/media
pnpm check
pnpm build
```

For an existing Chrome installation, the browser test also accepts
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

The browser test covers four-card SSR, progressive refresh, scroll loading,
video mounting/closing, unavailable-video placeholders/backoff, repeated-page
pausing, empty-file recovery, HTTP ranges, authentication and a
390px mobile viewport. It writes synthetic screenshots under `/tmp`.
Neither test needs credentials or reads/modifies the real family cache.
