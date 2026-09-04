<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-12 sm:px-8">
	<h1 class="text-3xl font-semibold">Hej!</h1>
	{#if page.data.infoMentor}
		<p class="text-muted-foreground">
			Inloggad på InfoMentor som <strong>@{page.data.infoMentor.username}</strong>.
		</p>
	{/if}
	<p class="text-muted-foreground">
		Det här är Phase 2 — InfoMentor-inloggningen fungerar. Resterande faser (cache, kalender,
		lärlogg, nyheter) kommer enligt
		<code class="rounded bg-muted px-1 py-0.5">docs/implementation-plan.md</code>.
	</p>
</section>
