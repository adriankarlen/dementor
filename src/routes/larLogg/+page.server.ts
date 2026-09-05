// Lärlogg page server load: serve cached entries immediately, join
// with the pupil table so the UI can label each card with the
// child's name. No network calls happen here — SyncIndicator.svelte
// (mounted by the page) fires the background refresh.
//
// Phase 4: also surface the set of cached media file-ids so the
// page can render `<img src="/media/{id}">` for cached items and
// fall back to InfoMentor's own `thumbnailUrl`/`fileUrl` for ones
// that haven't been downloaded yet (e.g. brand-new post, first
// view).
import type { PageServerLoad } from './$types';

import { listCachedMediaFileIds, listLearnlogEntries, listPupils } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return {
		pupils: listPupils(),
		entries: listLearnlogEntries(),
		// `[...ids]` — SvelteKit serialises through devalue, sets of
		// numbers are supported but `[...set]` keeps the wire payload
		// tiny (an array) and the client re-wraps it in a Set for
		// O(1) lookups.
		cachedMediaFileIds: [...listCachedMediaFileIds()]
	};
};
