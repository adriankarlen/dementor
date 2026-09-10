# dementor

A self-hosted app that shows [InfoMentor](https://hub.infomentor.se)
(the Swedish preschool/school communication platform) in a faster,
nicer way, for two kids, on both desktop and phone.

See [`AGENTS.md`](AGENTS.md) for the full background and decided
architecture, and [`docs/implementation-plan.md`](docs/implementation-plan.md)
for the build history and remaining deployment work.

## Status

The current app lives in `src/`, built with TypeScript, SvelteKit,
`adapter-node`, and Tailwind CSS v4. It shows Lärlogg, monthly letters,
calendar entries, news, and documents from a shared SQLite cache.

Each parent signs in with their InfoMentor username and password. Only
the resulting cookie jar stays in process memory, keyed by an opaque
HttpOnly session cookie. There are no separate dashboard accounts.

Data refreshes on demand. Posts appear as batches arrive; older posts
load as the reader scrolls. Media uses an on-disk cache, byte-range video
loading, and optional MP4 playback repair. See
[`docs/learnlog-loading.md`](docs/learnlog-loading.md) for the current
loading behavior and tests. VPS deployment is still to be done.

An earlier, working prototype — a Tampermonkey userscript that runs
directly on `hub.infomentor.se` — still lives in [`userscript/`](userscript/)
and is being superseded by this app, not deleted; see `AGENTS.md` for why.

## App development

Video playback repair needs **FFmpeg and FFprobe** on the server (and for the
video regression tests). Normal playback still works without them.

```sh
brew install ffmpeg             # macOS
sudo apt-get install ffmpeg     # Debian/Ubuntu VPS
```

Both programs are found through `PATH`; `FFMPEG_PATH` and `FFPROBE_PATH` can
override their executable paths. Failed original playback gets one on-demand
MP4 repair attempt. Its first run may take time to download and convert the
video; subsequent playback uses the cached MP4. Originals are not changed.

```
pnpm dev         # start the dev server
pnpm check       # svelte-check + TypeScript
pnpm lint        # oxfmt --check + oxlint
pnpm lint:fix    # oxlint --fix
pnpm format      # oxfmt (write)
pnpm build       # production build (adapter-node)
pnpm test        # offline backend/video regressions
pnpm test:browser # browser regressions with synthetic data
```

## Repo layout

```
src/                         SvelteKit app (what `pnpm dev` serves)
src/lib/server/infomentor/    Shared login, HTTP, cookie and session implementation
docs/api-notes.md            Confirmed InfoMentor internal API reference
docs/learnlog-loading.md     Current loading, media and test behavior
docs/implementation-plan.md  Build history and deployment plan
tools/probe-login.ts         Manual login check using the app's implementation
tools/check-*.ts             Backend and browser regression checks
tools/fixtures/              Synthetic media for tests
tools/shape.js               Capture structure summary (no personal content)
userscript/                  Working Tampermonkey prototype and capture tool
captures/                    Personal capture exports (gitignored)
data/                        Rebuildable SQLite and media cache (gitignored)
```
