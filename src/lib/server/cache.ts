// Read + upsert helpers for the per-section cache tables defined in
// `db.ts`. Per the implementation plan: this is a rebuildable cache of
// InfoMentor's own API responses, not a source of truth. Tables are
// append-only — entries are upserted by primary key on fetch, never
// deleted — so a stale entry that InfoMentor later removed locally
// stays visible until the cache file itself is wiped, which is fine
// for the personal-tool scale here.
//
// Every entry is stored as raw JSON text. We re-parse on read. This
// keeps the schema trivial (no per-field columns) and means schema
// changes on InfoMentor's side don't need a DB migration — the next
// fetch re-stores whatever shape they now return.
import { db } from './db.ts';
import {
	parseCalendarRow,
	parseDocumentRow,
	parseLearnlogRow,
	parseMaxIdRow,
	parseMediaRow,
	parseNewsRow,
	parsePupilRow
} from './sqliteRows.ts';
import type {
	CalendarEntry,
	CalendarEntryType,
	DocumentItem,
	LearnlogEntry,
	LearnlogMedia,
	NewsItem
} from './infomentor/api.ts';

// ---- Pupils ----

/**
 * Upsert one pupil. `last_seen_at` is set to the current time so the
 * dashboard can show "last refreshed for this child" if it ever needs
 * to. Display name is overwritten if non-null (a rename on IM's side
 * should propagate), kept if null (don't clobber a known name with a
 * failed scrape).
 */
export function upsertPupil(switchId: number, displayName: string | null): void {
	const now = new Date().toISOString();
	const stmt = db.prepare(`
		INSERT INTO pupils (switch_id, display_name, last_seen_at)
		VALUES (?, ?, ?)
		ON CONFLICT(switch_id) DO UPDATE SET
			display_name = CASE
				WHEN excluded.display_name IS NOT NULL THEN excluded.display_name
				ELSE pupils.display_name
			END,
			last_seen_at = excluded.last_seen_at
	`);
	stmt.run(switchId, displayName, now);
}

/**
 * Remove a pupil from the cache. Doesn't touch the per-pupil
 * section tables — the cached entries for that pupil just become
 * orphans (no join target) and stop being listed. This is the
 * "manage children" UI's delete action.
 */
export function deletePupil(switchId: number): void {
	db.prepare('DELETE FROM pupils WHERE switch_id = ?').run(switchId);
}

export interface CachedPupil {
	switchId: number;
	displayName: string | null;
	lastSeenAt: string;
}

export function listPupils(): CachedPupil[] {
	const stmt = db.prepare(
		'SELECT switch_id, display_name, last_seen_at FROM pupils ORDER BY switch_id'
	);
	// `stmt.all()` returns `Record<string, SQLOutputValue>[]`, which
	// matches `SqliteRow[]` directly. The parsers (arktype-validated)
	// narrow per row.
	return stmt.all().map(parsePupilRow);
}

export function getPupil(switchId: number): CachedPupil | null {
	const stmt = db.prepare(
		'SELECT switch_id, display_name, last_seen_at FROM pupils WHERE switch_id = ?'
	);
	// `stmt.get()` returns `Record<string, SQLOutputValue> | undefined`,
	// matches `SqliteRow | undefined` directly. See listPupils() for
	// the row-shape contract.
	const row = stmt.get(switchId);
	return row ? parsePupilRow(row) : null;
}

// ---- Section entry caches ----

export interface CachedLearnlogEntry {
	pupilSwitchId: number;
	entryId: number;
	pupilName: string | null;
	json: LearnlogEntry;
	syncedAt: string;
}

export function upsertLearnlogEntries(pupilSwitchId: number, entries: LearnlogEntry[]): void {
	if (entries.length === 0) return;
	const stmt = db.prepare(`
		INSERT INTO learnlog_entries (pupil_switch_id, entry_id, json, synced_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(pupil_switch_id, entry_id) DO UPDATE SET
			json = excluded.json,
			synced_at = excluded.synced_at
	`);
	const now = new Date().toISOString();
	try {
		db.exec('BEGIN');
		for (const entry of entries) {
			stmt.run(pupilSwitchId, entry.id, JSON.stringify(entry), now);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/**
 * All cached Lärlogg entries across pupils, joined with the pupil's
 * display name (NULL if unknown) and sorted newest-first by entry id.
 * Used by the section page's `+page.server.ts` `load` to render the
 * unified feed.
 */
export function listLearnlogEntries(): CachedLearnlogEntry[] {
	const stmt = db.prepare(`
		SELECT
			l.pupil_switch_id,
			l.entry_id,
			l.json,
			l.synced_at,
			p.display_name AS pupil_name
		FROM learnlog_entries l
		LEFT JOIN pupils p ON p.switch_id = l.pupil_switch_id
		ORDER BY l.entry_id DESC
	`);
	return stmt.all().map((row): CachedLearnlogEntry => {
		const parsed = parseLearnlogRow(row);
		return {
			pupilSwitchId: parsed.pupilSwitchId,
			entryId: parsed.entryId,
			pupilName: parsed.pupilName,
			syncedAt: parsed.syncedAt,
			// SAFETY: `json` is the InfoMentor response, JSON.stringify'd
			// by `upsertLearnlogEntries` and stored in a TEXT column.
			// The runtime JSON.parse below re-validates.
			json: JSON.parse(parsed.json) as LearnlogEntry
		};
	});
}

/** Highest known entry id for one pupil. Returns null for a cold cache. */
export function highestLearnlogIdFor(pupilSwitchId: number): number | null {
	const stmt = db.prepare(
		'SELECT MAX(entry_id) AS max_id FROM learnlog_entries WHERE pupil_switch_id = ?'
	);
	const row = stmt.get(pupilSwitchId);
	return row ? parseMaxIdRow(row) : null;
}

export interface CachedCalendarEntry {
	pupilSwitchId: number;
	entryId: number;
	pupilName: string | null;
	json: CalendarEntry;
	syncedAt: string;
}

export function upsertCalendarEntries(pupilSwitchId: number, entries: CalendarEntry[]): void {
	if (entries.length === 0) return;
	const stmt = db.prepare(`
		INSERT INTO calendar_entries (pupil_switch_id, entry_id, json, synced_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(pupil_switch_id, entry_id) DO UPDATE SET
			json = excluded.json,
			synced_at = excluded.synced_at
	`);
	const now = new Date().toISOString();
	try {
		db.exec('BEGIN');
		for (const entry of entries) {
			stmt.run(pupilSwitchId, entry.id, JSON.stringify(entry), now);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

export function listCalendarEntries(): CachedCalendarEntry[] {
	const stmt = db.prepare(`
		SELECT
			l.pupil_switch_id,
			l.entry_id,
			l.json,
			l.synced_at,
			p.display_name AS pupil_name
		FROM calendar_entries l
		LEFT JOIN pupils p ON p.switch_id = l.pupil_switch_id
	`);
	// We don't have start_date_full as a column (it's inside the JSON),
	// so we sort in JS after loading. Typical calendar windows are
	// <100 entries per pupil, so this stays cheap; revisit if it grows.
	const parsed = stmt.all().map((row): CachedCalendarEntry => {
		const p = parseCalendarRow(row);
		return {
			pupilSwitchId: p.pupilSwitchId,
			entryId: p.entryId,
			pupilName: p.pupilName,
			syncedAt: p.syncedAt,
			// SAFETY: see note in `listLearnlogEntries`; same provenance.
			json: JSON.parse(p.json) as CalendarEntry
		};
	});
	parsed.sort((a, b) => {
		const aStart = a.json.startDateFull ?? '';
		const bStart = b.json.startDateFull ?? '';
		if (aStart !== bStart) return aStart.localeCompare(bStart);
		return a.entryId - b.entryId;
	});
	return parsed;
}

// ---- In-memory caches ----
//
// `calendarEntryTypes` lives in-memory (process-local) rather than
// in SQLite. It's a tiny array, fetched alongside calendar entries,
// and only used to colour-code chips in the UI. Storing it would
// need a dedicated meta table; not worth the schema churn for Phase 3.

let calendarEntryTypesCache: CalendarEntryType[] = [];

export function getCachedCalendarEntryTypes(): CalendarEntryType[] {
	return calendarEntryTypesCache;
}

export function setCachedCalendarEntryTypes(types: CalendarEntryType[]): void {
	calendarEntryTypesCache = types;
}

// ---- News + Documents ----

export interface CachedNewsEntry {
	entryId: number;
	json: NewsItem;
	syncedAt: string;
}

export function replaceNewsEntries(entries: NewsItem[]): void {
	// Per the plan, news is small (<=12 items, full refetch each time)
	// and global per parent, not per pupil — we wipe & re-insert rather
	// than upsert-and-leave-stale-rows, so removed-on-IM-side items
	// actually disappear from the dashboard. Cache is still rebuildable
	// on the next sync, so this stays within the "not a source of
	// truth" framing.
	const insert = db.prepare(`
		INSERT INTO news_entries (entry_id, json, synced_at)
		VALUES (?, ?, ?)
		ON CONFLICT(entry_id) DO UPDATE SET
			json = excluded.json,
			synced_at = excluded.synced_at
	`);
	const now = new Date().toISOString();
	try {
		db.exec('BEGIN');
		db.exec('DELETE FROM news_entries');
		for (const entry of entries) {
			insert.run(entry.id, JSON.stringify(entry), now);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

export function listNewsEntries(): CachedNewsEntry[] {
	const stmt = db.prepare(
		'SELECT entry_id, json, synced_at FROM news_entries ORDER BY entry_id DESC'
	);
	return stmt.all().map((row): CachedNewsEntry => {
		const p = parseNewsRow(row);
		return {
			entryId: p.entryId,
			syncedAt: p.syncedAt,
			// SAFETY: see note in `listLearnlogEntries`; same provenance.
			json: JSON.parse(p.json) as NewsItem
		};
	});
}

export interface CachedDocument {
	entryId: number;
	json: DocumentItem;
	syncedAt: string;
}

export function replaceDocuments(entries: DocumentItem[]): void {
	const insert = db.prepare(`
		INSERT INTO documents (entry_id, json, synced_at)
		VALUES (?, ?, ?)
		ON CONFLICT(entry_id) DO UPDATE SET
			json = excluded.json,
			synced_at = excluded.synced_at
	`);
	const now = new Date().toISOString();
	try {
		db.exec('BEGIN');
		db.exec('DELETE FROM documents');
		for (const entry of entries) {
			insert.run(entry.id, JSON.stringify(entry), now);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

export function listDocuments(): CachedDocument[] {
	const stmt = db.prepare('SELECT entry_id, json, synced_at FROM documents ORDER BY entry_id DESC');
	return stmt.all().map((row): CachedDocument => {
		const p = parseDocumentRow(row);
		return {
			entryId: p.entryId,
			syncedAt: p.syncedAt,
			// SAFETY: see note in `listLearnlogEntries`; same provenance.
			json: JSON.parse(p.json) as DocumentItem
		};
	});
}

// ---- Cached media (Phase 4) ----
//
// Local-bytes cache for Lärlogg posts' photo/video files, downloaded
// during sync so the dashboard can serve them itself rather than
// hitting hub.infomentor.se for every view. The page reads
// `listCachedMediaFileIds`, gets back a Set of currently-cached
// file ids, and renders `<img>/<video src="/media/{fileId}">` for
// cached entries; uncached ones fall back to InfoMentor's URL.

export interface CachedMedia {
	fileId: number;
	fileUrl: string;
	thumbnailUrl: string;
	fileExtension: string;
	fileType: string | null;
	pupilSwitchId: number | null;
	entryId: number | null;
	contentLength: number | null;
	syncedAt: string;
}

/**
 * Record a successfully-downloaded media file. The bytes themselves
 * live on disk at `<MEDIA_DIR>/<fileId>.<fileExtension>`; this row
 * is the metadata + provenance record (per the Phase 4 spec in
 * docs/implementation-plan.md). Idempotent: re-syncing the same
 * file id updates the timestamp + provenance fields without error.
 *
 * `learnLogMedia` is the entry from InfoMentor's JSON; we extract
 * the fields once here so the caller doesn't have to also pass them.
 */
export function upsertMedia(
	learnLogMedia: LearnlogMedia,
	contentLength: number,
	pupilSwitchId: number,
	entryId: number
): void {
	const stmt = db.prepare(`
		INSERT INTO media (
			file_id, file_url, thumbnail_url, file_extension, file_type,
			pupil_switch_id, entry_id, content_length, synced_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_id) DO UPDATE SET
			file_url = excluded.file_url,
			thumbnail_url = excluded.thumbnail_url,
			file_extension = excluded.file_extension,
			file_type = excluded.file_type,
			pupil_switch_id = excluded.pupil_switch_id,
			entry_id = excluded.entry_id,
			content_length = excluded.content_length,
			synced_at = excluded.synced_at
	`);
	const now = new Date().toISOString();
	stmt.run(
		learnLogMedia.fileId,
		learnLogMedia.fileUrl,
		learnLogMedia.thumbnailUrl,
		learnLogMedia.fileExtension,
		learnLogMedia.fileType,
		pupilSwitchId,
		entryId,
		contentLength,
		now
	);
}

/**
 * One row by file id. Used by the `/media/[fileId]` route to look up
 * `file_extension` so it knows both the on-disk path AND can pick a
 * reasonable Content-Type for the response.
 */
export function getCachedMedia(fileId: number): CachedMedia | null {
	const stmt = db.prepare(
		`SELECT file_id, file_url, thumbnail_url, file_extension, file_type,
				pupil_switch_id, entry_id, content_length, synced_at
		 FROM media
		 WHERE file_id = ?`
	);
	const row = stmt.get(fileId);
	if (!row) return null;
	const p = parseMediaRow(row);
	return {
		fileId: p.fileId,
		fileUrl: p.fileUrl,
		thumbnailUrl: p.thumbnailUrl,
		fileExtension: p.fileExtension,
		fileType: p.fileType,
		pupilSwitchId: p.pupilSwitchId,
		entryId: p.entryId,
		contentLength: p.contentLength,
		syncedAt: p.syncedAt
	};
}

/**
 * All currently-cached media file ids, as a Set for O(1) lookups by
 * the page render. The page passes a big list of LearnlogEntry
 * objects; for each one it asks "is each attached media cached?"
 * and renders accordingly. Cheap: <= a few hundred files for the
 * scale this dashboard runs at.
 */
export function listCachedMediaFileIds(): Set<number> {
	// SELECT * matches the MediaRowSchema in sqliteRows.ts; if the
	// schema ever drops a non-nullable column, the parser would
	// throw on read here — that's the right place for it to surface.
	const stmt = db.prepare('SELECT * FROM media');
	const out = new Set<number>();
	for (const row of stmt.all()) {
		out.add(parseMediaRow(row).fileId);
	}
	return out;
}
