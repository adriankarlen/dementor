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
- `POST /api/sync/learnlog` returns a **streaming NDJSON response**. Each committed
  batch produces an update; the UI reads the cached query pages immediately.
  The response closes on completion or failure. **There is no status polling.**
  `GET` remains available for manual diagnostics, not for the page's loading loop.
- Navigation saves only the latest **four posts per pupil**. It never starts or
  resumes an archive scan. Once the reader reaches the cached feed's end,
  `POST /api/sync/learnlog?history=1` fetches a **12-post history page per pupil**.
  A resumed request also rereads one overlap page to handle shifted offsets.
  After the first four posts, the first history batch leaves two four-post UI
  pages ahead per pupil. Media is not fetched by these jobs.
- The bottom **Visa fler inlägg** control handles both cached pages and upstream
  history. Auto-loading is limited to two steps without further scroll progress,
  so grouped/short cards cannot make a visible sentinel drain the archive. On the
  monthly-letter page, **Hämta äldre inlägg** explicitly requests the next batch.
- Sync position is stored in `learnlog_sync` (migrations 3–5). Migration 5 restarts
  unfinished 25-post cursors at the new 12-post size without discarding cached data.
  The known-ID
  baseline is captured before fetching new entries and kept across resumes.
  A full page of baseline entries stops catch-up; numeric ID order does not.
  Completion is recorded only after catch-up finishes. Interrupted and capped
  runs resume, with an overlap page because InfoMentor uses offset pagination.
  Very large deletions/reordering upstream remain a limitation of that API.
- A repeated set of page IDs pauses history instead of failing the whole sync
  or falsely marking the archive complete. Saved entries remain visible, and
  the UI explains the pause. The load-more button retries from the saved position.
- Concurrent starts from the same dashboard session join one job. Metadata
  jobs from both parents are serialized because they update shared positions.
  A job stops taking new pages after logout, reauthentication, or when its last
  stream reader disconnects. A page already in flight may still finish and be saved.
  There is no scheduled sync and no stored password.

## Related posts

- The Lärlogg view combines loaded posts with the same title, pupil, group and
  Swedish calendar date into one card. Titles ignore case and extra whitespace.
  Monthly letters keep their existing separate deduplication rules.
- One non-empty HTML body is shown once, alongside all photos, videos and
  attachments. Files are deduplicated by file ID, not by filename or thumbnail
  URL. If there are different non-empty bodies, all those posts stay separate
  rather than hiding text or guessing which body belongs to a photo.
- The card stays at the newest source post's position and shows how many posts
  were combined. All its photos and videos share one lightbox gallery.
- Grouping uses all loaded pages, not each four-entry page separately. More
  media/text can join an existing card as older entries load. Unrecognized dates
  and empty titles stay separate. The raw cache, cursors and download URLs do
  not change.

## Media

- Feed and lightbox filmstrip tiles are **images**, never video elements.
  Only the selected item in an **open** lightbox can mount a video player.
  Closing it removes that player.
- `/media/{id}?thumbnail=1` resolves the exact thumbnail URL from cached post
  metadata and fetches it with the parent's server-held InfoMentor cookies.
  It does not change width/height parameters. Thumbnails have a separate
  `.thumbnail` disk cache and a 5 MiB limit.
- `/media/{id}` serves an existing full file directly. For an uncached video,
  browser range requests fetch **at most a 1 MiB chunk at a time** from InfoMentor.
  The player can request the end of a MOV for its `moov` metadata without first
  downloading all video bytes. Returned `Content-Range` and lengths describe
  the actual portion served, not the whole requested open-ended range.
- Validated chunks are stored under `{fileId}.ranges/` on disk and reused across
  requests, sessions and server restarts. Size/ETag/Last-Modified separate cache
  versions. Partial chunks are never advertised as complete media files. A range
  covering an entire small file can populate the normal full-file cache.
- Range support is checked on each response, not assumed: **206** must contain
  matching, bounded `Content-Range` and body lengths. If upstream ignores Range
  and sends **200**, that same response fills the normal full-file cache—no
  duplicate download. This fallback still waits for the full download. Full
  files remain limited to 256 MiB. Non-range original-file downloads use the
  full-file path as before.
- Each download streams to a temporary file. Only complete, non-empty full
  responses or validated 206 chunks are published by rename. Thumbnails are validated by their image
  signatures, not the upstream MIME header: generic or missing headers do not
  reject valid image bytes. Our media route serves the detected image MIME.
  HTML/JSON/non-image thumbnails are rejected. Unknown-length downloads stop
  at the byte limit.
- A recognized login/relay page signals session expiry. A resource 401/403
  alone does not: the handler checks `communication/appData` before reporting
  expiry. Generic HTML errors and file-access denials remain media failures;
  they do not fail the metadata sync job.
- Confirmed expiry marks the in-memory cookie jar as expired. Already-queued
  and new upstream work then fails immediately, without repeating pupil switches
  and session probes for every image. Cached data/files remain usable. Re-login
  supplies a fresh cookie jar and retries failed thumbnails.
- Browser image/video errors trigger a coalesced `/api/session` check of that
  in-memory flag (no upstream call, no timer). Expiry closes the lightbox and
  shows the password prompt. A decode error alone does not imply expiry.
- Normal playback uses the original bytes and range cache. Binary prefixes are
  not scanned for HTML login forms. A login/relay HTML response is an auth failure,
  not evidence of a MOV parser failure. The generic player error alone does not
  identify a codec: browsers can report similar errors for failed/truncated media.
- On a browser decode/unsupported-source error (MediaError 3 or 4), the player
  checks session status and makes **one** `?compatible=1` repair attempt. Pure
  network/abort errors do not trigger conversion. The player shows **Anpassar
  videon för uppspelning…** while preparing it, rather than just offering a download.
- Repair requires FFmpeg/FFprobe installed on the server. It first fetches the
  complete original if needed, then probes its streams. H.264/yuv420p is remuxed
  without video re-encoding; other codecs/pixel formats are encoded as H.264/yuv420p
  up to 1080p (without upscaling). Standard AAC audio is preferred over auxiliary
  spatial tracks; other audio is converted to AAC. Only one video and one audio
  track are included, with MP4 playback metadata at the front (`+faststart`).
- The repaired file is a separate `{id}.compatible-v1.mp4`. It is published by
  atomic rename only after size, codec and duration checks. The original and range
  caches stay unchanged; the original download URL still returns the original.
  Before mounting the player, `GET /api/media/{id}/playback` selects the current
  variant with `Cache-Control: private, no-store`. It only checks local cache state,
  with no InfoMentor request. This runs once per open/retry, not on a timer.
- Media URLs keep distinct representations: `?original=1` always serves original
  bytes; `?compatible=1` always serves the repaired MP4. They can safely cache byte
  ranges. The legacy `?playback=1` URL now returns a non-cacheable redirect rather
  than serving either representation under one cache key. Reopening a repaired
  video selects its MP4 URL directly and does not show the conversion message.
- Conversion runs only after an explicit playback failure—not during feed sync or
  thumbnail loading. One conversion runs at a time, with a three-minute conversion
  limit, two encoder threads, a 256 MiB output cap and a one-minute failure backoff.
  Concurrent repair requests share work. Once started, repair can finish and cache
  the result after the player closes. No child metadata or tool stderr is logged.
- First-time repair can take time because the complete original is needed. Missing
  tools or unrepairable files leave a retry/original-download option; session expiry
  still opens the login prompt. No promise of immediate playback for a cold repair.
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
  An opened video's chunk requests run ahead of queued thumbnails, but never
  interrupt a request already in flight. Duplicate requests for the same chunk
  share a download; closing a player cancels its queued/requested range work.
- Cached files support single byte ranges, suffix ranges, HEAD and ETags.
  Only the requested disk range is streamed; response cancellation closes
  the stream. Unsatisfiable requests still correctly return 416.

## Diagnostics

`[dementor] learnlog page=... size=... items=... ms=...` measures a metadata
request including any required pupil switch, excluding time waiting in the
session queue. It prints no names, entry text or credentials.

Video range responses include `Server-Timing` fields for **queue** wait,
**upstream** fetch/write time, and **cache** (`hit`, `miss`, `range-unsupported`).
These are visible in DevTools response headers/timings. A `range-unsupported`
response also logs that upstream ignored Range and records the full byte count.
A full-file cache response is marked `cache;desc="full-file"`.

A small **206** transfer in DevTools is only one browser byte-range request,
not the video's total size. `Content-Range` reports the full size after `/`.
The reported 4.1 kB / 14.83 s case was a 55,507,261-byte MOV with metadata at
EOF; the old cold path downloaded the whole file before serving that small range.

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
# Install FFmpeg/FFprobe first (see README.md).
pnpm test                          # offline backend/video regressions
pnpm exec playwright install chromium
pnpm test:browser                  # synthetic account, disposable DB/media
pnpm check
pnpm build
```

For an existing Chrome installation, the browser test also accepts
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

The browser test covers four-card SSR, a cold cache with a deliberately slow
second pupil, incremental rendering without GET polling, idle/scroll request
bounds, real H.264 MOV decoding (including a 48 MiB media-data atom followed by
EOF metadata, loaded with bounded head/tail requests), automatic MP4 repair after
an injected original playback failure (using a real ProRes/PCM fixture), media expiry and
re-login prompting, video mounting/closing, unavailable-video placeholders/backoff,
repeated-page pausing, empty-file recovery, HTTP ranges, authentication and a
390px mobile viewport. It writes synthetic screenshots under `/tmp`.
The reopening regression uses a fresh browser context **without Playwright request
routing**, since routing disables the browser HTTP cache. It caches original MOV
ranges, triggers repair, then reopens both immediately and after navigation. The
player must use the MP4 URL without another upstream download or conversion.

The tests need no credentials and do not read or modify the real family cache.
