// Dokument page server load: serve cached documents, sorted by
// entry_id desc (newest first).
import type { PageServerLoad } from './$types';

import { listDocuments } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return {
		entries: listDocuments()
	};
};
