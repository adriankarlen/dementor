<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { Button } from '$lib/components/ui/button/index.js';

	let { children, data } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex min-h-svh flex-col">
	{#if data.infoMentor}
		<header
			class="flex items-center justify-between gap-4 border-b-2 border-border bg-background px-4 py-3 sm:px-8"
		>
			<a href="/" class="font-sans text-lg font-semibold">dementor</a>
			<div class="flex items-center gap-3">
				<span class="text-sm text-muted-foreground">@{data.infoMentor.username}</span>
				<form method="POST" action="/logout">
					<Button type="submit" variant="outline" size="sm">Logga ut</Button>
				</form>
			</div>
		</header>
	{/if}

	<main class="flex-1">
		{@render children()}
	</main>
</div>
