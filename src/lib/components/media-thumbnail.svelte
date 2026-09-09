<script lang="ts">
	let { fileId, video = false }: { fileId: number; video?: boolean } = $props();
	let failed = $state(false);
</script>

<div class="relative flex aspect-square h-full w-full items-center justify-center bg-muted">
	{#if !failed}
		<img
			src={`/media/${fileId}?thumbnail=1`}
			alt=""
			loading="lazy"
			decoding="async"
			class="h-full w-full object-cover"
			onerror={() => (failed = true)}
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
