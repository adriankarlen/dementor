<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	/**
	 * Tiny "cached data + refresh in background" wrapper. Pages drop
	 * this in at the top of their body; it fires `fetch(url)` on
	 * mount, tracks the in-flight state, and calls `invalidateAll()`
	 * when the sync resolves so the page re-renders from the cache.
	 *
	 * Session expiry is signaled up via the `onsessionexpired`
	 * callback so the parent can show a re-auth panel — the wrapper
	 * itself just sets `expired = true` and stops.
	 *
	 * Props:
	 *   url     — POST endpoint to fire (e.g. '/api/sync/learnlog')
	 *   label   — visible text while syncing ("Hämtar senaste…")
	 */
	interface Props {
		url: string;
		label?: string;
		onsessionexpired?: () => void;
	}

	let { url, label = 'Hämtar senaste…', onsessionexpired }: Props = $props();

	let refreshing = $state(true);
	let errorDetail: string | null = $state(null);
	let expired = $state(false);

	async function sync() {
		refreshing = true;
		errorDetail = null;
		expired = false;
		try {
			const res = await fetch(url, { method: 'POST' });
			if (res.status === 401) {
				// SAFETY: `res.json()` returns `Promise<any>`; the cast below
				// narrows to the documented `{error: 'session_expired'}`
				// shape returned by `/api/sync/[section]`.
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				if (body?.error === 'session_expired') {
					expired = true;
					onsessionexpired?.();
					return;
				}
			}
			if (!res.ok) {
				// SAFETY: `res.json()` returns `Promise<any>`; the cast below
				// narrows to the documented `{detail?: string}` shape
				// returned by `/api/sync/[section]` on generic errors.
				const body = (await res.json().catch(() => null)) as { detail?: string } | null;
				errorDetail = body?.detail ?? `HTTP ${res.status}`;
				return;
			}
			await invalidateAll();
		} catch (err) {
			errorDetail = err instanceof Error ? err.message : 'nätverksfel';
		} finally {
			refreshing = false;
		}
	}

	/** Public retry entry point — used after a successful re-auth. */
	export function retry() {
		return sync();
	}

	onMount(sync);
</script>

{#if refreshing}
	<p
		class="inline-flex items-center gap-2 rounded-md border-2 border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-xs"
		role="status"
		aria-live="polite"
	>
		<span class="inline-block size-2 animate-pulse rounded-full bg-amber-400"></span>
		{label}
	</p>
{:else if errorDetail && !expired}
	<p class="text-sm text-destructive" role="alert">
		Synk misslyckades: {errorDetail}
		<button class="ml-2 underline" onclick={() => sync()}>Försök igen</button>
	</p>
{/if}
