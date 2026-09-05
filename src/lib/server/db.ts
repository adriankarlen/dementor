// SQLite access via Node's built-in `node:sqlite` — no ORM, no extra
// dependency. Per AGENTS.md this is used loosely, closer to a KV/cache
// store than a normalized schema: each section (Lärlogg, calendar, news,
// documents) gets one table holding synced JSON plus a `synced_at`
// timestamp, since it's a rebuildable cache of InfoMentor's own API
// responses, not a source of truth.
//
// Schema is added phase by phase (per-section cache tables in Phase 3)
// rather than all up front. `applyMigrations` is idempotent: each
// statement is tagged with a `schema_version` row that records the
// highest applied version, so re-running the module never tries to
// re-create tables that already exist.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_PATH = 'data/dementor.sqlite';
// Default lives next to the SQLite file in data/. Override via env if
// it's helpful (e.g. the existing SQLite lives on a fast disk but
// media needs more space elsewhere).
const DEFAULT_MEDIA_DIR = 'data/media';

function openDatabase(path: string): DatabaseSync {
	mkdirSync(dirname(resolve(path)), { recursive: true });
	const database = new DatabaseSync(path);
	// One writer (this process); WAL lets reads and writes overlap without
	// the "database is locked" errors plain rollback-journal mode gives.
	database.exec('PRAGMA journal_mode = WAL;');
	database.exec('PRAGMA foreign_keys = ON;');
	return database;
}

export const db = openDatabase(process.env.DATABASE_PATH ?? DEFAULT_PATH);

/**
 * Where Phase-4-cached media bytes live on disk. Absolute path so
 * readers/writers agree regardless of process cwd. Directory is
 * created up front so the first media write doesn't hit ENOENT.
 */
export const MEDIA_DIR = resolve(process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR);
mkdirSync(MEDIA_DIR, { recursive: true });

interface Migration {
	version: number;
	description: string;
	statements: string[];
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: 'Phase 3 — per-section cache tables',
		statements: [
			// Discovered per session by scraping the pupil-switcher page on
			// hub.infomentor.se. Multiple parents logging in over time merge
			// into one shared table, so a second parent's kid starts showing
			// up without anyone having to re-add them manually.
			`CREATE TABLE IF NOT EXISTS pupils (
				switch_id INTEGER PRIMARY KEY,
				display_name TEXT,
				last_seen_at TEXT NOT NULL
			);`,
			// Composite PK enforces the append-only invariant from the
			// implementation plan: one row per (pupil, entry), upserted by
			// id. Sorting by entry_id desc gives newest-first because
			// InfoMentor's id space is monotonic with time (see
			// docs/api-notes.md).
			`CREATE TABLE IF NOT EXISTS learnlog_entries (
				pupil_switch_id INTEGER NOT NULL,
				entry_id INTEGER NOT NULL,
				json TEXT NOT NULL,
				synced_at TEXT NOT NULL,
				PRIMARY KEY (pupil_switch_id, entry_id)
			);`,
			`CREATE TABLE IF NOT EXISTS calendar_entries (
				pupil_switch_id INTEGER NOT NULL,
				entry_id INTEGER NOT NULL,
				json TEXT NOT NULL,
				synced_at TEXT NOT NULL,
				PRIMARY KEY (pupil_switch_id, entry_id)
			);`,
			// News + documents are global per parent (per docs/api-notes.md),
			// so the PK is just entry_id — there's no pupil dimension to
			// collapse across.
			`CREATE TABLE IF NOT EXISTS news_entries (
				entry_id INTEGER PRIMARY KEY,
				json TEXT NOT NULL,
				synced_at TEXT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS documents (
				entry_id INTEGER PRIMARY KEY,
				json TEXT NOT NULL,
				synced_at TEXT NOT NULL
			);`,
			// Indexes serve the list-queries the section pages run on
			// load: learnlog/calendar sorted by entry_id per pupil, news
			// / documents full-table scan. Kept separate from the PK
			// because the PK is a composite for the first two and
			// already covers equality lookups; these are for the
			// ORDER BY traversal.
			`CREATE INDEX IF NOT EXISTS idx_learnlog_entries_pupil_id
				ON learnlog_entries (pupil_switch_id, entry_id DESC);`,
			`CREATE INDEX IF NOT EXISTS idx_calendar_entries_pupil_id
				ON calendar_entries (pupil_switch_id, entry_id DESC);`
		]
	},
	{
		version: 2,
		description: 'Phase 4 — cached media files for Lärlogg posts',
		statements: [
			// Per-file-Id cache: file_id is IM's media id (also the
			// `LearnlogMedia.fileId` field and the URL parameter the
			// `/media/[fileId]` route is keyed by). Local bytes live at
			// `<MEDIA_DIR>/<fileId>.<fileExtension>`.
			//
			// `file_url`/`thumbnail_url` retained purely as provenance —
			// they are NOT used to serve anything (`docs/api-notes.md`
			// explicitly forbids rewriting thumbnail URLs; we never
			// build local file paths from them either, only from
			// `file_id` + `file_extension`).
			//
			// `pupil_switch_id` + `entry_id` are informational. The
			// per-section caches are append-only (Phase 3), so media
			// orphans are rare and the table doesn't currently have
			// a cleanup rider — we record the parentage for the day
			// someone wants to add one.
			`CREATE TABLE IF NOT EXISTS media (
				file_id INTEGER PRIMARY KEY,
				file_url TEXT NOT NULL,
				thumbnail_url TEXT NOT NULL,
				file_extension TEXT NOT NULL,
				file_type TEXT,
				pupil_switch_id INTEGER,
				entry_id INTEGER,
				content_length INTEGER,
				synced_at TEXT NOT NULL
			);`
		]
	}
];

function applyMigrations(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);

	const currentVersionRow = database.prepare('SELECT MAX(version) AS v FROM schema_version').get();
	// SAFETY: SQLite's aggregate over zero rows returns NULL; we narrow
	// to a plain object before reading the field.
	const currentVersion = (currentVersionRow as { v: number | null } | undefined)?.v ?? 0;

	for (const migration of MIGRATIONS) {
		if (migration.version <= currentVersion) continue;
		for (const sql of migration.statements) {
			database.exec(sql);
		}
		database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
		console.log(`[dementor] applied db migration v${migration.version}: ${migration.description}`);
	}
}

applyMigrations(db);
