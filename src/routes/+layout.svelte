<script lang="ts">
	import { page } from '$app/state';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { Button } from '$lib/components/ui/button/index.js';

	let { children, data } = $props();

	const sections = [
		{ href: '/larLogg', label: 'Lärlogg' },
		{ href: '/kalender', label: 'Kalender' },
		{ href: '/nyheter', label: 'Nyheter' },
		{ href: '/dokument', label: 'Dokument' },
		{ href: '/barn', label: 'Barn' }
	];

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex min-h-svh flex-col">
	{#if data.infoMentor}
		<header class="border-b-2 border-border bg-background">
			<div
				class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8"
			>
				<a href="/larLogg" class="font-sans text-lg font-semibold">dementor</a>
				<div class="flex items-center gap-3">
					<span class="text-sm text-muted-foreground">@{data.infoMentor.username}</span>
					<form method="POST" action="/logout">
						<Button type="submit" variant="outline" size="sm">Logga ut</Button>
					</form>
				</div>
			</div>
			<nav class="mx-auto max-w-3xl px-4 pb-3 sm:px-8">
				<ul class="flex flex-wrap gap-2">
					{#each sections as section (section.href)}
						<li>
							<a
								href={section.href}
								aria-current={isActive(section.href) ? 'page' : undefined}
								class="inline-flex items-center rounded-md border-2 border-border px-3 py-1.5 text-sm font-semibold shadow-xs transition-transform hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-sm aria-[current=page]:translate-x-[1px] aria-[current=page]:translate-y-[1px] aria-[current=page]:bg-amber-400 aria-[current=page]:shadow-none"
							>
								{section.label}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		</header>
	{/if}

	<main class="flex-1">
		{@render children()}
	</main>
</div>
