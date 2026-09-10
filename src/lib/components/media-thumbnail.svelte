<script lang="ts">
	import { getMediaSession } from '$lib/media-session';
	let { fileId, video = false }: { fileId: number; video?: boolean } = $props();
	const session = getMediaSession();
	const key = $derived(`${fileId}:${session.revision}`);
	let failedKey = $state<string | null>(null);
	function onError() {
		failedKey = key;
		void session.check();
	}
</script>

<div class="relative flex aspect-square h-full w-full items-center justify-center bg-muted">
	{#if failedKey !== key}
		<img
			src={`/media/${fileId}?thumbnail=1`}
			alt=""
			loading="lazy"
			decoding="async"
			class="h-full w-full object-cover"
			onerror={onError}
		/>
	{:else}
		<span class="p-2 text-center text-xs text-muted-foreground">Förhandsvisning saknas</span>
	{/if}
	{#if video}
		<span
			class="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white"
			aria-hidden="true">▶ Video</span
		>
	{/if}
</div>
