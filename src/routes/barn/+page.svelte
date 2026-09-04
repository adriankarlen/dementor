<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Barn · dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-8">
	<header>
		<h1 class="text-3xl font-semibold">Hantera barn</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Barn-listan används för att hämta Lärlogg och kalender. Om auto-upptäckt inte hittar dina barn
			kan du lägga till dem manuellt här.
		</p>
	</header>

	{#if data.pupils.length === 0}
		<div class="rounded-2xl border-2 border-border bg-card p-6 shadow-md">
			<p class="text-sm">Inga barn i cachen. Lägg till ett barn nedan för att börja hämta data.</p>
		</div>
	{:else}
		<ul class="divide-y-2 divide-border rounded-2xl border-2 border-border bg-card shadow-md">
			{#each data.pupils as pupil (pupil.switchId)}
				<li class="flex items-center justify-between gap-3 px-4 py-3">
					<div>
						<div class="font-medium">
							{pupil.displayName ?? `Pupil ${pupil.switchId}`}
						</div>
						<div class="text-xs text-muted-foreground">switchId: {pupil.switchId}</div>
					</div>
					<form method="POST" action="?/remove" use:enhance>
						<input type="hidden" name="switchId" value={pupil.switchId} />
						<button
							type="submit"
							class="rounded-md border-2 border-border bg-background px-3 py-1.5 text-xs font-semibold shadow-xs hover:bg-muted"
						>
							Ta bort
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<form
		method="POST"
		action="?/add"
		use:enhance
		class="space-y-3 rounded-2xl border-2 border-border bg-card p-6 shadow-md"
	>
		<h2 class="text-lg font-semibold">Lägg till barn</h2>
		<label class="block space-y-1.5">
			<span class="text-sm font-medium">switchId</span>
			<input
				name="switchId"
				type="text"
				inputmode="numeric"
				required
				value={(form as { switchId?: string } | null)?.switchId ?? ''}
				placeholder="t.ex. 3887588"
				class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
			<span class="text-xs text-muted-foreground">
				Hittas på InfoMentor → klicka på barn-växlaren → högerklicka barnets namn → "Inspektera" →
				kopiera numret i slutet av
				<code>SwitchPupil/...</code>-länken.
			</span>
		</label>
		<label class="block space-y-1.5">
			<span class="text-sm font-medium">Visningsnamn (valfritt)</span>
			<input
				name="displayName"
				type="text"
				value={(form as { displayName?: string } | null)?.displayName ?? ''}
				placeholder="t.ex. Aston"
				class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
		</label>

		{#if (form as { error?: string } | null)?.error}
			<p class="text-sm text-destructive" role="alert">
				{(form as { error?: string } | null)?.error}
			</p>
		{/if}

		<button
			type="submit"
			class="rounded-md border-2 border-border bg-amber-400 px-4 py-2 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm"
		>
			Lägg till
		</button>
	</form>
</section>
