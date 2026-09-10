import { type } from 'arktype';
import { db } from './db.ts';
import { upsertLearnlogEntries } from './cache.ts';
import { getLearnlogs, switchPupil, type LearnlogEntry } from './infomentor/api.ts';
import type { CookieJar } from './infomentor/cookieJar.ts';
import { withInfoMentorSession } from './infomentor/queue.ts';

export type LearnlogSyncMode = 'latest' | 'history';
const HISTORY_PAGE_SIZE = 12;

export interface LearnlogSyncSummary {
	pupils: number;
	newEntries: number;
	pagesFetched: number;
	moreHistory: boolean;
	historyPaused: boolean;
}

interface SyncPosition {
	completed_highest: number | null;
	target_highest: number | null;
	next_page: number;
	known_ids: string | null;
}

const SyncPositionSchema = type({
	completed_highest: 'number | null',
	target_highest: 'number | null',
	next_page: 'number',
	known_ids: 'string | null'
});
const KnownIdsSchema = type('number[]');

function cachedIds(pupil: number): Set<number> {
	const rows = db
		.prepare('SELECT entry_id FROM learnlog_entries WHERE pupil_switch_id = ?')
		.all(pupil);
	return new Set(rows.map((row) => Number(row.entry_id)));
}

function position(pupil: number): SyncPosition {
	db.prepare('INSERT OR IGNORE INTO learnlog_sync (pupil_switch_id) VALUES (?)').run(pupil);
	return SyncPositionSchema.assert(
		db.prepare('SELECT * FROM learnlog_sync WHERE pupil_switch_id = ?').get(pupil)
	);
}

function storeBatch(pupil: number, batch: LearnlogEntry[]): number {
	const exists = db.prepare(
		'SELECT 1 FROM learnlog_entries WHERE pupil_switch_id = ? AND entry_id = ?'
	);
	const newCount = batch.filter((entry) => !exists.get(pupil, entry.id)).length;
	upsertLearnlogEntries(pupil, batch);
	return newCount;
}

/**
 * Navigation fetches only four recent posts per pupil. History is explicit:
 * one overlap page plus one new 12-post page per pupil, never an archive scan.
 * Media is independent. Persist the baseline/cursor until catch-up completes.
 */
export async function syncLearnlogMetadata(
	jar: CookieJar,
	pupils: number[],
	onProgress: (summary: LearnlogSyncSummary) => void = () => {},
	isActive: () => boolean = () => true,
	mode: LearnlogSyncMode = 'latest'
): Promise<LearnlogSyncSummary> {
	const summary: LearnlogSyncSummary = {
		pupils: pupils.length,
		newEntries: 0,
		pagesFetched: 0,
		moreHistory: false,
		historyPaused: false
	};
	async function fetchPage(pupil: number, page: number, size: number) {
		return withInfoMentorSession(jar, async () => {
			if (!isActive()) throw new Error('sync cancelled');
			const start = performance.now();
			await switchPupil(jar, pupil);
			const batch = await getLearnlogs(jar, page, size);
			console.info(
				`[dementor] learnlog page=${page} size=${size} items=${batch.length} ms=${Math.round(performance.now() - start)}`
			);
			summary.pagesFetched++;
			summary.newEntries += storeBatch(pupil, batch);
			onProgress({ ...summary });
			return batch;
		});
	}

	for (const pupil of pupils) {
		if (!isActive()) return summary;
		const state = position(pupil);
		// Freeze the overlap baseline BEFORE writing the first small page.
		// Cold/legacy incomplete scans must keep walking through cached history.
		const known = state.completed_highest === null ? new Set<number>() : cachedIds(pupil);
		const recent = await fetchPage(pupil, 1, 4);
		if (state.target_highest !== null) continue;
		if (recent.length === 0) continue;
		const highest = Math.max(...recent.map((entry) => entry.id));
		if (recent.length < 4 || recent.every((entry) => known.has(entry.id))) {
			db.prepare('UPDATE learnlog_sync SET completed_highest = ? WHERE pupil_switch_id = ?').run(
				highest,
				pupil
			);
		} else {
			db.prepare(
				'UPDATE learnlog_sync SET target_highest = ?, next_page = 1, known_ids = ? WHERE pupil_switch_id = ?'
			).run(highest, JSON.stringify([...known]), pupil);
		}
	}

	for (const pupil of pupils) {
		const state = position(pupil);
		if (state.target_highest === null) continue;
		if (mode === 'latest') {
			summary.moreHistory = true;
			continue;
		}
		// Re-read one overlap page on resume: upstream pagination is offset-based,
		// so new posts may have shifted its boundaries while we were away.
		let page = Math.max(1, state.next_page - 1);
		const known = new Set(KnownIdsSchema.assert(JSON.parse(state.known_ids ?? '[]')));
		const pageFingerprints = new Set<string>();
		for (let count = 0; count < (state.next_page > 1 ? 2 : 1); count++, page++) {
			if (!isActive()) return summary;
			const batch = await fetchPage(pupil, page, HISTORY_PAGE_SIZE);
			const complete =
				batch.length < HISTORY_PAGE_SIZE || batch.every((entry) => known.has(entry.id));
			if (complete) {
				db.prepare(
					'UPDATE learnlog_sync SET completed_highest = ?, target_highest = NULL, next_page = 1, known_ids = NULL WHERE pupil_switch_id = ?'
				).run(state.target_highest, pupil);
				break;
			}
			// Old entries can move between pages. Numeric ID order is not a
			// progress signal: only an identical set of returned IDs is a repeat.
			const fingerprint = [...new Set(batch.map((entry) => entry.id))]
				.sort((a, b) => a - b)
				.join(',');
			if (pageFingerprints.has(fingerprint)) {
				console.warn(`[dementor] learnlog page=${page} repeated an earlier page; history paused`);
				summary.historyPaused = true;
				// Keep target/baseline/cursor intact; do not declare history complete
				// or discard fresh posts because the remote endpoint repeated a page.
				break;
			}
			pageFingerprints.add(fingerprint);
			db.prepare('UPDATE learnlog_sync SET next_page = ? WHERE pupil_switch_id = ?').run(
				page + 1,
				pupil
			);
		}
		if (position(pupil).target_highest !== null) summary.moreHistory = true;
	}
	return summary;
}
