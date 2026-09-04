#!/usr/bin/env node
// Throwaway check: confirms src/lib/server/db.ts can open the SQLite
// file and run a query, per the Phase 0 "done when" criterion in
// docs/implementation-plan.md. Safe to re-run any time; it cleans up
// after itself and touches no real app tables.
//
// USAGE
//   node tools/check-db.ts

import { db } from "../src/lib/server/db.ts";

db.exec(`
	CREATE TABLE IF NOT EXISTS _phase0_check (
		id INTEGER PRIMARY KEY,
		note TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
`);

const insert = db.prepare("INSERT INTO _phase0_check (note) VALUES (?)");
const { lastInsertRowid } = insert.run("phase 0 scaffold check");

const select = db.prepare("SELECT id, note, created_at FROM _phase0_check WHERE id = ?");
const row = select.get(lastInsertRowid);

console.log("Inserted + read back:", row);

db.exec("DROP TABLE _phase0_check;");
console.log("OK: node:sqlite open + write + read + cleanup all worked.");
