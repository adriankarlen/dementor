// Nyheter page server load: serve cached news items, sorted by
// `publishedDate` desc (the API returns them that way, and the SQL
// order_by is by entry_id which correlates with publish time for
// news).
import type { PageServerLoad } from './$types';

import { listNewsEntries } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return {
		entries: listNewsEntries()
	};
};
