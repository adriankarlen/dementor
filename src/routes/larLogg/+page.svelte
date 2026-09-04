<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ReauthPanel from '$lib/components/reauth-panel.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';

	let { data } = $props();

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
</script>

<svelte:head><title>Lärlogg · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Lärlogg</h1>
		<SyncIndicator
			url="/api/sync/learnlog"
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if data.entries.length === 0}
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
						href="/barn"
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
			{#each data.entries as entry (entry.pupilSwitchId + ':' + entry.entryId)}
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
						<p class="mt-3 text-xs text-muted-foreground">
							{entry.json.media.length} bifogade media — cachas i Fas 4.
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
