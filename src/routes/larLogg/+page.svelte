<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import { createInfiniteQuery, QueryClient, type InfiniteData } from '@tanstack/svelte-query';
	import type { LearnlogPage } from '$lib/learnlog';
	import LearnlogEntryCard from '$lib/components/learnlog-entry-card.svelte';
	import MediaLightbox, { type LightboxMediaItem } from '$lib/components/media-lightbox.svelte';
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';

	let { data } = $props();

	// Per page instance, including SSR. Never share family data in a global QueryClient.
	const client = new QueryClient();
	onDestroy(() => client.clear());
	const feed = createInfiniteQuery<
		LearnlogPage,
		Error,
		InfiniteData<LearnlogPage>,
		readonly ['learnlog'],
		string | null
	>(
		() => ({
			queryKey: ['learnlog'],
			initialPageParam: null,
			initialData: { pages: [data.initialPage], pageParams: [null] },
			queryFn: async ({ pageParam, signal }) => {
				const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
				const response = await fetch(`/api/learnlog${query}`, { signal });
				if (!response.ok || response.redirected)
					throw new Error('Kunde inte hämta inläggen. Logga in igen om sessionen har gått ut.');
				// SAFETY: /api/learnlog returns the shared LearnlogPage contract.
				return (await response.json()) as LearnlogPage;
			},
			getNextPageParam: (last) => last.nextCursor,
			enabled: browser,
			staleTime: Infinity,
			refetchOnWindowFocus: false,
			retry: 1
		}),
		() => client
	);
	const entries = $derived(feed.data?.pages.flatMap((page) => page.entries) ?? []);

	async function refreshFeed() {
		await feed.refetch({ cancelRefetch: false });
	}
	function loadMore() {
		if (!feed.isFetching && feed.hasNextPage) void feed.fetchNextPage();
	}
	function observeMore(node: HTMLElement) {
		// Reattach after a page arrives, so a still-visible sentinel can fill a tall viewport.
		if (!feed.hasNextPage || feed.isFetching || feed.isError) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) loadMore();
			},
			{ rootMargin: '300px' }
		);
		observer.observe(node);
		return () => observer.disconnect();
	}

	let reauthShow = $state(false);
	let syncRef = $state<{ retry: () => Promise<void> } | null>(null);

	let refreshingPupils = $state(false);
	let pupilsResult: { ok: boolean; count: number | null; error: string | null } | null =
		$state(null);

	async function refreshPupils() {
		refreshingPupils = true;
		pupilsResult = null;
		try {
			const res = await fetch('/api/sync/pupils', { method: 'POST' });
			// SAFETY: `res.json()` returns `Promise<any>`; the cast below
			// narrows to the documented `{ok, summary, error, detail}`
			// shape returned by `/api/sync/[section]`.
			const body = (await res.json().catch(() => null)) as {
				ok?: boolean;
				summary?: { pupils?: number };
				error?: string;
				detail?: string;
			} | null;
			if (!res.ok || !body?.ok) {
				pupilsResult = {
					ok: false,
					count: null,
					error: body?.detail ?? body?.error ?? `HTTP ${res.status}`
				};
				return;
			}
			const count = body.summary?.pupils ?? 0;
			pupilsResult = { ok: true, count, error: null };
			// Re-run the page load so the new pupils show up everywhere
			// (and the section-sync indicator picks them up on its next
			// tick). Don't touch `location.reload` — `invalidateAll` is
			// the SvelteKit-blessed way and avoids dropping any in-flight
			// fetches that aren't ours.
			await invalidateAll();
		} catch (err) {
			pupilsResult = {
				ok: false,
				count: null,
				error: err instanceof Error ? err.message : 'nätverksfel'
			};
		} finally {
			refreshingPupils = false;
		}
	}

	function pupilLabel(switchId: number): string {
		const pupil = data.pupils.find((p) => p.switchId === switchId);
		return pupil?.displayName ?? `Pupil ${switchId}`;
	}

	// Phase 4: which media file-ids are served from local disk.
	// Wrapped in a Set on the client so we get O(1) lookups inside the
	// each-loop, which runs once per entry × per attachment.
	const cachedMedia = $derived(
		new Set(feed.data?.pages.flatMap((page) => page.cachedMediaFileIds) ?? [])
	);

	// Lightbox state: opened per-entry with that entry's full media
	// array + the clicked index, so prev/next only carousels within
	// the same post (matching the userscript's per-entry "film strip"
	// behaviour, not a single feed-wide gallery). Document tiles link
	// out via <a target="_blank"> instead of triggering this — see
	// `learnlog-entry-card.svelte` and `media-kind.ts`.
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

<svelte:head><title>Lärlogg · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Lärlogg</h1>
		<SyncIndicator
			url="/api/sync/learnlog"
			onrefresh={refreshFeed}
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if entries.length === 0}
		{#if data.pupils.length === 0}
			<div class="rounded-2xl border-2 border-border bg-card p-6 shadow-md">
				<p class="text-sm">
					Inga barn hittades på ditt InfoMentor-konto. Det här kan bero på att
					InfoMentor-inloggningen precis gick igenom men sidan vi läser av inte hade en synlig
					barn-växlare, eller att InfoMentors dashboard laddas som en SPA-shell där barn-växlaren
					renderas via JavaScript.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<button
						class="rounded-md border-2 border-border bg-amber-400 px-3 py-1.5 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
						disabled={refreshingPupils}
						onclick={refreshPupils}
					>
						{refreshingPupils ? 'Hämtar…' : 'Försök hämta igen'}
					</button>
					<a
						href={resolve('/barn')}
						class="rounded-md border-2 border-border bg-background px-3 py-1.5 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm"
					>
						Lägg till manuellt
					</a>
				</div>
				{#if pupilsResult}
					{#if pupilsResult.ok}
						<p class="mt-2 text-xs text-muted-foreground">
							Hittade {pupilsResult.count} barn. Sidan uppdateras…
						</p>
					{:else}
						<p class="mt-2 text-xs text-destructive" role="alert">
							Misslyckades: {pupilsResult.error}
						</p>
					{/if}
				{/if}
			</div>
		{:else}
			<p
				class="rounded-md border-2 border-border bg-card p-6 text-sm text-muted-foreground shadow-xs"
			>
				Inga Lärlogg-inlägg ännu. De hämtas nu — sidan uppdateras automatiskt.
			</p>
		{/if}
	{:else}
		<ul class="space-y-4">
			{#each entries as entry (entry.pupilSwitchId + ':' + entry.entryId)}
				<LearnlogEntryCard {entry} {cachedMedia} {pupilLabel} onOpenLightbox={openLightbox} />
			{/each}
		</ul>
	{/if}
	{#if feed.isError}
		<p class="text-sm text-destructive" role="alert">{feed.error.message}</p>
		<button
			class="rounded-md border-2 border-border bg-card px-4 py-2 shadow-xs"
			onclick={refreshFeed}>Försök igen</button
		>
	{/if}
	{#if feed.hasNextPage}
		<div {@attach observeMore} class="flex justify-center py-4">
			<button
				class="rounded-md border-2 border-border bg-card px-4 py-2 text-sm shadow-xs disabled:opacity-60"
				disabled={feed.isFetching}
				onclick={loadMore}
			>
				{feed.isFetchingNextPage ? 'Hämtar fler…' : 'Visa fler inlägg'}
			</button>
		</div>
	{:else if entries.length > 0}
		<p class="text-center text-xs text-muted-foreground">Alla hämtade inlägg visas.</p>
	{/if}
</section>

<MediaLightbox
	bind:open={lightboxOpen}
	bind:index={lightboxIndex}
	media={lightboxMedia}
	resolveSrc={fullSrc}
/>
