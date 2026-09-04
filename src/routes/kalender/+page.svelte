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

	const typeColorById = $derived(
		new Map(
			data.calendarEntryTypes.map((t: { id: number; colour: string }) => [t.id, t.colour] as const)
		)
	);

	interface DayGroup {
		key: string;
		label: string;
		items: typeof data.entries;
	}

	const grouped = $derived.by((): DayGroup[] => {
		const byDay = new Map<string, DayGroup>();
		for (const entry of data.entries) {
			// startDateFull is e.g. "2026-09-21T08:00:00"; take the day prefix.
			const dayKey = (entry.json.startDateFull ?? '').slice(0, 10);
			if (!dayKey) continue;
			let group = byDay.get(dayKey);
			if (!group) {
				const label = new Date(dayKey).toLocaleDateString('sv-SE', {
					weekday: 'long',
					day: 'numeric',
					month: 'long'
				});
				group = { key: dayKey, label, items: [] };
				byDay.set(dayKey, group);
			}
			group.items.push(entry);
		}
		return [...byDay.values()];
	});
</script>

<svelte:head><title>Kalender · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header class="flex items-center justify-between gap-3">
		<h1 class="text-3xl font-semibold">Kalender</h1>
		<SyncIndicator
			url="/api/sync/calendar"
			onsessionexpired={() => (reauthShow = true)}
			bind:this={syncRef}
		/>
	</header>

	<ReauthPanel bind:show={reauthShow} onsuccess={() => syncRef?.retry()} />

	{#if grouped.length === 0}
		{#if data.pupils.length === 0}
			<div class="rounded-2xl border-2 border-border bg-card p-6 shadow-md">
				<p class="text-sm">
					Inga barn hittades på ditt InfoMentor-konto. Klicka nedan för att försöka hämta
					barn-listan igen, eller lägg till barn manuellt.
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
				Inga kalenderhändelser cachade ännu. Hämtar nu — sidan uppdateras automatiskt.
			</p>
		{/if}
	{:else}
		<div class="space-y-6">
			{#each grouped as group (group.key)}
				<div>
					<h2 class="mb-2 text-sm font-bold tracking-wide text-muted-foreground uppercase">
						{group.label}
					</h2>
					<ul class="divide-y-2 divide-border rounded-2xl border-2 border-border bg-card shadow-md">
						{#each group.items as entry (entry.pupilSwitchId + ':' + entry.entryId)}
							<li class="flex items-start gap-3 px-4 py-3">
								<span
									class="mt-1 inline-block size-3 flex-none rounded border-2 border-border"
									style:background-color={(typeColorById.get(entry.json.calendarEntryTypeId) as
										string | undefined) ?? '#ddd'}
								></span>
								<div class="min-w-0 flex-1">
									<div class="font-medium">{entry.json.title}</div>
									<div class="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
										<span
											class="rounded-md border-2 border-border bg-amber-200 px-2 py-0.5 font-semibold text-foreground"
										>
											{pupilLabel(entry.pupilSwitchId)}
										</span>
										{#if entry.json.formattedStartDate}
											<span>{entry.json.formattedStartDate}</span>
										{/if}
									</div>
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/if}
</section>
