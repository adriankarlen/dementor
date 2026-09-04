<script lang="ts">
	/**
	 * Re-auth panel: shown globally when any section's sync hits an
	 * InfoMentor session-expired response. The dashboard session stays
	 * alive; we only need a fresh IM password to swap in a new cookie
	 * jar. Username comes from the server-side session map (the UI
	 * doesn't see it as an editable field).
	 *
	 * Used by section pages — the parent passes the result of
	 * `SyncIndicator.onsessionexpired` into the `show` prop. On
	 * success, `onreauthed` fires (typically: retry the sync that
	 * just failed).
	 */
	interface Props {
		show: boolean;
		onsuccess?: () => void;
		oncancel?: () => void;
	}

	let { show = $bindable(), onsuccess, oncancel }: Props = $props();

	let password = $state('');
	let busy = $state(false);
	let errorDetail: string | null = $state(null);

	async function submit(event: Event) {
		event.preventDefault();
		if (!password) {
			errorDetail = 'Lösenord krävs.';
			return;
		}
		busy = true;
		errorDetail = null;
		try {
			const res = await fetch('/api/reauth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (res.ok) {
				password = '';
				show = false;
				onsuccess?.();
				return;
			}
			// SAFETY: `res.json()` returns `Promise<any>`; the cast below
			// narrows to the documented `{error, detail}` shape returned
			// by `/api/reauth`. The `?.` chain handles a body that failed
			// to parse as JSON.
			const body = (await res.json().catch(() => null)) as {
				error?: string;
				detail?: string;
			} | null;
			if (body?.error === 'login_failed') {
				errorDetail = body.detail ?? 'Inloggning misslyckades';
			} else {
				errorDetail = body?.detail ?? `HTTP ${res.status}`;
			}
		} catch (err) {
			errorDetail = err instanceof Error ? err.message : 'nätverksfel';
		} finally {
			busy = false;
		}
	}

	function close() {
		password = '';
		errorDetail = null;
		show = false;
		oncancel?.();
	}
</script>

{#if show}
	<div
		class="mx-auto mt-6 w-full max-w-md rounded-2xl border-2 border-border bg-card p-5 shadow-md"
		role="alertdialog"
		aria-labelledby="reauth-title"
	>
		<h2 id="reauth-title" class="text-lg font-semibold">InfoMentor-sessionen har gått ut</h2>
		<p class="mt-1 text-sm text-muted-foreground">
			Logga in på InfoMentor igen för att fortsätta hämta data. Dementor-sessionen påverkas inte.
		</p>

		<form onsubmit={submit} class="mt-4 space-y-3">
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Lösenord</span>
				<input
					type="password"
					autocomplete="current-password"
					bind:value={password}
					disabled={busy}
					required
					class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				/>
			</label>

			{#if errorDetail}
				<p class="text-sm text-destructive" role="alert">{errorDetail}</p>
			{/if}

			<div class="flex items-center gap-2">
				<button
					type="submit"
					disabled={busy}
					class="rounded-md border-2 border-border bg-amber-400 px-4 py-2 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm active:translate-x-[1px] active:translate-y-[1px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
				>
					{busy ? 'Loggar in…' : 'Logga in'}
				</button>
				<button
					type="button"
					onclick={close}
					disabled={busy}
					class="rounded-md border-2 border-border bg-background px-3 py-2 text-sm shadow-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
				>
					Avbryt
				</button>
			</div>
		</form>
	</div>
{/if}
