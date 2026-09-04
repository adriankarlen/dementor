<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data, form } = $props();
	let submitting = $state(false);
</script>

<svelte:head><title>Logga in · dementor</title></svelte:head>

<div class="flex min-h-svh items-center justify-center px-4 py-12">
	<form
		method="POST"
		class="w-full max-w-sm space-y-5 rounded-2xl border-2 border-border bg-card p-6 shadow-md"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<header class="space-y-1">
			<h1 class="text-2xl font-semibold">dementor</h1>
			<p class="text-sm text-muted-foreground">Logga in på InfoMentor för att fortsätta.</p>
		</header>

		<input type="hidden" name="redirect" value={data.redirect} />

		<fieldset class="space-y-4" disabled={submitting}>
			<legend class="sr-only">InfoMentor-inloggning</legend>

			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Användarnamn</span>
				<input
					name="infomentorUsername"
					type="text"
					autocomplete="username"
					required
					value={form?.infomentorUsername ?? ''}
					class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				/>
			</label>

			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Lösenord</span>
				<input
					name="infomentorPassword"
					type="password"
					autocomplete="current-password"
					required
					class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				/>
			</label>
		</fieldset>

		{#if form?.error}
			<p class="text-sm text-destructive" role="alert">{form.error}</p>
		{/if}

		<Button type="submit" disabled={submitting} class="w-full">
			{submitting ? 'Loggar in…' : 'Logga in'}
		</Button>
	</form>
</div>
