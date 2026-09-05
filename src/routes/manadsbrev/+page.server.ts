// Månadsbrev page server load.
//
// Månadsbrev (monthly newsletter) is delivered via InfoMentor's Lärlogg
// endpoint but is the SAME parent-facing message for every pupil in
// the household, regardless of which avdelning the kid is in — so in
// the regular Lärlogg feed the same message appears multiple times
// (once per pupil). This page collects those.
//
// Current placeholder heuristic:
//   - Filter the Lärlogg cache by case-insensitive title substring
//     match on "månadsbrev" / "manadsbrev" (the user-confirmed
//     Swedish term; covers both the spelled-with-å and
//     spelled-without-å variants IM sometimes uses).
//   - No cross-pupil dedup applied yet. The Lärlogg cache is keyed
//     on (pupil_switch_id, entry_id), so without a shared
//     "message group" key — which docs/api-notes.md does NOT
//     document — the cleanest dedup can't be implemented without a
//     network capture showing two duplicate Månadsbrev entries
//     side-by-side. The seam is `dedupKey()` below; it returns
//     `entry.id` today (per-pupil, no collapse) and is the single
//     function to change when the real key is known.
//
// The data still comes from the existing Lärlogg cache; we reuse
// `listLearnlogEntries()` rather than issuing a separate sync. New
// månadsbrev posts are picked up by the regular
// POST /api/sync/learnlog that the Lärlogg page fires on mount,
// which the SyncIndicator on this page also fires. No new sync
// endpoint needed.
import type { PageServerLoad } from './$types';

import { listCachedMediaFileIds, listLearnlogEntries, listPupils } from '$lib/server/cache';
import type { CachedLearnlogEntry } from '$lib/server/cache';
import type { LearnlogEntry } from '$lib/server/infomentor/api';

/**
 * Cross-pupil dedup seam. Returns a string that uniquely identifies
 * a single parent-facing Månadsbrev message across pupils.
 *
 * TODAY: returns `entry.id` — this is InfoMentor's per-pupil
 * learnlog id (see docs/api-notes.md "id appears to be monotonically
 * increasing with recency"). It is NOT shared across pupils, so this
 * placeholder does NOT dedup. Two Månadsbrev entries posted to two
 * pupils will still both appear here, exactly like in the Lärlogg
 * feed.
 *
 * WHEN WE GET A NETWORK CAPTURE: replace the return value with the
 * real shared identifier (likely `subjectsCoursesDisplayString`, an
 * undocumented `parentLearnLogId`/`shareId`/`sharedGroupId` field,
 * or a hash of (title + lastModifiedOn-day-bucket + first-paragraph-
 * of-text)). The downstream code already keys on this string, so the
 * single-line change in this function is the entire fix — no other
 * file needs to know which key was picked.
 */
function dedupKey(entry: LearnlogEntry): string {
	// Placeholder: per-pupil id, so no cross-pupil collapse. The
	// entry param is used today (despite the placeholder being
	// trivially wrong) so the call sites read naturally and a future
	// edit can drop in a real shared key without touching them.
	return entry.id.toString();
}

/**
 * Placeholder match: title contains the Swedish word for monthly
 * newsletter (with or without the diacritic — IM has been observed
 * to mix both in old captures). Case-insensitive substring, anchored
 * on word boundaries to avoid false positives in titles that merely
 * reference the word in passing.
 *
 * KNOWN LIMITATION (will be revisited when real dedup key arrives):
 * a Månadsbrev titled e.g. "Välkomstbrev från förskolan" wouldn't
 * match. The user knows the tab is heuristic; the title-substring
 * rule is documented in this file's header so it's discoverable
 * from the code.
 */
function isManadsbrevTitle(title: string): boolean {
	const normalized = title.toLowerCase();
	return /\bmånadsbrev\b|\bmanadsbrev\b/.test(normalized);
}

/**
 * Group cached entries by `dedupKey()` and reduce to one canonical
 * row per group. With the per-pupil placeholder key each group has
 * exactly one entry and `dupes` is always empty — the structure is
 * still in place so a future change to `dedupKey()` lights up
 * automatic cross-pupil collapsing without touching the page.
 */
export interface ManadsbrevRow {
	canonical: CachedLearnlogEntry;
	/** Other cached entries that shared this dedupKey (always empty
	 *  today; populated once `dedupKey()` becomes truly shared). */
	dupes: CachedLearnlogEntry[];
}

export const load: PageServerLoad = () => {
	const all = listLearnlogEntries();
	const matching = all.filter((e) => isManadsbrevTitle(e.json.title));

	// Keep the highest-id entry per dedupKey() as the canonical row;
	// the others become `dupes`. Today, with per-pupil ids as the
	// key, every group has exactly one entry — see `dedupKey()` above.
	const groups = new Map<string, CachedLearnlogEntry[]>();
	for (const entry of matching) {
		const key = dedupKey(entry.json);
		const bucket = groups.get(key);
		if (bucket) bucket.push(entry);
		else groups.set(key, [entry]);
	}

	const rows: ManadsbrevRow[] = [];
	for (const bucket of groups.values()) {
		// Newest first within each group; the page renders only the
		// canonical row plus a "Visas X gånger" hint when dupes > 0.
		bucket.sort((a, b) => b.entryId - a.entryId);
		rows.push({ canonical: bucket[0], dupes: bucket.slice(1) });
	}
	// Newest group first (using the canonical entry's id as the
	// sort key), matching the Lärlogg page's ordering.
	rows.sort((a, b) => b.canonical.entryId - a.canonical.entryId);

	return {
		rows,
		pupils: listPupils(),
		cachedMediaFileIds: [...listCachedMediaFileIds()],
		// Counts surfaced so the header can show "X inlägg" / raw
		// "Y träffar i Lärlogg" without the page rendering-then-
		// counting.
		manadsbrevCount: rows.length,
		rawCount: matching.length
	};
};
