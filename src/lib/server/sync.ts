// Per-section sync orchestration. Each `sync*` function takes a
// cookie jar (the parent's authenticated InfoMentor session), walks
// the relevant endpoints, and writes results into the SQLite cache.
//
// Fetch strategies per the implementation plan:
//   - Lärlogg:    incremental, paginated, stop when a page brings
//                 back only already-known ids.
//   - Calendar:   fetch current month +/- 1, full upsert.
//   - News:       full refetch (pageSize: -1), wipe + reinsert.
//   - Documents:  full refetch, wipe + reinsert.
//
// Multi-pupil aggregation: before per-pupil work, call
// `switchPupil` on the hub — InfoMentor's session state is "the last
// pupil switched to", and subsequent API calls are scoped to that
// pupil until you switch again. Both parents share the on-disk cache,
// so any pupil discovered by either parent's login is visible to all.
//
// Per-section functions are independently usable from the API layer
// (`/api/sync/[section]`), so the section pages trigger only the
// piece they actually need. `syncAll` exists for the rare case of
// wanting a full cache warm — currently unused by the routes but
// useful as a debugging entry point.
import type { CookieJar } from './infomentor/cookieJar.ts';
import {
	calendarWindowForToday,
	discoverPupils,
	getCalendarAppData,
	getCalendarEntries,
	getDocuments,
	getLearnlogs,
	getNews,
	switchPupil
} from './infomentor/api.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import {
	highestLearnlogIdFor,
	listCachedMediaFileIds,
	listPupils,
	replaceDocuments,
	replaceNewsEntries,
	setCachedCalendarEntryTypes,
	upsertCalendarEntries,
	upsertLearnlogEntries,
	upsertPupil
} from './cache.ts';
import { cacheMediaForEntries } from './media.ts';
import type { LearnlogEntry } from './infomentor/api.ts';

// ---- Per-section sync functions ----

/**
 * "Latest only" Lärlogg sync: page through newest-first pages,
 * upserting entries we don't yet have, stopping as soon as a page
 * comes back entirely composed of already-known ids. Bounded by a
 * safety cap on page count so a server-side regression that returns
 * the same id forever can't loop the caller indefinitely.
 *
 * `pupilSwitchIds` defaults to every cached pupil; pass a subset to
 * sync just one (used by the per-pupil normal sync below).
 *
 * Media caching: phase 4 — downloaded per pupil, immediately
 * after that pupil's entry pages are upserted, while `switchPupil`
 * is still pointed at them. InfoMentor's media download endpoint
 * appears to be scoped to whichever pupil is currently active in
 * the session (not just the `connectionId` embedded in the media
 * URL) — downloading media only after the loop over ALL pupils
 * finished meant every pupil except the last one in the list got a
 * 401 on their photos, which this code mis-reported as a dead
 * InfoMentor session (reauth couldn't fix it because the session
 * was never actually the problem). Per-pupil ordering avoids that
 * mismatch entirely.
 */
export async function syncLearnlog(
	jar: CookieJar,
	pupilSwitchIds?: number[]
): Promise<{
	pupils: number;
	newEntries: number;
	pagesFetched: number;
	media: { attempted: number; downloaded: number; cached: number; failed: number };
}> {
	const ids = await resolvePupilIds(jar, pupilSwitchIds);
	let totalNew = 0;
	let totalPages = 0;
	const mediaTotals = { attempted: 0, downloaded: 0, cached: 0, failed: 0 };

	// Snapshot once, then let `cacheMediaForEntries` add to it in place
	// as files are downloaded — shared across pupils in this run so a
	// file id repeated across pupils' entries (unlikely, but cheap to
	// guard) isn't fetched twice.
	const cachedFileIds = listCachedMediaFileIds();

	for (const switchId of ids) {
		await switchPupil(jar, switchId);

		let page = 1;
		let pagesForPupil = 0;
		// Cap matches the userscript's existing safety bound (8 pages
		// * 25 entries = 200 entries max) — bigger than any realistic
		// gap, small enough to abort quickly if the API goes weird.
		const MAX_PAGES = 8;
		const PAGE_SIZE = 10;
		const previousHighest = highestLearnlogIdFor(switchId);
		// Entries with media, fetched for THIS pupil this run — media
		// download happens below, before we move on to the next pupil.
		const pupilEntriesWithMedia: LearnlogEntry[] = [];

		while (page <= MAX_PAGES) {
			const batch = await getLearnlogs(jar, page, PAGE_SIZE);
			pagesForPupil++;
			if (batch.length === 0) break;

			upsertLearnlogEntries(switchId, batch);
			totalNew += batch.length;
			totalPages++;
			for (const entry of batch) {
				if (entry.media.length > 0) pupilEntriesWithMedia.push(entry);
			}

			// Stop condition: if the lowest id on this page is <= our
			// previous high-water mark, every id on this page was
			// already cached (we just upserted identical rows over
			// themselves). The first page always has the newest id, so
			// when previousHighest is null (cold cache) we always fetch
			// at least one page and let the loop terminate naturally.
			if (previousHighest !== null) {
				const lowestOnPage = Math.min(...batch.map((e) => e.id));
				if (lowestOnPage <= previousHighest) break;
			}

			// If the page came back short (less than PAGE_SIZE), we've
			// hit the end of the feed — no point asking for more.
			if (batch.length < PAGE_SIZE) break;
			page++;
		}
		void pagesForPupil;

		// Download this pupil's new media NOW, while `switchPupil` above
		// still has them active — see the function-level note on why
		// this can't wait until after the loop.
		if (pupilEntriesWithMedia.length > 0) {
			const media = await cacheMediaForEntries(
				jar,
				cachedFileIds,
				pupilEntriesWithMedia.map((entry) => ({ pupilSwitchId: switchId, entry }))
			);
			mediaTotals.attempted += media.attempted;
			mediaTotals.downloaded += media.downloaded;
			mediaTotals.cached += media.cached;
			mediaTotals.failed += media.failed;
		}
	}

	return { pupils: ids.length, newEntries: totalNew, pagesFetched: totalPages, media: mediaTotals };
}

export async function syncCalendar(
	jar: CookieJar,
	pupilSwitchIds?: number[]
): Promise<{ pupils: number; entries: number }> {
	const ids = await resolvePupilIds(jar, pupilSwitchIds);
	const { startDate, endDate } = calendarWindowForToday();
	let total = 0;

	for (const switchId of ids) {
		await switchPupil(jar, switchId);
		const entries = await getCalendarEntries(jar, startDate, endDate);
		upsertCalendarEntries(switchId, entries);
		total += entries.length;
	}

	return { pupils: ids.length, entries: total };
}

export async function syncNews(jar: CookieJar): Promise<{ items: number }> {
	// News is global per parent (per docs/api-notes.md), so no per-pupil
	// switchPupil dance — it returns the same list regardless of which
	// pupil is currently selected. Still, scope the call to whatever
	// pupil happens to be active so we don't surprise the next call.
	const result = await getNews(jar);
	replaceNewsEntries(result.items ?? []);
	return { items: result.items?.length ?? 0 };
}

export async function syncDocuments(jar: CookieJar): Promise<{ items: number }> {
	const result = await getDocuments(jar, 1, 50);
	replaceDocuments(result.items ?? []);
	return { items: result.items?.length ?? 0 };
}

/**
 * Refresh the cached pupil list. Called after login (so the new
 * session's kids show up immediately) and is the only way pupils get
 * added to the on-disk cache. Returns the discovered list for caller
 * convenience (login flow logs it).
 *
 * Will throw `InfoMentorSessionExpiredError` if IM's session has
 * died — the caller is expected to surface a re-auth prompt in that
 * case rather than pretending the pupil list is empty.
 */
export async function refreshPupils(
	jar: CookieJar
): Promise<{ switchId: number; displayName: string | null }[]> {
	const discovered = await discoverPupils(jar);
	for (const pupil of discovered) {
		upsertPupil(pupil.switchId, pupil.displayName);
	}
	return discovered;
}

// ---- Side-channel caches ----
//
// Calendar entry types live in-memory (process-local) in `cache.ts`
// rather than in SQLite. We only refresh them here; the read path is
// shared with the page server load.

/**
 * Pick the per-pupil switch ids to sync. If the caller passed an
 * explicit list, use it. Otherwise read the cache. If the cache is
 * empty (login's best-effort discovery missed, or this is a fresh
 * install), try once to discover them now — a section sync with zero
 * pupils would silently no-op and leave the user staring at an empty
 * page, which is the bug this guard exists to prevent.
 *
 * The `discovered` return is the full list including the names so the
 * caller can surface a useful "X pupils synced" message in the UI.
 */
async function resolvePupilIds(jar: CookieJar, override: number[] | undefined): Promise<number[]> {
	if (override && override.length > 0) return override;
	const cached = listPupils().map((p) => p.switchId);
	if (cached.length > 0) return cached;
	const discovered = await refreshPupils(jar);
	return discovered.map((p) => p.switchId);
}

export async function refreshCalendarEntryTypes(jar: CookieJar): Promise<void> {
	try {
		const appData = await getCalendarAppData(jar);
		setCachedCalendarEntryTypes(appData.calendarEntryTypes ?? []);
	} catch (err) {
		// Calendar entry types are a UI nicety; a failure here shouldn't
		// fail the whole calendar sync. Re-throw on session expiry
		// though, so the caller can still prompt for re-auth.
		if (err instanceof InfoMentorSessionExpiredError) throw err;
		setCachedCalendarEntryTypes([]);
	}
}

/**
 * Walk all four sections for every pupil. Useful for the initial
 * warm-up on login (so the first nav to any section is instant) and
 * as a debugging one-shot. Returns a small per-section summary.
 */
export async function syncAll(jar: CookieJar): Promise<{
	pupils: number;
	learnlog: { newEntries: number; pagesFetched: number };
	calendar: { entries: number };
	news: { items: number };
	documents: { items: number };
}> {
	await refreshPupils(jar);
	await refreshCalendarEntryTypes(jar);
	const pupils = listPupils().map((p) => p.switchId);
	const learnlog = await syncLearnlog(jar, pupils);
	const calendar = await syncCalendar(jar, pupils);
	const news = await syncNews(jar);
	const documents = await syncDocuments(jar);
	return { pupils: pupils.length, learnlog, calendar, news, documents };
}
