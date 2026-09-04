# dementor

A self-hosted app that shows [InfoMentor](https://hub.infomentor.se)
(the Swedish preschool/school communication platform) in a faster,
nicer way, for two kids, on both desktop and phone.

See [`AGENTS.md`](AGENTS.md) for the full background and decided
architecture, and [`docs/implementation-plan.md`](docs/implementation-plan.md)
for the phased build plan this repo follows.

## Status

Phase 0 (scaffold) — a SvelteKit app lives at the repo root (`src/`,
`svelte.config.js`, etc.), built with TypeScript, `adapter-node`, and
Tailwind CSS v4. No features yet.

An earlier, working prototype — a Tampermonkey userscript that runs
directly on `hub.infomentor.se` — still lives in [`userscript/`](userscript/)
and is being superseded by this app, not deleted; see `AGENTS.md` for why.

## App development

```
pnpm dev      # start the dev server
pnpm check    # svelte-check + TypeScript
pnpm lint     # oxfmt --check + oxlint
pnpm lint:fix # oxlint --fix
pnpm format   # oxfmt (write)
pnpm build    # production build (adapter-node)
```

## Repo layout

```
src/                   SvelteKit app (this is what `pnpm dev` serves)
docs/api-notes.md      Confirmed InfoMentor internal API reference
docs/implementation-plan.md  Phased build plan
tools/probe-login.ts   Standalone script confirming the InfoMentor login flow
tools/lib/             Cookie jar / HTTP client / HTML-scraping helpers, being
                       ported into src/lib/server/infomentor/ as the app grows
tools/shape.js         Dev tool: structural (non-personal) summary of a capture file
server/                Early backend start; lib/ is being ported into src/lib/server/
userscript/            Working Tampermonkey userscript (pre-app prototype)
captures/              Local scratch space for exported JSON (gitignored)
```
