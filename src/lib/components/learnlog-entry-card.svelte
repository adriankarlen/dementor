<!--
	Shared card rendering for a single cached Lärlogg entry: header
	pills (pupil name, group name, last-modified text), title,
	pre-formatted HTML body, and the per-entry media grid. Used by
	both `/larLogg` (the unified feed) and `/manadsbrev` (the
	månadsbrev-only view) so the visual language stays in lock-step
	and any change to the card (e.g. the new document/PDF branch)
	lives in exactly one place.

	Why a component instead of a snippet on the page: the card is
	the only thing the two pages share visually — they have
	different headers, empty states, lightbox state, and (slightly)
	different SyncIndicator URLs. A component keeps each page small
	and focused on its page-level concerns; a snippet would have
	been fine too but means the helper functions (`thumbSrc`,
	`fullSrc`, lightbox callbacks) all have to be passed in by name,
	which is more boilerplate than just accepting an `onOpenLightbox`
	callback prop.

	Props:
	  entry         — one CachedLearnlogEntry from the cache layer
	  cachedMedia   — Set<number> of file ids present on local disk
	                  (Phase 4 cache). Used for the thumbnail / link
	                  src split and the ● / ↗ badge in the corner.
	  pupilLabel    — switch_id → display name resolver from the page.
	                  Kept as a callback rather than a pupils array
	                  so the card doesn't need to know about the
	                  pupil table or its rendering conventions.
	  onOpenLightbox— called with (entryMedia, index) when the user
	                  clicks an image or video tile. Document tiles
	                  link out via <a target="_blank"> and never
	                  trigger this — see media-kind.ts.
-->
<script lang="ts">
	import { isVideoKind, mediaKind, tileKindLabel } from './media-kind';
	import type { LightboxMediaItem } from './media-lightbox.svelte';
	import type { CachedLearnlogEntry } from '$lib/server/cache';

	interface Props {
		entry: CachedLearnlogEntry;
		cachedMedia: Set<number>;
		pupilLabel: (switchId: number) => string;
		onOpenLightbox: (entryMedia: LightboxMediaItem[], index: number) => void;
	}

	let { entry, cachedMedia, pupilLabel, onOpenLightbox }: Props = $props();

	/** Thumbnail src: locally cached `/media/{id}` when we have it,
	 *  otherwise InfoMentor's own URL resolved against the hub.
	 *  Same split as the existing larLogg page uses directly. */
	function thumbSrc(fileId: number, fallbackRelative: string): string {
		if (cachedMedia.has(fileId)) return `/media/${fileId}`;
		try {
			return new URL(fallbackRelative, 'https://hub.infomentor.se/').href;
		} catch {
			return fallbackRelative;
		}
	}

	/** Full-resolution src — same cached/fallback split as `thumbSrc`,
	 *  used by the document <a href> and the lightbox's resolveSrc. */
	function fullSrc(fileId: number, fallbackRelative: string): string {
		if (cachedMedia.has(fileId)) return `/media/${fileId}`;
		try {
			return new URL(fallbackRelative, 'https://hub.infomentor.se/').href;
		} catch {
			return fallbackRelative;
		}
	}

	function isVideo(fileType: string): boolean {
		return isVideoKind(mediaKind(fileType));
	}
</script>

<li class="rounded-2xl border-2 border-border bg-card p-5 shadow-md">
	<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span
			class="rounded-md border-2 border-border bg-amber-200 px-2 py-0.5 font-semibold text-foreground"
		>
			{pupilLabel(entry.pupilSwitchId)}
		</span>
		{#if entry.json.groupName}
			<span class="rounded-md border-2 border-border bg-card px-2 py-0.5 font-semibold">
				{entry.json.groupName}
			</span>
		{/if}
		<span>{entry.json.lastModifiedOn}</span>
	</div>
	<h2 class="mb-2 text-lg font-semibold">{entry.json.title}</h2>
	<!--
		infoMentor text is pre-formatted HTML per docs/api-notes.md
		("actually pre-formatted HTML (e.g. <p style=...>) — render
		with innerHTML, not escaped text"). Same provenance as
		news.content.
	-->
	<div class="learnlog-text prose prose-sm max-w-none">
		{@html entry.json.text}
	</div>
	{#if entry.json.media.length > 0}
		<div class="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
			{#each entry.json.media as m, i (m.fileId)}
				{@const cached = cachedMedia.has(m.fileId)}
				{@const kind = mediaKind(m.fileType)}
				{#if kind === 'document'}
					<!--
						Documents (PDFs, generic file attachments) open in a new
						tab via <a> instead of going through the lightbox — PDF
						previews don't carousel well with photos/videos, and a
						fresh tab is the better UX (the user can save/print).
						Cached file via /media/<fileId> when we have it,
						otherwise InfoMentor's own fileUrl. The badge in the
						top-right keeps the cached/uncached distinction the
						image/video tiles have.
					-->
					<a
						href={fullSrc(m.fileId, m.fileUrl)}
						target="_blank"
						rel="noopener noreferrer"
						class="group relative flex aspect-square items-center justify-center overflow-hidden rounded-md border-2 border-border bg-muted text-foreground shadow-xs transition-transform hover:-translate-x-px hover:-translate-y-px hover:shadow-sm"
						aria-label={`Öppna bifogad fil (${tileKindLabel(m)})`}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="size-10 text-muted-foreground"
							aria-hidden="true"
						>
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14 2 14 8 20 8" />
						</svg>
						<span
							class="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white uppercase"
						>
							{tileKindLabel(m)}
						</span>
						{#if cached}
							<span
								class="pointer-events-none absolute top-1 right-1 rounded-sm border border-border bg-amber-300 px-1.5 py-0.5 text-[10px] font-bold text-foreground shadow-xs"
								title="Cachas lokalt"
							>
								●
							</span>
						{:else}
							<span
								class="pointer-events-none absolute top-1 right-1 rounded-sm border border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-xs"
								title="Öppnas från InfoMentor"
							>
								↗ InfoMentor
							</span>
						{/if}
					</a>
				{:else}
					<button
						type="button"
						onclick={() => onOpenLightbox(entry.json.media, i)}
						class="group relative block overflow-hidden rounded-md border-2 border-border shadow-xs transition-transform hover:-translate-x-px hover:-translate-y-px hover:shadow-sm"
						aria-label={isVideo(m.fileType) ? 'Öppna video' : 'Öppna foto'}
					>
						{#if isVideoKind(kind)}
							<video
								src={thumbSrc(m.fileId, m.thumbnailUrl || m.fileUrl)}
								class="aspect-square w-full bg-muted object-cover"
								muted
								playsinline
								preload="metadata"
							></video>
							<span
								class="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white uppercase"
							>
								Video
							</span>
						{:else}
							<img
								src={thumbSrc(m.fileId, m.thumbnailUrl || m.fileUrl)}
								alt=""
								loading="lazy"
								decoding="async"
								class="aspect-square w-full bg-muted object-cover"
							/>
						{/if}
						{#if cached}
							<span
								class="pointer-events-none absolute top-1 right-1 rounded-sm border border-border bg-amber-300 px-1.5 py-0.5 text-[10px] font-bold text-foreground shadow-xs"
								title="Cachas lokalt"
							>
								●
							</span>
						{:else}
							<span
								class="pointer-events-none absolute top-1 right-1 rounded-sm border border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-xs"
								title="Inte cachad ännu — öppnas från InfoMentor i lightboxen"
							>
								↗ InfoMentor
							</span>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</li>
