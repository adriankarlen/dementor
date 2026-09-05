<script lang="ts">
	/**
	 * Full-screen photo/video lightbox with carousel navigation for
	 * one Lärlogg entry's media array. Uses the native `<dialog>`
	 * element for its built-in modal semantics (focus trapping,
	 * Escape-to-close, `::backdrop`) rather than a hand-rolled
	 * fixed-position overlay + manual focus management.
	 *
	 * Visual language matches the rest of the app: a floating card
	 * (`border-2 border-border`, hard offset shadow) rather than an
	 * edge-to-edge black screen, over a translucent/blurred version
	 * of the page's own background (`::backdrop`, styled below)
	 * instead of opaque black — the point being it should read as
	 * "a panel over this page", not "a different app took over".
	 * Buttons reuse the exact classes used elsewhere (see
	 * reauth-panel.svelte's secondary button, +layout.svelte's nav).
	 *
	 * `resolveSrc` is supplied by the caller (the Lärlogg page)
	 * because "is this file cached locally?" is page-level state
	 * (`cachedMediaFileIds`) — this component only knows how to
	 * render whatever URL it's given, same split as `thumbSrc`/
	 * `fullSrc` on the page itself.
	 */
	export interface LightboxMediaItem {
		fileId: number;
		fileType: string;
		fileExtension: string;
		thumbnailUrl: string;
		fileUrl: string;
	}

	interface Props {
		open: boolean;
		media: LightboxMediaItem[];
		index: number;
		resolveSrc: (fileId: number, fallbackRelativeUrl: string) => string;
	}

	let { open = $bindable(false), media, index = $bindable(0), resolveSrc }: Props = $props();

	const current = $derived(media[index]);

	function isVideo(fileType: string): boolean {
		return fileType.toLowerCase() === 'video';
	}

	function close() {
		open = false;
	}

	function goPrev() {
		if (media.length === 0) return;
		index = (index - 1 + media.length) % media.length;
	}

	function goNext() {
		if (media.length === 0) return;
		index = (index + 1) % media.length;
	}

	/**
	 * Arrow-key carousel nav, skipped while a `<video>` (or its
	 * native controls) has focus — browsers already bind left/right
	 * there to seeking, and having both fire at once is confusing.
	 * Escape-to-close is handled natively by `<dialog>`; not
	 * duplicated here.
	 */
	function onKeydown(event: KeyboardEvent) {
		if (event.target instanceof HTMLVideoElement) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			goPrev();
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			goNext();
		}
	}

	/** Click on the empty area around the media (not the media
	 *  itself, not a button) closes the lightbox — the common
	 *  "click outside the photo" lightbox convention. */
	function onStageClick(event: MouseEvent) {
		if (event.target === event.currentTarget) close();
	}

	/**
	 * Keeps the native `<dialog>`'s imperative open/closed state in
	 * sync with the `open` prop. Re-runs whenever `open` changes
	 * (it's read inside the function body, so the attach effect
	 * tracks it) — see references/attach.md's "sync state to an
	 * external library" guidance. The dialog's own `close` event
	 * (Escape key) is mirrored back via `onclose` below so a
	 * keyboard close also flips the bindable prop.
	 */
	function syncOpenState(node: HTMLDialogElement) {
		if (open) {
			if (!node.open) node.showModal();
		} else if (node.open) {
			node.close();
		}
	}

	/**
	 * Keeps the filmstrip scrolled so its active thumbnail stays
	 * visible — both on carousel navigation (prev/next, arrow keys,
	 * clicking a different thumbnail) and on the initial open, when
	 * the clicked photo might be far enough into the entry's media
	 * that its thumbnail starts outside the visible strip. `active`
	 * is recomputed for every thumbnail whenever `index` changes, so
	 * this attachment re-runs (and scrolls) exactly for whichever
	 * button just became the active one — harmless no-op for the
	 * rest. `inline`/`block: 'nearest'` restricts the scroll to just
	 * the filmstrip's own horizontal scrollbox rather than nudging
	 * the whole page.
	 */
	function scrollActiveIntoView(active: boolean) {
		return (node: HTMLElement) => {
			if (active) {
				node.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
			}
		};
	}
</script>

<dialog
	{@attach syncOpenState}
	onclose={() => (open = false)}
	onkeydown={onKeydown}
	class="lightbox-dialog m-auto h-dvh w-dvw max-w-none overflow-hidden border-0 bg-card p-0 text-foreground sm:h-[88dvh] sm:w-[92vw] sm:max-w-4xl sm:rounded-2xl sm:border-2 sm:border-border sm:shadow-lg"
>
	{#if current}
		<div class="flex h-full flex-col">
			<div class="flex items-center justify-between border-b-2 border-border px-4 py-3">
				<span class="text-sm text-muted-foreground">{index + 1} / {media.length}</span>
				<button
					type="button"
					onclick={close}
					class="rounded-md border-2 border-border bg-background px-3 py-1.5 text-sm font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:bg-muted hover:shadow-sm active:translate-x-[1px] active:translate-y-[1px] active:shadow-none"
				>
					Stäng ✕
				</button>
			</div>

			<!-- Mouse-only convenience: keyboard users already have a
		     full equivalent via Escape, handled natively by <dialog>
		     (see syncOpenState/onclose above). -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-900 p-2 sm:p-4"
				onclick={onStageClick}
			>
				{#if media.length > 1}
					<button
						type="button"
						onclick={goPrev}
						aria-label="Föregående"
						class="absolute left-2 z-10 flex size-10 items-center justify-center rounded-md border-2 border-border bg-background text-xl leading-none font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:bg-muted hover:shadow-sm active:translate-x-[1px] active:translate-y-[1px] active:shadow-none sm:left-4"
					>
						‹
					</button>
				{/if}

				{#key current.fileId}
					{#if isVideo(current.fileType)}
						<!-- svelte-ignore a11y_media_has_caption -->
						<!-- InfoMentor's Lärlogg videos are short parent-recorded
					     clips with no caption track available from the source
					     — nothing to point a <track> at. -->
						<video
							src={resolveSrc(current.fileId, current.fileUrl)}
							controls
							playsinline
							class="max-h-full max-w-full rounded-md"
						></video>
					{:else}
						<img
							src={resolveSrc(current.fileId, current.fileUrl)}
							alt=""
							class="max-h-full max-w-full rounded-md object-contain"
						/>
					{/if}
				{/key}

				{#if media.length > 1}
					<button
						type="button"
						onclick={goNext}
						aria-label="Nästa"
						class="absolute right-2 z-10 flex size-10 items-center justify-center rounded-md border-2 border-border bg-background text-xl leading-none font-semibold shadow-xs hover:translate-x-[-1px] hover:translate-y-[-1px] hover:bg-muted hover:shadow-sm active:translate-x-[1px] active:translate-y-[1px] active:shadow-none sm:right-4"
					>
						›
					</button>
				{/if}
			</div>

			{#if media.length > 1}
				<div class="flex min-w-0 gap-2 overflow-x-auto border-t-2 border-border bg-card px-4 py-3">
					{#each media as m, i (m.fileId)}
						<button
							type="button"
							onclick={() => (index = i)}
							aria-label={`Media ${i + 1}`}
							aria-current={i === index}
							{@attach scrollActiveIntoView(i === index)}
							class={`h-14 w-14 flex-none overflow-hidden rounded-md border-2 shadow-xs transition-transform ${
								i === index
									? 'border-amber-400 shadow-sm'
									: 'border-border opacity-70 hover:-translate-x-px hover:-translate-y-px hover:opacity-100 hover:shadow-sm'
							}`}
						>
							{#if isVideo(m.fileType)}
								<video
									src={resolveSrc(m.fileId, m.thumbnailUrl || m.fileUrl)}
									muted
									class="h-full w-full object-cover"
								></video>
							{:else}
								<img
									src={resolveSrc(m.fileId, m.thumbnailUrl || m.fileUrl)}
									alt=""
									class="h-full w-full object-cover"
								/>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</dialog>

<style>
	/* `<dialog>`'s UA stylesheet centers it with an auto margin —
	   kept (not overridden with `position: fixed; inset: 0`) so the
	   sm:-and-up sizing above centers as a floating panel rather
	   than pinning to the viewport edges. `::backdrop` isn't
	   reachable with Tailwind utility classes, so it gets a plain
	   rule: a translucent, blurred tint of the page's OWN background
	   colour (light/dark aware via the `--background` custom
	   property already set in layout.css) rather than opaque black —
	   the goal is "a panel floating over this page", not "a
	   different, disconnected screen".

	   The explicit `display: none` below matters: the browser's own
	   UA stylesheet has `dialog:not([open]) { display: none }`, but
	   author-origin CSS (Tailwind's utility classes) always wins over
	   UA-origin CSS at equal importance — so if this component (or a
	   future edit) ever puts a `display` utility directly on the
	   dialog element itself, `.close()` would stop actually hiding
	   it (only `::backdrop` is native-browser-controlled, not this
	   box). Keeping all layout on the inner wrapper div avoids that,
	   and this rule is a defensive backstop.*/
	.lightbox-dialog:not([open]) {
		display: none;
	}

	.lightbox-dialog::backdrop {
		background: color-mix(in oklch, var(--background) 55%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
</style>
