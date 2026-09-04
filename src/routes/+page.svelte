<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>dementor</title></svelte:head>

<section class="mx-auto max-w-2xl space-y-6 px-4 py-12 sm:px-8">
	<h1 class="text-3xl font-semibold">Hej {page.data.user?.displayName ?? ''}!</h1>
	<p class="text-muted-foreground">
		Det här är Phase 1 — inloggningen fungerar. Resterande faser (InfoMentor-koppling, datahämtning,
		kalender, lärlogg, nyheter) kommer enligt
		<code class="rounded bg-muted px-1 py-0.5">docs/implementation-plan.md</code>.
	</p>
</section>
