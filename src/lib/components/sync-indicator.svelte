<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SyncStatus } from '$lib/sync-status';

	interface Props {
		url: string;
		label?: string;
		onsessionexpired?: () => void;
		onrefresh?: () => Promise<void>;
	}

	let {
		url,
		label = 'Hämtar senaste…',
		onsessionexpired,
		onrefresh = invalidateAll
	}: Props = $props();
	let refreshing = $state(true);
	let errorDetail = $state<string | null>(null);
	let moreHistory = $state(false);
	let historyPaused = $state(false);
	let controller: AbortController | undefined;

	async function sync() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		refreshing = true;
		errorDetail = null;
		moreHistory = false;
		historyPaused = false;
		let method = 'POST';
		let revision: number | undefined;
		try {
			for (;;) {
				const response = await fetch(url, { method, signal: current.signal, cache: 'no-store' });
				if (response.redirected) {
					await goto(resolve('/login'));
					return;
				}
				// SAFETY: our own sync endpoints return the shared SyncStatus contract.
				const body = (await response.json()) as SyncStatus;
				if (current.signal.aborted) return;
				if (body.error === 'session_expired') {
					onsessionexpired?.();
					return;
				}
				if (!response.ok || !body.ok) {
					errorDetail = body.detail ?? `HTTP ${response.status}`;
					// Keep successful partial batches visible even after a later failure.
					await onrefresh();
					return;
				}
				if (!body.running || body.revision !== revision) {
					await onrefresh();
					revision = body.revision;
				}
				moreHistory = body.summary?.moreHistory ?? false;
				historyPaused = body.summary?.historyPaused ?? false;
				if (!body.running) return;
				await new Promise((resolve) => setTimeout(resolve, 1500));
				if (current.signal.aborted) return;
				method = 'GET';
			}
		} catch (err) {
			if (!current.signal.aborted) errorDetail = err instanceof Error ? err.message : 'nätverksfel';
		} finally {
			if (!current.signal.aborted) refreshing = false;
		}
	}

	export function retry() {
		return sync();
	}

	onMount(() => {
		void sync();
		return () => controller?.abort();
	});
</script>

{#if refreshing}
	<p
		class="inline-flex items-center gap-2 rounded-md border-2 border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-xs"
		role="status"
	>
		<span class="inline-block size-2 rounded-full bg-amber-400 motion-safe:animate-pulse"></span>
		{label}
	</p>
{:else if errorDetail}
	<p class="text-sm text-destructive" role="alert">
		Synk misslyckades: {errorDetail}
		<button class="ml-2 underline" onclick={sync}>Försök igen</button>
	</p>
{:else if moreHistory}
	<div class="max-w-56 min-w-0 space-y-2 text-sm">
		{#if historyPaused}
			<p class="text-xs text-muted-foreground" role="status">
				InfoMentor upprepade en sida. Hämtningen av äldre inlägg är pausad; hämtade inlägg finns
				kvar.
			</p>
		{/if}
		<button
			class="rounded-md border-2 border-border bg-card px-3 py-1.5 text-sm shadow-xs"
			onclick={sync}
		>
			Hämta äldre inlägg
		</button>
	</div>
{/if}
