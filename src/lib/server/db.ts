// SQLite access via Node's built-in `node:sqlite` — no ORM, no extra
// dependency. Per AGENTS.md this is used loosely, closer to a KV/cache
// store than a normalized schema: each section (Lärlogg, calendar, news,
// documents) gets one table holding synced JSON plus a `synced_at`
// timestamp, since it's a rebuildable cache of InfoMentor's own API
// responses, not a source of truth. Tables are added phase by phase
// (users/sessions in Phase 1, credentials in Phase 2, sync cache tables
// in Phase 3) rather than all up front.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { runMigrations } from './auth/schema.ts';

const DEFAULT_PATH = 'data/dementor.sqlite';

function openDatabase(path: string): DatabaseSync {
	mkdirSync(dirname(resolve(path)), { recursive: true });
	const database = new DatabaseSync(path);
	// One writer (this process); WAL lets reads and writes overlap without
	// the "database is locked" errors plain rollback-journal mode gives.
	database.exec('PRAGMA journal_mode = WAL;');
	database.exec('PRAGMA foreign_keys = ON;');
	runMigrations(database);
	return database;
}

export const db = openDatabase(process.env.DATABASE_PATH ?? DEFAULT_PATH);
