<script lang="ts">
	import LearnlogEntryCard from '$lib/components/learnlog-entry-card.svelte';
	import MediaLightbox, { type LightboxMediaItem } from '$lib/components/media-lightbox.svelte';
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';

	let { data } = $props();

	let reauthShow = $state(false);
	let syncRef = $state<{ retry: () => Promise<void> } | null>(null);

	function pupilLabel(switchId: number): string {
		const pupil = data.pupils.find((p) => p.switchId === switchId);
		return pupil?.displayName ?? `Pupil ${switchId}`;
	}

	// Phase 4: which media file-ids are served from local disk.
	// Wrapped in a Set on the client for O(1) lookups inside the
	// each-loop, which runs once per entry × per attachment.
	const cachedMedia = $derived(new Set(data.cachedMediaFileIds));

	// Lightbox state — same shape as `/larLogg`, scoped to this page
	// since the lightbox component is mounted here.
	let lightboxOpen = $state(false);
	let lightboxMedia: LightboxMediaItem[] = $state([]);
	let lightboxIndex = $state(0);

	function openLightbox(entryMedia: LightboxMediaItem[], startIndex: number) {
		lightboxMedia = entryMedia;
		lightboxIndex = startIndex;
		lightboxOpen = true;
	}

	/** Full-resolution src for the lightbox — same cached/fallback
	 *  split as the card's thumbnail src, just resolving fileUrl
	 *  instead of thumbnailUrl for the fallback case. */
	function fullSrc(fileId: number, fallbackRelative: string): string {
		if (cachedMedia.has(fileId)) return `/media/${fileId}`;
		try {
			return new URL(fallbackRelative, 'https://hub.infomentor.se/').href;
		} catch {
			return fallbackRelative;
		}
	}
</script>

<svelte:head><title>Månadsbrev · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Månadsbrev</h1>
		<SyncIndicator
			url="/api/sync/learnlog"
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if data.rows.length === 0}
		{#if data.rawCount === 0}
			<!--
				Heuristic placeholder: this tab currently filters by
				case-insensitive title substring "månadsbrev" /
				"manadsbrev" (see `+page.server.ts`). If the cache
				has Lärlogg entries but none matched the heuristic,
				say so and point at the full Lärlogg feed rather than
				pretending the tab is authoritative.
			-->
			<div class="rounded-2xl border-2 border-border bg-card p-6 text-sm shadow-md">
				<p>
					Inga månadsbrev hittades bland Lärlogg-inläggen. Den här vyn filtrerar Lärlogg-flödet på
					titlar som innehåller "månadsbrev" (med eller utan å) — om förskolan skickar månadsbrevet
					under en annan rubrik dyker det inte upp här.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<a
						href="/larLogg"
						class="rounded-md border-2 border-border bg-background px-3 py-1.5 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm"
					>
						Öppna hela Lärlogg
					</a>
				</div>
			</div>
		{:else}
			<p
				class="rounded-md border-2 border-border bg-card p-6 text-sm text-muted-foreground shadow-xs"
			>
				Inga månadsbrev cachade ännu. Hämtar nu — sidan uppdateras automatiskt.
			</p>
		{/if}
	{:else}
		{#if data.rows.length < data.rawCount}
			<!--
				`rawCount` is the total matches before any
				cross-pupil collapsing; `rows.length` is after. With
				the per-pupil placeholder dedup key these should
				always be equal, so this branch only fires once real
				dedup lands — surfacing the "Vi gömde X dubletter"
				signal at the top of the page so the user can see
				when collapsing kicks in.
			-->
			<p
				class="rounded-md border-2 border-border bg-amber-100 px-4 py-2 text-xs text-foreground shadow-xs"
			>
				Visar {data.rows.length} unika inlägg (utav {data.rawCount} träffar i Lärlogg).
			</p>
		{/if}
		<ul class="space-y-4">
			{#each data.rows as row (row.canonical.pupilSwitchId + ':' + row.canonical.entryId)}
				<LearnlogEntryCard
					entry={row.canonical}
					{cachedMedia}
					{pupilLabel}
					onOpenLightbox={openLightbox}
				/>
			{/each}
		</ul>
	{/if}
</section>

<MediaLightbox
	bind:open={lightboxOpen}
	bind:index={lightboxIndex}
	media={lightboxMedia}
	resolveSrc={fullSrc}
/>
