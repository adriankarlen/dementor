<script lang="ts">
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';

	let { data } = $props();

	let reauthShow = $state(false);
	let syncRef = $state<{ retry: () => Promise<void> } | null>(null);
</script>

<svelte:head><title>Nyheter · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Nyheter</h1>
		<SyncIndicator
			url="/api/sync/news"
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if data.entries.length === 0}
		<p
			class="rounded-md border-2 border-border bg-card p-6 text-sm text-muted-foreground shadow-xs"
		>
			Inga nyheter cachade ännu. Hämtar nu — sidan uppdateras automatiskt.
		</p>
	{:else}
		<ul class="space-y-4">
			{#each data.entries as entry (entry.entryId)}
				<li class="rounded-2xl border-2 border-border bg-card p-5 shadow-md">
					<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						{#if entry.json.publishedDateString}
							<span>{entry.json.publishedDateString}</span>
						{/if}
						{#if entry.json.publishedBy}
							<span>· {entry.json.publishedBy}</span>
						{/if}
					</div>
					<h2 class="mb-2 text-lg font-semibold">{entry.json.title}</h2>
					<!--
						News content is pre-formatted HTML from InfoMentor (same
						provenance as Lärlogg text) per docs/api-notes.md.
					-->
					<div class="news-content prose prose-sm max-w-none">
						{@html entry.json.content}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
