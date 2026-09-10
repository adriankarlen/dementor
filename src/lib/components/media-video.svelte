<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { getMediaSession } from '$lib/media-session';
	let { fileId }: { fileId: number } = $props();
	const session = getMediaSession();
	let mode = $state<'loading' | 'original' | 'compatible' | 'failed'>('loading');
	let loading = $state(true);
	let repairing = $state(false);
	let controller: AbortController | undefined;
	const src = $derived(
		`${resolve('/media/[fileId]', { fileId: String(fileId) })}?${mode === 'compatible' ? 'compatible=1' : 'original=1'}`
	);

	async function selectSource() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		mode = 'loading';
		loading = true;
		repairing = false;
		try {
			const response = await fetch(
				resolve('/api/media/[fileId]/playback', { fileId: String(fileId) }),
				{
					cache: 'no-store',
					signal: current.signal
				}
			);
			if (!response.ok || response.redirected) throw new Error('Could not select video source');
			// SAFETY: the authenticated playback resolver returns this variant contract.
			const body = (await response.json()) as { variant: 'original' | 'compatible' };
			if (!current.signal.aborted) mode = body.variant;
		} catch {
			if (!current.signal.aborted) {
				mode = 'failed';
				void session.check();
			}
		}
	}

	onMount(() => {
		void selectSource();
		return () => controller?.abort();
	});

	async function onError(event: Event) {
		const video = event.currentTarget;
		if (!(video instanceof HTMLVideoElement)) return;
		const code = video.error?.code;
		const attempted = mode;
		await session.check();
		if (attempted !== mode) return;
		// Decode/unsupported-source failures get one MP4 repair attempt. Network
		// failures and aborted playback are not evidence that a codec needs repair.
		if (attempted === 'original' && (code === 3 || code === 4)) {
			console.info(
				`[dementor] video ${fileId}: browser media error ${code}; trying compatible MP4`
			);
			loading = true;
			repairing = true;
			mode = 'compatible';
		} else {
			loading = false;
			mode = 'failed';
		}
	}
</script>

{#if mode === 'failed'}
	<div class="max-w-sm space-y-3 px-12 text-center text-sm text-white" role="alert">
		<p>Videon kunde inte spelas upp. Försök igen eller hämta originalvideon.</p>
		<button onclick={selectSource} class="underline">Försök igen</button>
		<a
			href={resolve('/media/[fileId]', { fileId: String(fileId) })}
			download
			class="block underline">Hämta originalvideon</a
		>
	</div>
{:else if mode === 'loading'}
	<p class="px-12 text-center text-sm text-white" role="status">Laddar videon…</p>
{:else}
	<div class="flex max-h-full min-h-0 max-w-full flex-col items-center gap-3">
		{#if repairing && loading}
			<p class="px-12 text-center text-sm text-white" role="status">
				Anpassar videon för uppspelning… Första gången kan det ta en stund. Den anpassade videon
				sparas till nästa gång.
			</p>
		{/if}
		{#key src}
			<!-- Source videos have no caption track. Only the opened slide mounts a player. -->
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				{src}
				controls
				playsinline
				preload="metadata"
				onerror={onError}
				onloadeddata={() => (loading = false)}
				class="min-h-0 max-w-full rounded-md"
			></video>
		{/key}
	</div>
{/if}
