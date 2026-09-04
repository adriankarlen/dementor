// Lärlogg page server load: serve cached entries immediately, join
// with the pupil table so the UI can label each card with the
// child's name. No network calls happen here — SyncIndicator.svelte
// (mounted by the page) fires the background refresh.
import type { PageServerLoad } from './$types';

import { listLearnlogEntries, listPupils } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return {
		pupils: listPupils(),
		entries: listLearnlogEntries()
	};
};
