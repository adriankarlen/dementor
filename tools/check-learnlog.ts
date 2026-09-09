#!/usr/bin/env node
// Offline regressions: temporary SQLite/media, synthetic pupils, no credentials.
// Run: node tools/check-learnlog.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LearnlogEntry } from '../src/lib/server/infomentor/api.ts';

const directory = await mkdtemp(join(tmpdir(), 'dementor-check-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const { db } = await import('../src/lib/server/db.ts');
const cache = await import('../src/lib/server/cache.ts');
const { syncLearnlog } = await import('../src/lib/server/sync.ts');
const { fileResponse, parseRange } = await import('../src/lib/server/file-response.ts');
const { saveDownload } = await import('../src/lib/server/download.ts');
const { ensureMedia, localMediaPath, localThumbnailPath, thumbnailContentType } = await import('../src/lib/server/media.ts');
const { InfoMentorSessionExpiredError } = await import('../src/lib/server/infomentor/errors.ts');
const { createCookieJar } = await import('../src/lib/server/infomentor/cookieJar.ts');
const { withInfoMentorSession } = await import('../src/lib/server/infomentor/queue.ts');
const { startLearnlogJob } = await import('../src/lib/server/learnlog-jobs.ts');
const realFetch = globalThis.fetch;

function entry(id: number): LearnlogEntry {
	return { id, title: `Post ${id}`, text: '<p>Example</p>', groupName: 'Group',
		lastModifiedOn: '', subjectsCoursesDisplayString: '', media: [] };
}
function reset() {
	db.exec('DELETE FROM learnlog_sync; DELETE FROM learnlog_entries; DELETE FROM media; DELETE FROM pupils;');
	cache.upsertPupil(111, 'First');
	cache.upsertPupil(222, 'Second');
}
let selected = 111;
let pages: { pupil: number; page: number; size: number }[] = [];
let source = new Map<number, LearnlogEntry[]>();
let failPage = 0;
let pageOverride: ((page: number, size: number) => LearnlogEntry[] | undefined) | undefined;
let mediaRequests = 0;
let mediaBody = Buffer.from('sample media bytes');
let mediaStatus = 200;
let mediaContentType: string | null = 'application/octet-stream';
let appDataStatus = 200;
let appDataRequests = 0;
globalThis.fetch = async (input) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.equal(url.hostname, 'hub.infomentor.se', 'tests must never call another host');
	if (url.pathname.includes('SwitchPupil/')) {
		selected = Number(url.pathname.split('/').at(-1));
		return new Response('<html>Authenticated hub</html>');
	}
	if (url.pathname.includes('getlearnlogs')) {
		const page = Number(url.searchParams.get('pageNumber'));
		const size = Number(url.searchParams.get('pageSize'));
		pages.push({ pupil: selected, page, size });
		if (page === failPage && size === 25) throw new Error('simulated network failure');
		const all = source.get(selected) ?? [];
		return Response.json(pageOverride?.(page, size) ?? all.slice((page - 1) * size, page * size));
	}
	if (url.pathname.includes('/communication/communication/appData')) {
		appDataRequests++;
		return Response.json({ consentViewConfig: {} }, { status: appDataStatus });
	}
	if (url.pathname.includes('/Resources/')) {
		mediaRequests++;
		return new Response(new Uint8Array(mediaBody), {
			status: mediaStatus,
			headers: mediaContentType ? { 'Content-Type': mediaContentType } : undefined
		});
	}
	throw new Error(`unexpected test request: ${url.pathname}`);
};

try {
	reset();
	for (const pupil of [111, 222]) cache.upsertLearnlogEntries(pupil, [10, 9, 8, 7, 6].map(entry));
	let cursor: string | null = null;
	const keys: string[] = [];
	do {
		const page = cache.listLearnlogPage(cursor);
		assert.ok(page.entries.length <= 4);
		keys.push(...page.entries.map((row) => `${row.entryId}:${row.pupilSwitchId}`));
		cursor = page.nextCursor;
	} while (cursor);
	assert.equal(keys.length, 10);
	assert.equal(new Set(keys).size, 10, 'composite cursor must not lose shared entry IDs');
	const first = cache.listLearnlogPage();
	cache.upsertLearnlogEntries(111, [entry(11)]);
	assert.equal(cache.listLearnlogPage(first.nextCursor).entries[0].entryId, 8, 'new posts must not shift a cursor');
	assert.throws(() => cache.listLearnlogPage('not-a-cursor'));
	assert.throws(() => cache.listLearnlogPage('999999999999999999:1'));
	console.log('OK: four-row keyset pages, ties, inserted posts, invalid cursors');

	reset();
	source = new Map([[111, Array.from({ length: 61 }, (_, i) => entry(100 - i))], [222, [entry(500), entry(499)]]]);
	pages = [];
	const jar = createCookieJar();
	let firstPublished = false;
	const cold = await syncLearnlog(jar, [111, 222], () => {
		if (!firstPublished) {
			assert.equal(cache.listLearnlogEntries().length, 4);
			firstPublished = true;
		}
	});
	assert.deepEqual(pages.slice(0, 2).map((page) => page.size), [4, 4], 'both pupils get recent posts before backfill');
	assert.equal(cold.newEntries, 63);
	assert.equal(cold.moreHistory, false);
	assert.equal(mediaRequests, 0, 'metadata sync must not download media');
	pages = [];
	const warm = await syncLearnlog(jar, [111, 222]);
	assert.equal(warm.newEntries, 0);
	assert.equal(warm.pagesFetched, 2);
	assert.ok(pages.every((page) => page.size === 4));
	source.get(111)!.unshift(...[107, 106, 105, 104, 103, 102, 101].map(entry));
	assert.equal((await syncLearnlog(jar, [111])).newEntries, 7);
	console.log('OK: progressive cold sync, correct counts, small no-change sync, catch-up');

	reset();
	source = new Map([[111, Array.from({ length: 260 }, (_, i) => entry(1000 - i))]]);
	const capped = await syncLearnlog(jar, [111]);
	assert.equal(capped.moreHistory, true);
	assert.equal(cache.listLearnlogEntries().length, 200);
	const resumed = await syncLearnlog(jar, [111]);
	assert.equal(resumed.moreHistory, false);
	assert.equal(cache.listLearnlogEntries().length, 260, 'cap must not strand older posts');
	reset();
	source = new Map([[111, Array.from({ length: 70 }, (_, i) => entry(1000 - i))]]);
	failPage = 2;
	await assert.rejects(syncLearnlog(jar, [111]), /simulated network/);
	assert.equal(cache.listLearnlogEntries().length, 25);
	failPage = 0;
	await syncLearnlog(jar, [111]);
	assert.equal(cache.listLearnlogEntries().length, 70, 'partial latest page must not advance the completed watermark');
	console.log('OK: backfill cap and failure resume without gaps');

	// Feed order is not numeric ID order. An older post can be moved to page 1.
	reset();
	source = new Map([[111, [entry(1), ...Array.from({ length: 59 }, (_, i) => entry(1000 - i))]]]);
	const unordered = await syncLearnlog(jar, [111]);
	assert.equal(unordered.newEntries, 60);
	assert.equal(unordered.historyPaused, false);
	assert.equal(unordered.moreHistory, false);
	source.get(111)!.unshift(entry(2));
	source.get(111)!.splice(10, 0, entry(3));
	const lowIdPosts = await syncLearnlog(jar, [111]);
	assert.equal(lowIdPosts.newEntries, 2, 'overlap must use known IDs, not a numeric high-water mark');
	assert.ok(cache.listLearnlogEntries().some((row) => row.entryId === 3));

	reset();
	source = new Map([[111, Array.from({ length: 80 }, (_, i) => entry(1000 - i))]]);
	pageOverride = (page, size) => page === 2 && size === 25 ? [...source.get(111)!.slice(0, 25)].reverse() : undefined;
	const repeated = await syncLearnlog(jar, [111]);
	assert.equal(repeated.moreHistory, true);
	assert.equal(repeated.historyPaused, true, 'identical ID sets should pause even in a different order');
	assert.equal(cache.listLearnlogEntries().length, 25);
	const pausedPosition = db.prepare('SELECT target_highest, completed_highest, next_page FROM learnlog_sync WHERE pupil_switch_id = 111').get()!;
	assert.ok(pausedPosition.target_highest !== null);
	assert.equal(pausedPosition.completed_highest, null, 'a repeat must not mark missing history complete');
	assert.equal(pausedPosition.next_page, 2);
	pageOverride = undefined;
	const recovered = await syncLearnlog(jar, [111]);
	assert.equal(recovered.historyPaused, false);
	assert.equal(recovered.moreHistory, false);
	assert.equal(cache.listLearnlogEntries().length, 80);
	console.log('OK: unordered IDs, low-ID new posts, repeated-page pause and recovery');

	const order: string[] = [];
	await Promise.all([
		withInfoMentorSession(jar, async () => { order.push('a-start'); await new Promise((resolve) => setTimeout(resolve, 10)); order.push('a-end'); }),
		withInfoMentorSession(jar, async () => { order.push('b'); })
	]);
	assert.deepEqual(order, ['a-start', 'a-end', 'b']);
	await assert.rejects(withInfoMentorSession(jar, async () => { throw new Error('expected'); }));
	assert.equal(await withInfoMentorSession(jar, async () => 42), 42, 'failure must release queue');
	const job = startLearnlogJob(jar, () => true);
	assert.equal(job.running, true);
	assert.equal(startLearnlogJob(jar, () => true), job, 'concurrent starts must join one job');
	while (job.running) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(job.ok, true);
	console.log('OK: pupil-session serialization and deduplicated background jobs');

	const path = join(directory, 'file.bin');
	await writeFile(path, '0123456789');
	for (const [range, status, body] of [
		[null, 200, '0123456789'], ['bytes=0-1', 206, '01'], ['bytes=4-', 206, '456789'],
		['bytes=-3', 206, '789'], ['bytes=8-99', 206, '89'], ['bytes=-99', 206, '0123456789'],
		['bytes=10-', 416, ''], ['bytes=4-2', 416, ''], ['bytes=-0', 416, ''],
		['bytes=0-1,3-4', 200, '0123456789'], ['bytes=-', 200, '0123456789']
	] as const) {
		const headers = range ? { Range: range } : undefined;
		const response = await fileResponse(path, 'video/mp4', new Request('http://localhost/media/1', { headers }));
		assert.equal(response.status, status, range ?? 'full');
		assert.equal(await response.text(), body);
		if (status === 416) assert.equal(response.headers.get('content-range'), 'bytes */10');
	}
	const head = await fileResponse(path, 'video/mp4', new Request('http://localhost/media/1', { method: 'HEAD' }));
	assert.equal(head.headers.get('content-length'), '10');
	assert.equal(await head.text(), '');
	assert.equal(parseRange('bytes=0-1', 0), 'unsatisfiable');
	await writeFile(path, '');
	assert.equal((await fileResponse(path, 'video/mp4', new Request('http://localhost/media/1', { headers: { Range: 'bytes=0-' } }))).status, 404);
	console.log('OK: byte ranges, suffixes, clamping, HEAD and empty legacy files');

	await writeFile(path, 'original');
	await assert.rejects(saveDownload(new Response(''), path, 10), /empty/);
	await assert.rejects(saveDownload(new Response('abc', { status: 206 }), path, 10), /rejected/);
	let cancelled = false;
	let reads = 0;
	const endless = new ReadableStream<Uint8Array>({
		pull(controller) { reads++; controller.enqueue(new Uint8Array(8)); },
		cancel() { cancelled = true; }
	});
	await assert.rejects(saveDownload(new Response(endless), path, 16), /exceeds/);
	assert.ok(cancelled && reads <= 4, 'unknown-length download must abort at the cap');
	assert.equal(await readFile(path, 'utf8'), 'original', 'failed download must not overwrite a good file');
	assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
	await saveDownload(new Response('new'), path, 16);
	assert.equal(await readFile(path, 'utf8'), 'new');
	console.log('OK: bounded streaming, atomic writes, empty/partial rejection and cleanup');

	const media = { fileId: 9001, fileType: 'Video', fileExtension: 'mov', fileUrl: '/Resources/Resource/Download/9001', thumbnailUrl: '/Resources/Resource/Thumbnail/9001?width=100&height=100' };
	await writeFile(localMediaPath(9001, 'mov'), '');
	cache.upsertMedia(media, 0, 111, 1000);
	assert.ok(!cache.listCachedMediaFileIds().has(9001));
	mediaRequests = 0;
	await Promise.all([ensureMedia(jar, media, 111, 1000), ensureMedia(jar, media, 111, 1000)]);
	assert.equal(mediaRequests, 1);
	assert.equal(cache.getCachedMedia(9001)?.contentLength, mediaBody.length);
	mediaBody = Buffer.alloc(0);
	const empty = { ...media, fileId: 9002 };
	await assert.rejects(ensureMedia(jar, empty, 111, 1000), /empty/);
	const attempts = mediaRequests;
	await assert.rejects(ensureMedia(jar, empty, 111, 1000), /retry later/);
	assert.equal(mediaRequests, attempts);
	assert.equal(cache.getCachedMedia(9002), null);
	console.log('OK: empty-file repair, deduplication and failed-media backoff');

	// The old handler rejected these before looking at their valid image bytes.
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTf8AAAAASUVORK5CYII=', 'base64');
	mediaBody = png;
	for (const [index, mime] of ['application/octet-stream', null, 'text/plain', 'text/html'].entries()) {
		mediaContentType = mime;
		const thumbnail = { ...media, fileId: 9100 + index };
		const downloaded = await ensureMedia(jar, thumbnail, 111, 1000, true);
		assert.equal(downloaded, localThumbnailPath(thumbnail.fileId));
		assert.equal(await thumbnailContentType(downloaded), 'image/png');
		assert.deepEqual(await readFile(downloaded), png);
	}
	assert.equal(appDataRequests, 0, 'valid image bytes need no session probe');
	mediaContentType = 'text/html';
	mediaBody = Buffer.from('<html><h1>Thumbnail not available</h1></html>');
	await assert.rejects(ensureMedia(jar, { ...media, fileId: 9200 }, 111, 1000, true), (err: Error) => {
		assert.ok(!(err instanceof InfoMentorSessionExpiredError), 'generic HTML must not mean expired login');
		assert.match(err.message, /unsupported thumbnail/);
		return true;
	});
	await assert.rejects(readFile(localThumbnailPath(9200)), /ENOENT/);
	mediaContentType = 'application/octet-stream';
	mediaBody = Buffer.from('<html><input name="login_ascx$txtNotandanafn"><input name="login_ascx$txtLykilord"></html>');
	await assert.rejects(ensureMedia(jar, { ...media, fileId: 9201 }, 111, 1000, true), InfoMentorSessionExpiredError);
	await assert.rejects(readFile(localThumbnailPath(9201)), /ENOENT/);
	console.log('OK: image bytes with generic/missing MIME; generic HTML versus genuine login');

	for (const status of [401, 403]) {
		mediaStatus = status;
		mediaBody = Buffer.from('Access denied to this file');
		await assert.rejects(ensureMedia(jar, { ...media, fileId: 9300 + status }, 111, 1000, true), (err: Error) => {
			assert.ok(!(err instanceof InfoMentorSessionExpiredError), 'resource denial is not session expiry while appData succeeds');
			return true;
		});
	}
	assert.equal(appDataRequests, 2);
	const afterMediaFailure = startLearnlogJob(jar, () => true);
	while (afterMediaFailure.running) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(afterMediaFailure.ok, true, 'media failure must not poison the sync queue');
	appDataStatus = 503;
	await assert.rejects(ensureMedia(jar, { ...media, fileId: 9400 }, 111, 1000, true), (err: Error) => {
		assert.ok(!(err instanceof InfoMentorSessionExpiredError), 'an inconclusive probe must not imply session expiry');
		return true;
	});
	appDataStatus = 401;
	await assert.rejects(ensureMedia(jar, { ...media, fileId: 9401 }, 111, 1000, true), InfoMentorSessionExpiredError);
	console.log('OK: resource 401/403 checked against session, sync survives media errors, genuine expiry propagates');
} finally {
	globalThis.fetch = realFetch;
	db.close();
	await rm(directory, { recursive: true, force: true });
}
