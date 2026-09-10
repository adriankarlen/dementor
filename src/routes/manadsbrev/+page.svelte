<script lang="ts">
	import { resolve } from '$app/paths';
	import LearnlogEntryCard from '$lib/components/learnlog-entry-card.svelte';
	import MediaLightbox, { type LightboxMediaItem } from '$lib/components/media-lightbox.svelte';
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';
	import { createPupilColorClass } from '$lib/components/pupil-color';
	import { createMediaSessionCheck, setMediaSession } from '$lib/media-session';
	import { createMediaPrefetcher } from '$lib/media-prefetch';

	let { data } = $props();

	let reauthShow = $state(false);
	let mediaRevision = $state(0);
	const mediaSessionCheck = createMediaSessionCheck(() => {
		lightboxOpen = false;
		reauthShow = true;
	});
	setMediaSession({
		check: mediaSessionCheck,
		get revision() {
			return mediaRevision;
		}
	});

	// Same rationale as /larLogg: warm the full-image cache in the
	// background for whatever's already loaded, instead of only on
	// lightbox open. This page has no pagination of its own, so this
	// runs once per `data.rows` change (e.g. after a resync).
	const mediaPrefetcher = createMediaPrefetcher(() => void mediaSessionCheck());
	$effect(() => {
		mediaPrefetcher.queue(
			data.rows.flatMap((row) => row.canonical.json.media),
			cachedMedia
		);
	});
	function onReauthed() {
		mediaRevision++;
		void syncRef?.retry();
	}
	let syncRef = $state<{ retry: () => Promise<void> } | null>(null);

	function pupilLabel(switchId: number): string {
		const pupil = data.pupils.find((p) => p.switchId === switchId);
		return pupil?.displayName ?? `Pupil ${switchId}`;
	}

	// One tailwind bg-* class per pupil, stable as long as the same
	// set of pupils is known — see pupil-color.ts.
	const pupilColorClass = $derived(createPupilColorClass(data.pupils));

	// One pill per pupil this letter was posted to (canonical entry +
	// its deduped `dupes`), deduplicated in case the same pupil ever
	// ends up in both. `LearnlogEntryCard` collapses this into a
	// single "Alla" pill once there are more than a few.
	function taggedPupilSwitchIds(row: (typeof data.rows)[number]): number[] {
		return [...new Set([row.canonical.pupilSwitchId, ...row.dupes.map((d) => d.pupilSwitchId)])];
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

	function fullSrc(fileId: number): string {
		return `/media/${fileId}`;
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

	<ReauthPanel bind:show={reauthShow} onsuccess={onReauthed} />

	{#if data.rows.length === 0}
		{#if data.rawCount === 0}
			<!-- Matching uses post titles and attachment filenames, not the body text. -->
			<div class="rounded-2xl border-2 border-border bg-card p-6 text-sm shadow-md">
				<p>
					Inga månadsbrev hittades bland Lärlogg-inläggen. Här visas inlägg med "månadsbrev" (med
					eller utan å) i rubriken eller i en bilagas filnamn. Brev med andra namn finns fortfarande
					i hela Lärlogg.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<a
						href={resolve('/larLogg')}
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
				`rawCount` is the total matches before cross-pupil
				collapsing; `rows.length` is after. They differ
				whenever the same letter was posted to more than one
				pupil — see `dedupKey()` in +page.server.ts.
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
					{pupilColorClass}
					taggedPupilSwitchIds={taggedPupilSwitchIds(row)}
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
