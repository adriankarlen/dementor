<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { readSync } from '$lib/read-sync';

	interface Props {
		url: string;
		label?: string;
		onsessionexpired?: () => void;
		onrefresh?: () => Promise<void>;
		refreshing?: boolean;
		moreHistory?: boolean;
		historyPaused?: boolean;
		historyAtEnd?: boolean;
	}

	let {
		url,
		label = 'Hämtar senaste…',
		onsessionexpired,
		onrefresh = invalidateAll,
		refreshing = $bindable(true),
		moreHistory = $bindable(false),
		historyPaused = $bindable(false),
		historyAtEnd = false
	}: Props = $props();
	let errorDetail = $state<string | null>(null);
	let controller: AbortController | undefined;
	let lastHistory = false;

	async function sync(history = false) {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		refreshing = true;
		errorDetail = null;
		historyPaused = false;
		lastHistory = history;
		try {
			const response = await fetch(history ? `${url}?history=1` : url, {
				method: 'POST',
				signal: current.signal,
				cache: 'no-store'
			});
			if (response.redirected) {
				await goto(resolve('/login'));
				return;
			}
			for await (const body of readSync(response)) {
				if (current.signal.aborted) return;
				// Read committed SQLite rows even if a later pupil/media call failed.
				await onrefresh();
				if (body.error === 'session_expired') {
					onsessionexpired?.();
					return;
				}
				if (!response.ok || !body.ok) {
					errorDetail = body.detail ?? `HTTP ${response.status}`;
					historyPaused = true;
					return;
				}
				moreHistory = body.summary?.moreHistory ?? false;
				historyPaused = body.summary?.historyPaused ?? false;
				if (!body.running) return;
			}
		} catch (err) {
			if (!current.signal.aborted) {
				errorDetail = err instanceof Error ? err.message : 'nätverksfel';
				historyPaused = true;
			}
		} finally {
			if (!current.signal.aborted) refreshing = false;
		}
	}

	export function retry() {
		return sync(lastHistory);
	}

	export function loadHistory() {
		return sync(true);
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
		<button class="ml-2 underline" onclick={retry}>Försök igen</button>
	</p>
{:else if moreHistory && !historyAtEnd}
	<div class="max-w-56 min-w-0 space-y-2 text-sm">
		{#if historyPaused}
			<p class="text-xs text-muted-foreground" role="status">
				InfoMentor upprepade en sida. Hämtningen av äldre inlägg är pausad; hämtade inlägg finns
				kvar.
			</p>
		{/if}
		<button
			class="rounded-md border-2 border-border bg-card px-3 py-1.5 text-sm shadow-xs"
			onclick={loadHistory}
		>
			Hämta äldre inlägg
		</button>
	</div>
{/if}
