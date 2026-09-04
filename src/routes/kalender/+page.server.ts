// Kalender page server load: serve cached entries grouped by day.
// Sorting is by `startDateFull` (the API gives a full ISO-ish
// timestamp that string-sorts correctly), entries grouped client-
// side from the already-sorted list.
import type { PageServerLoad } from './$types';

import { getCachedCalendarEntryTypes, listCalendarEntries, listPupils } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return {
		pupils: listPupils(),
		entries: listCalendarEntries(),
		calendarEntryTypes: getCachedCalendarEntryTypes()
	};
};
