// Månadsbrev page server load.
//
// Månadsbrev (monthly newsletter) is delivered via InfoMentor's Lärlogg
// endpoint but is the SAME parent-facing message for every pupil in
// the household, regardless of which avdelning the kid is in — so in
// the regular Lärlogg feed the same message appears multiple times
// (once per pupil). This page collects those and shows one per
// distinct message.
//
// Dedup heuristic:
//   - Filter the Lärlogg cache by "månadsbrev" / "manadsbrev" in
//     either the title or an attachment filename, ignoring case.
//   - Cross-pupil dedup is content-based, not ID-based: InfoMentor's
//     per-pupil learnlog `id` (see docs/api-notes.md) is NOT shared
//     across pupils, and no shared "message group" field is
//     documented. But since the whole premise is that these posts
//     are byte-identical copies sent to every pupil, `dedupKey()`
//     below hashes (title, text, lastModifiedOn, sorted attachment
//     filenames) instead of waiting on an undocumented shared id.
//     Genuinely different posts that happen to share a title will
//     still differ in `text` or `lastModifiedOn` and won't collapse.
//
// The data still comes from the existing Lärlogg cache; we reuse
// `listLearnlogEntries()` rather than issuing a separate sync. New
// månadsbrev posts are picked up by the regular
// POST /api/sync/learnlog that the Lärlogg page fires on mount,
// which the SyncIndicator on this page also fires. No new sync
// endpoint needed.
import type { PageServerLoad } from './$types';
import { isManadsbrev } from '$lib/learnlog';

import { listCachedMediaFileIds, listLearnlogEntries, listPupils } from '$lib/server/cache';
import type { CachedLearnlogEntry } from '$lib/server/cache';
import type { LearnlogEntry } from '$lib/server/infomentor/api';

/**
 * Cross-pupil dedup key. Returns a string that identifies a single
 * parent-facing Månadsbrev message across pupils.
 *
 * InfoMentor's per-pupil learnlog `id` is NOT shared across pupils,
 * and no shared "message group" field is documented (see
 * docs/api-notes.md). So instead of an id, this hashes the content
 * that should be identical when the same letter was sent to every
 * pupil: `title`, `text`, `lastModifiedOn`, and the sorted list of
 * attachment filenames. `groupName` (the pupil's avdelning) is
 * deliberately excluded — it differs per pupil even for the same
 * letter. Two posts that happen to share a title but differ in body
 * text or timestamp will NOT collapse, so this only merges posts
 * that are actually identical, not merely similarly-named.
 */
function dedupKey(entry: LearnlogEntry): string {
	const attachmentNames = (entry.attachments ?? [])
		.map((attachment) => attachment.fileName)
		.sort()
		.join('|');
	return [entry.title.trim(), entry.text.trim(), entry.lastModifiedOn, attachmentNames].join(
		'\u0000'
	);
}

/**
 * Group cached entries by `dedupKey()` and reduce to one canonical
 * row per group. Each group is one distinct Månadsbrev message;
 * `dupes` holds the other pupils' copies of that same message so
 * the page can show a "Visas X gånger" hint instead of a duplicate
 * row.
 */
export interface ManadsbrevRow {
	canonical: CachedLearnlogEntry;
	/** Other cached entries (from other pupils) that shared this
	 *  dedupKey — i.e. the same letter, sent to more than one pupil. */
	dupes: CachedLearnlogEntry[];
}

export const load: PageServerLoad = () => {
	const all = listLearnlogEntries();
	const matching = all.filter((e) => isManadsbrev(e.json));

	// Keep the highest-id entry per dedupKey() as the canonical row;
	// the others become `dupes` (the same letter posted to other
	// pupils — see `dedupKey()` above for what "same" means here).
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
