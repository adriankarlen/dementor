// SQLite schema for the dashboard auth tables (Phase 1). Kept in its
// own module so `db.ts` stays focused on connection setup and so
// `tools/create-user.ts` (and any future CLI) can call `runMigrations`
// directly without pulling the whole `db.ts` graph.
//
// Per AGENTS.md: this is a "rebuildable cache" DB, not a normalized
// schema, so schema changes stay informal `CREATE TABLE IF NOT EXISTS`
// statements rather than a numbered migration system. That fits when
// there's nothing in production; if/when there is, a real migration
// tool would be worth the dependency.
import type { DatabaseSync } from 'node:sqlite';

export function runMigrations(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			display_name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			password_salt TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
		CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
	`);
}
