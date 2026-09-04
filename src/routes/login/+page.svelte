<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data, form } = $props();
</script>

<svelte:head><title>Logga in · dementor</title></svelte:head>

<div class="flex min-h-svh items-center justify-center px-4 py-12">
	<form
		method="POST"
		class="w-full max-w-sm space-y-5 rounded-2xl border-2 border-border bg-card p-6 shadow-md"
		use:enhance
	>
		<header class="space-y-1">
			<h1 class="text-2xl font-semibold">dementor</h1>
			<p class="text-sm text-muted-foreground">Logga in för att fortsätta.</p>
		</header>

		<input type="hidden" name="redirect" value={data.redirect} />

		<label class="block space-y-1.5">
			<span class="text-sm font-medium">Användarnamn</span>
			<input
				name="username"
				type="text"
				autocomplete="username"
				required
				value={form?.username ?? ''}
				class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
		</label>

		<label class="block space-y-1.5">
			<span class="text-sm font-medium">Lösenord</span>
			<input
				name="password"
				type="password"
				autocomplete="current-password"
				required
				class="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
		</label>

		{#if form?.error}
			<p class="text-sm text-destructive" role="alert">{form.error}</p>
		{/if}

		<Button type="submit" class="w-full">Logga in</Button>
	</form>
</div>
