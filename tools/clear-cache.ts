#!/usr/bin/env node
// Wipes the rebuildable-cache tables (Lärlogg, calendar, news,
// documents, media metadata + files) so the next sync re-fetches
// everything from InfoMentor from scratch. Per AGENTS.md / db.ts,
// these tables are a cache of InfoMentor's own API responses, not a
// source of truth — safe to empty at any time.
//
// By default `pupils` is left untouched (saved children stay listed).
// Pass --hard to also wipe `pupils`, i.e. reset the app to a totally
// empty state.
//
// USAGE
//   node tools/clear-cache.ts          # keep saved pupils
//   node tools/clear-cache.ts --hard   # wipe everything, incl. pupils

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, MEDIA_DIR } from '../src/lib/server/db.ts';

const hard = process.argv.includes('--hard');

const CACHE_TABLES = ['learnlog_entries', 'calendar_entries', 'news_entries', 'documents', 'media'];

db.exec('BEGIN');
try {
	for (const table of CACHE_TABLES) {
		db.exec(`DELETE FROM ${table};`);
	}
	if (hard) {
		db.exec('DELETE FROM pupils;');
	}
	db.exec('COMMIT');
} catch (err) {
	db.exec('ROLLBACK');
	throw err;
}
db.exec('VACUUM;');

let mediaFilesRemoved = 0;
for (const entry of readdirSync(MEDIA_DIR)) {
	rmSync(join(MEDIA_DIR, entry), { recursive: true, force: true });
	mediaFilesRemoved++;
}

console.log(
	hard
		? `OK: wiped all cache tables (incl. pupils) and removed ${mediaFilesRemoved} media file(s).`
		: `OK: wiped cache tables (kept pupils) and removed ${mediaFilesRemoved} media file(s).`
);

db.close();
