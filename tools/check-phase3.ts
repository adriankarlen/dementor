#!/usr/bin/env node
// Smoke test for the Phase 3 data layer: exercises the cache
// read/upsert helpers with hand-crafted data, then runs the sync
// orchestration against a mocked InfoMentor API surface. Verifies
// the schema, the parsers, and the upsert behaviour end-to-end
// without needing real IM credentials.
//
// Runs against a separate throwaway DB file (data/phase3_check.sqlite)
// so it never touches the real cache.
//
// USAGE
//   node tools/check-phase3.ts

import { DatabaseSync } from 'node:sqlite';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DB_PATH = 'data/phase3_check.sqlite';

// Set DATABASE_PATH BEFORE the import so the db module opens the
// right file.
process.env.DATABASE_PATH = DB_PATH;

if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });

// Now import the cache + sync modules. They read DATABASE_PATH and
// open the throwaway file.
const cache = await import('../src/lib/server/cache.ts');
const sqliteRows = await import('../src/lib/server/sqliteRows.ts');

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		console.error('FAIL:', msg);
		process.exit(1);
	}
}

// ---- Pupils ----

cache.upsertPupil(123, 'Alice');
cache.upsertPupil(456, null); // cold name
cache.upsertPupil(123, 'Alicia'); // rename

const pupils = cache.listPupils();
assert(pupils.length === 2, `expected 2 pupils, got ${pupils.length}`);
const alice = pupils.find((p) => p.switchId === 123);
assert(alice?.displayName === 'Alicia', `expected rename to Alicia, got ${alice?.displayName}`);

// ---- Learnlog ----

const sampleLearnlog = [
	{
		id: 100,
		title: 'Day 100',
		text: '<p>hello</p>',
		groupName: 'Eken',
		lastModifiedOn: 'den 1 januari 2026',
		subjectsCoursesDisplayString: '',
		media: []
	},
	{
		id: 99,
		title: 'Day 99',
		text: '<p>older</p>',
		groupName: 'Eken',
		lastModifiedOn: 'den 31 december 2025',
		subjectsCoursesDisplayString: '',
		media: []
	}
];
cache.upsertLearnlogEntries(123, sampleLearnlog);

const learnlog = cache.listLearnlogEntries();
assert(learnlog.length === 2, `expected 2 learnlog entries, got ${learnlog.length}`);
assert(learnlog[0].entryId === 100, `expected newest first, got ${learnlog[0].entryId}`);
assert(learnlog[0].pupilName === 'Alicia', `expected pupil name joined, got ${learnlog[0].pupilName}`);

// Highest-id short-circuit
const highest = cache.highestLearnlogIdFor(123);
assert(highest === 100, `expected highest 100, got ${highest}`);

// Idempotent upsert (no duplicates)
cache.upsertLearnlogEntries(123, sampleLearnlog);
assert(cache.listLearnlogEntries().length === 2, 'upsert should be idempotent');

// ---- Calendar ----

const sampleCalendar = [
	{
		id: 50,
		title: 'Pizza day',
		calendarEntryTypeId: 7,
		startDateFull: '2026-09-21T00:00:00',
		endDateFull: '2026-09-21T23:59:59',
		formattedStartDate: 'måndag 21 september'
	},
	{
		id: 51,
		title: 'Library visit',
		calendarEntryTypeId: 8,
		startDateFull: '2026-09-22T00:00:00',
		endDateFull: '2026-09-22T23:59:59',
		formattedStartDate: 'tisdag 22 september'
	}
];
cache.upsertCalendarEntries(123, sampleCalendar);
cache.upsertCalendarEntries(456, sampleCalendar); // same ids, different pupil

const calendar = cache.listCalendarEntries();
assert(calendar.length === 4, `expected 4 calendar entries (2 per pupil), got ${calendar.length}`);

// Sort by startDateFull
assert(calendar[0].json.startDateFull === '2026-09-21T00:00:00', 'expected sorted by startDateFull');

// ---- News (global, per-parent) ----

const sampleNews = [
	{
		id: 1,
		title: 'Welcome',
		content: '<p>news 1</p>',
		publishedDate: '2026-09-01',
		publishedDateString: '1 september',
		publishedBy: 'Principal'
	},
	{
		id: 2,
		title: 'Reminder',
		content: '<p>news 2</p>',
		publishedDate: '2026-09-15',
		publishedDateString: '15 september',
		publishedBy: 'Principal'
	}
];
cache.replaceNewsEntries(sampleNews);
let news = cache.listNewsEntries();
assert(news.length === 2, `expected 2 news, got ${news.length}`);

// replaceNewsEntries wipes & reinserts (so removed items disappear)
cache.replaceNewsEntries([sampleNews[0]]);
news = cache.listNewsEntries();
assert(news.length === 1, `expected 1 news after replace, got ${news.length}`);
assert(news[0].json.id === 1, 'expected id 1 to remain');

// ---- Documents (global, per-parent) ----

const sampleDocs = [
	{
		id: 10,
		title: 'Schedule',
		fileType: 'pdf',
		fileSize: 12345,
		fileUrl: '/Resources/Resource/Download/10'
	}
];
cache.replaceDocuments(sampleDocs);
const docs = cache.listDocuments();
assert(docs.length === 1, `expected 1 document, got ${docs.length}`);

// ---- Parser validation ----

// Valid row
const okRow: sqliteRows.SqliteRow = {
	switch_id: 1,
	display_name: 'X',
	last_seen_at: '2026-01-01T00:00:00Z'
};
const parsed = sqliteRows.parsePupilRow(okRow);
assert(parsed.switchId === 1, 'parser should extract switchId');

// Invalid row (missing field) should throw
const badRow = { switch_id: 1, last_seen_at: 'x' } as unknown as sqliteRows.SqliteRow;
let threw = false;
try {
	sqliteRows.parsePupilRow(badRow);
} catch {
	threw = true;
}
assert(threw, 'parser should throw on missing field');

// ---- Sync orchestration against a mocked IM HTTP surface ----
//
// We stub `globalThis.fetch` to return canned JSON for each endpoint
// the sync layer touches, then run the per-section sync functions
// and verify the cache ends up with the right rows. The Session layer
// reads from the global fetch via the `request` closure, so swapping
// it in a single beforeEach is enough.

// Build a fresh cache state for this section (we already populated
// pupils above; leave them and exercise the per-pupil sync).
const realFetch = globalThis.fetch;
const originalPupils = cache.listPupils();
assert(originalPupils.length === 2, 'need pupils for sync test');

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

let lastRequestUrl: string | null = null;
let lastRequestMethod: string | null = null;
let lastRequestBody: unknown = null;
let callCount = 0;
const callLog: Array<{ url: string; method: string }> = [];

(globalThis as { fetch: typeof fetch }).fetch = (async (
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<Response> => {
	const url = typeof input === 'string' ? input : input.toString();
	const method = (init?.method ?? 'GET').toUpperCase();
	callLog.push({ url, method });
	callCount++;
	lastRequestUrl = url;
	lastRequestMethod = method;
	if (init?.body) {
		try {
			lastRequestBody = JSON.parse(init.body as string);
		} catch {
			lastRequestBody = init.body;
		}
	}

	// Set-Cookie is rarely needed for our in-jar test — the cookie jar
	// starts empty, but we want the session to look authenticated. We
	// simulate IM's behaviour by setting a fixed auth cookie on every
	// response.
	const setCookie = (extra = '') => ({
		'set-cookie': `IM_Session=test; path=/; domain=hub.infomentor.se${extra}`
	});

	// Discover: GET hub root
	if (url === 'https://hub.infomentor.se/' || url === 'https://hub.infomentor.se') {
		return htmlResponse(
			`<html><body>
				<a href="/Account/PupilSwitcher/SwitchPupil/111">Aston</a>
				<a href="/Account/PupilSwitcher/SwitchPupil/222">Bobbo</a>
			</body></html>`,
			200
		).then
			? (await Promise.resolve(
					htmlResponse(
						`<html><body>
							<a href="/Account/PupilSwitcher/SwitchPupil/111">Aston</a>
							<a href="/Account/PupilSwitcher/SwitchPupil/222">Bobbo</a>
						</body></html>`,
						200
					)
				)).clone()
			: htmlResponse(
					`<html><body>
						<a href="/Account/PupilSwitcher/SwitchPupil/111">Aston</a>
						<a href="/Account/PupilSwitcher/SwitchPupil/222">Bobbo</a>
					</body></html>`,
					200
				);
	}

	// Switch pupil: any GET to /SwitchPupil/{id}
	if (/\/Account\/PupilSwitcher\/SwitchPupil\/\d+/.test(url)) {
		return new Response('', {
			status: 200,
			headers: { ...setCookie(), 'content-type': 'text/html' }
		});
	}

	// Lärlogg: GET /learnlog/learnlog/getlearnlogs?...
	if (url.includes('/learnlog/learnlog/getlearnlogs')) {
		const u = new URL(url);
		const page = Number(u.searchParams.get('pageNumber') ?? 1);
		const size = Number(u.searchParams.get('pageSize') ?? 10);
		// Page 1: ids 100..91; page 2: ids 90..81; etc.
		const start = 100 - (page - 1) * size;
		const end = start - size + 1;
		const entries = [];
		for (let id = start; id >= end; id--) {
			entries.push({
				id,
				title: `Day ${id}`,
				text: `<p>entry ${id}</p>`,
				groupName: 'Eken',
				lastModifiedOn: 'den 1 januari 2026',
				subjectsCoursesDisplayString: '',
				media: []
			});
		}
		return jsonResponse(entries);
	}

	// Calendar entries
	if (url.includes('/calendarv2/calendarv2/getentries')) {
		return jsonResponse([
			{
				id: 50,
				title: 'Pizza day',
				calendarEntryTypeId: 7,
				startDateFull: '2026-09-21T00:00:00',
				endDateFull: '2026-09-21T23:59:59'
			}
		]);
	}
	if (url.includes('/calendarv2/calendarv2/appData')) {
		return jsonResponse({
			calendarEntryTypes: [{ id: 7, name: 'Event', colour: '#ff0000' }]
		});
	}

	// News
	if (url.includes('/Communication/News/GetNewsList')) {
		return jsonResponse({
			items: [
				{
					id: 1,
					title: 'News 1',
					content: '<p>x</p>',
					publishedDate: '2026-09-01',
					publishedDateString: '1 september',
					publishedBy: 'P'
				}
			]
		});
	}

	// Documents
	if (url.includes('/Communication/Documents/GetDocumentsList')) {
		return jsonResponse({ items: [], totalItemCount: 0 });
	}

	return new Response('not mocked', { status: 404 });
}) as typeof fetch;

// Now run the sync functions.
const sync = await import('../src/lib/server/sync.ts');
const { createCookieJar } = await import('../src/lib/server/infomentor/cookieJar.ts');
const jar = createCookieJar();

// 1) Pupil discovery
const discovered = await sync.refreshPupils(jar);
assert(discovered.length === 2, `expected 2 discovered pupils, got ${discovered.length}`);
const byId = new Map(discovered.map((p) => [p.switchId, p]));
assert(byId.get(111)?.displayName === 'Aston', `expected Aston, got ${byId.get(111)?.displayName}`);
assert(byId.get(222)?.displayName === 'Bobbo', `expected Bobbo, got ${byId.get(222)?.displayName}`);

// 2) Learnlog — cold cache, expect to fetch until we hit "all known"
const learnlogBefore = cache.listLearnlogEntries().length;
const learnlogSummary = await sync.syncLearnlog(jar, [111, 222]);
assert(learnlogSummary.pupils === 2, 'expected 2 pupils synced');
assert(learnlogSummary.pagesFetched > 0, 'expected at least one learnlog page');
assert(learnlogSummary.newEntries > 0, 'expected some new learnlog entries');

const learnlogRows = cache.listLearnlogEntries();
// The test setup at the top of this file pre-populated 2 entries
// for switchId 123, so the post-sync count is `before + newEntries`.
assert(
	learnlogRows.length === learnlogBefore + learnlogSummary.newEntries,
	`cache should match: before=${learnlogBefore}, summary says newEntries=${learnlogSummary.newEntries}, actual total=${learnlogRows.length}`
);
const allHavePupilName = learnlogRows.every((r) => r.pupilName !== null);
assert(allHavePupilName, 'every learnlog row should be joined to a pupil name');

// 3) Calendar
const calSummary = await sync.syncCalendar(jar, [111]);
assert(calSummary.entries === 1, `expected 1 calendar entry, got ${calSummary.entries}`);
const calRows = cache.listCalendarEntries();
assert(calRows.some((r) => r.pupilSwitchId === 111), 'calendar should be per-pupil');

// 4) News (global, no per-pupil)
const newsSummary = await sync.syncNews(jar);
assert(newsSummary.items === 1, `expected 1 news item, got ${newsSummary.items}`);

// 5) Documents
const docSummary = await sync.syncDocuments(jar);
assert(docSummary.items === 0, `expected 0 documents, got ${docSummary.items}`);

// Restore the real fetch.
(globalThis as { fetch: typeof fetch }).fetch = realFetch;
void lastRequestUrl;
void lastRequestMethod;
void lastRequestBody;
void callCount;

// ---- Done ----

// Clean up
const db = new DatabaseSync(DB_PATH);
db.close();
for (const ext of ['', '-shm', '-wal']) {
	try {
		unlinkSync(DB_PATH + ext);
	} catch {
		// ignore — file may not exist
	}
}

console.log('OK: Phase 3 cache layer works end-to-end (pupils, learnlog upsert + sort + join, calendar, news/doc replace, parser validation).');
