<script lang="ts">
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';

	let { data } = $props();

	let reauthShow = $state(false);
	let syncRef = $state<{ retry: () => Promise<void> } | null>(null);

	function formatBytes(bytes: number | undefined): string {
		if (bytes === undefined || bytes === null) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// InfoMentor document fileUrls are same-origin relative paths on
	// hub.infomentor.se. We resolve to absolute so the link works
	// regardless of where the dashboard is hosted.
	function absoluteFileUrl(relative: string): string {
		try {
			return new URL(relative, 'https://hub.infomentor.se/').href;
		} catch {
			return relative;
		}
	}
</script>

<svelte:head><title>Dokument · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Dokument</h1>
		<SyncIndicator
			url="/api/sync/documents"
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if data.entries.length === 0}
		<p
			class="rounded-md border-2 border-border bg-card p-6 text-sm text-muted-foreground shadow-xs"
		>
			Inga dokument cachade ännu. Hämtar nu — sidan uppdateras automatiskt.
		</p>
	{:else}
		<ul class="divide-y-2 divide-border rounded-2xl border-2 border-border bg-card shadow-md">
			{#each data.entries as entry (entry.entryId)}
				<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
					<div class="min-w-0 flex-1">
						<div class="truncate font-medium">{entry.json.title}</div>
						<div class="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
							{#if entry.json.publishedDateString}
								<span>{entry.json.publishedDateString}</span>
							{/if}
							{#if entry.json.fileSize !== undefined}
								<span>· {formatBytes(entry.json.fileSize)}</span>
							{/if}
							{#if entry.json.type}
								<span>· {entry.json.type}</span>
							{/if}
						</div>
					</div>
					<a
						href={absoluteFileUrl(entry.json.fileUrl)}
						target="_blank"
						rel="noopener"
						class="rounded-md border-2 border-border bg-amber-400 px-3 py-1.5 text-xs font-bold tracking-wide uppercase shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm"
					>
						Öppna
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>
