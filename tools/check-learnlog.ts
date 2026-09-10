#!/usr/bin/env node
// Offline regressions: temporary SQLite/media, synthetic pupils, no credentials.
// Run: node tools/check-learnlog.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LearnlogEntry } from '../src/lib/server/infomentor/api.ts';
import type { CachedLearnlogEntry } from '../src/lib/learnlog.ts';
import { groupLearnlogEntries } from '../src/lib/learnlog-grouping.ts';

const directory = await mkdtemp(join(tmpdir(), 'dementor-check-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const { learnlogFiles, isManadsbrev } = await import('../src/lib/learnlog.ts');
const { db } = await import('../src/lib/server/db.ts');
const cache = await import('../src/lib/server/cache.ts');
const { syncLearnlog } = await import('../src/lib/server/sync.ts');
const { fileResponse, parseRange } = await import('../src/lib/server/file-response.ts');
const { saveDownload } = await import('../src/lib/server/download.ts');
const { ensureMedia, localMediaPath, localThumbnailPath, thumbnailContentType } = await import('../src/lib/server/media.ts');
const { InfoMentorSessionExpiredError } = await import('../src/lib/server/infomentor/errors.ts');
const { createCookieJar } = await import('../src/lib/server/infomentor/cookieJar.ts');
const { withInfoMentorSession } = await import('../src/lib/server/infomentor/queue.ts');
const { startLearnlogJob, streamLearnlogJob } = await import('../src/lib/server/learnlog-jobs.ts');
const { readSync } = await import('../src/lib/read-sync.ts');
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
let beforePage: ((pupil: number) => Promise<void>) | undefined;
let pageOverride: ((page: number, size: number) => LearnlogEntry[] | undefined) | undefined;
let mediaRequests = 0;
const mediaUrls: string[] = [];
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
		await beforePage?.(selected);
		if (page === failPage && size === 12) throw new Error('simulated network failure');
		const all = source.get(selected) ?? [];
		return Response.json(pageOverride?.(page, size) ?? all.slice((page - 1) * size, page * size));
	}
	if (url.pathname.includes('/communication/communication/appData')) {
		appDataRequests++;
		return Response.json({ consentViewConfig: {} }, { status: appDataStatus });
	}
	if (url.pathname.includes('/Resources/')) {
		mediaRequests++;
		mediaUrls.push(url.href);
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

	function activity(id: number, changes: Partial<LearnlogEntry> = {}): CachedLearnlogEntry {
		return {
			pupilSwitchId: 111, entryId: id, pupilName: 'First', syncedAt: '2026-09-09T18:00:00Z',
			json: { ...entry(id), title: 'Skogen', text: '', lastModifiedOn: 'den 9 september 2026 klockan 17:34', ...changes }
		};
	}
	const activityMedia = Array.from({ length: 11 }, (_, i) => ({
		fileId: 7000 + i, fileType: i === 0 ? 'Video' : 'Image', fileExtension: i === 0 ? 'mov' : 'png',
		thumbnailUrl: `/Resources/Resource/Thumbnail/${7000 + i}?width=100&height=100`,
		fileUrl: `/Resources/Resource/Download/${7000 + i}`
	}));
	const activityParts = [
		activity(40, { media: activityMedia.slice(0, 1) }),
		activity(20, { title: '  SKOGEN ', text: '<p><br>&nbsp;&#160;&#xA0;</p>', lastModifiedOn: 'den 9 september 2026 klockan 17:32', media: activityMedia.slice(1, 5) }),
		activity(10, { text: '<p>We explored the forest.</p>', lastModifiedOn: 'den 9 september 2026 klockan 17:29', media: activityMedia.slice(5) })
	];
	const originalParts = structuredClone(activityParts);
	const grouped = groupLearnlogEntries(activityParts);
	assert.equal(grouped.length, 1, 'caption, photos and video should form one activity');
	assert.equal(grouped[0].sourceCount, 3);
	assert.equal(grouped[0].entry.entryId, 40, 'keep the newest source identity and feed position');
	assert.equal(grouped[0].entry.json.lastModifiedOn, activityParts[0].json.lastModifiedOn);
	assert.equal(grouped[0].entry.json.text, activityParts[2].json.text, 'use the body even when the newest entry is empty');
	assert.deepEqual(grouped[0].entry.json.media, activityMedia, 'keep every photo, video and original URL');
	assert.deepEqual(activityParts, originalParts, 'grouping must not mutate cached or query data');
	assert.deepEqual(groupLearnlogEntries([]), []);

	for (const separate of [
		activity(5, { title: 'Another activity' }),
		activity(5, { groupName: 'Another group' }),
		activity(5, { lastModifiedOn: 'den 10 september 2026 klockan 17:34' }),
		activity(5, { lastModifiedOn: 'den 9 september 2025 klockan 17:34' }),
		{ ...activity(5), pupilSwitchId: 222 }
	]) {
		assert.equal(groupLearnlogEntries([activityParts[0], separate]).length, 2, 'do not merge different activities, days, groups or pupils');
	}
	for (const changes of [
		{ title: '' }, { title: '  ' }, { lastModifiedOn: '' }, { lastModifiedOn: 'Today' },
		{ title: 'Månadsbrev september' },
		{ attachments: [{ fileId: 7100, fileName: 'manadsbrev.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/7100' }] }
	]) {
		assert.equal(groupLearnlogEntries([activity(2, changes), activity(1, changes)]).length, 2, 'unknown keys and monthly letters stay separate');
	}
	assert.equal(groupLearnlogEntries([
		activity(2, { title: 'Vår  utflykt' }), activity(1, { title: 'VA\u030aR utflykt' })
	]).length, 1, 'normalize Swedish titles, case and whitespace');
	assert.equal(groupLearnlogEntries([activity(2), activity(1)]).length, 1, 'media-only activities can be grouped');
	const repeatedBody = groupLearnlogEntries([activityParts[2], activity(9, { text: `  ${activityParts[2].json.text}  ` })]);
	assert.equal(repeatedBody.length, 1, 'repeat the same body only once');
	for (const text of ['<p>A different outing.</p>', '<p><img src="/embedded-photo"></p>']) {
		const conflicting = [...activityParts, activity(9, { text })];
		assert.deepEqual(groupLearnlogEntries(conflicting).map((row) => row.entry), conflicting, 'conflicting bodies must leave all source posts separate');
	}

	const sharedAttachment = { fileId: 7200, fileName: 'Notes.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/7200?connectionId=40' };
	const withDuplicates = groupLearnlogEntries([
		activity(40, { media: activityMedia.slice(0, 2), attachments: [sharedAttachment] }),
		activity(20, { media: activityMedia.slice(1, 3), attachments: [sharedAttachment, { ...sharedAttachment, fileId: 7201, downloadUrl: '/Resources/Resource/Download/7201?connectionId=20' }] })
	]);
	assert.deepEqual(withDuplicates[0].entry.json.media, activityMedia.slice(0, 3), 'shared file IDs only appear once');
	assert.deepEqual(withDuplicates[0].entry.json.attachments?.map((file) => file.fileId), [7200, 7201], 'same filename with different IDs must keep both attachments');
	assert.equal(withDuplicates[0].entry.json.attachments?.[0].downloadUrl, sharedAttachment.downloadUrl);

	reset();
	cache.upsertLearnlogEntries(111, [...activityParts.map((part) => part.json), entry(50), entry(30)]);
	const activityPage1 = cache.listLearnlogPage();
	const activityPage2 = cache.listLearnlogPage(activityPage1.nextCursor);
	const beforeMore = groupLearnlogEntries(activityPage1.entries);
	const afterMore = groupLearnlogEntries([...activityPage1.entries, ...activityPage2.entries]);
	assert.deepEqual(beforeMore.map((row) => row.entry.entryId), [50, 40, 30]);
	assert.deepEqual(afterMore.map((row) => row.entry.entryId), [50, 40, 30], 'later pages add to the same card without moving interleaved posts');
	assert.equal(afterMore[1].sourceCount, 3);
	assert.deepEqual(afterMore[1].entry.json.media, activityMedia);
	assert.equal(afterMore[1].entry.json.text, activityParts[2].json.text);
	assert.equal(cache.listLearnlogEntries().length, 5, 'keep all raw rows for cursors, syncing and media lookups');
	assert.equal(cache.findLearnlogMedia(7010)?.entry.id, 10, 'merged media still resolves via its original source entry');
	console.log('OK: related activity grouping, safe boundaries, conflicting bodies, unique files and cross-page merging');

	reset();
	const letter: LearnlogEntry = {
		...entry(20),
		title: 'Information från förskolan',
		attachments: [
			{ fileId: 8001, fileName: 'Förskolan_MÅNADSBREV_september.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/8001?api=IM2&moduleType=LearnLogAttachment&connectionId=20' },
			{ fileId: 8002, fileName: 'Schema.xlsx', fileType: 'Spreadsheet', extension: 'xlsx', downloadUrl: '/Resources/Resource/Download/8002?api=IM2&moduleType=LearnLogAttachment&connectionId=20' }
		]
	};
	assert.equal(isManadsbrev(letter), true, 'filename-only monthly letters belong on /manadsbrev');
	for (const title of ['Månadsbrev september', 'MANADSBREV', 'Månadsbrevet', 'Ma\u030anadsbrev']) {
		assert.equal(isManadsbrev({ ...entry(1), title }), true);
	}
	assert.equal(isManadsbrev({ ...entry(1), text: '<p>Månadsbrev skickas senare.</p>' }), false, 'body references do not classify a post');
	assert.equal(isManadsbrev({ ...letter, attachments: [{ ...letter.attachments![0], fileName: 'Utflykt.pdf' }] }), false, 'a PDF alone is not a monthly letter');
	assert.deepEqual(learnlogFiles(entry(1)), [], 'legacy entries without attachments still work');
	cache.upsertLearnlogEntries(111, [letter]);
	assert.deepEqual(cache.listLearnlogEntries()[0].json, letter, 'read attachments from the existing raw JSON cache');
	assert.deepEqual(cache.listLearnlogPage().entries[0].json.attachments, letter.attachments);
	const attachment = cache.findLearnlogMedia(8001);
	assert.ok(attachment, 'download lookup must include attachments, not just media');
	assert.equal(attachment.pupilSwitchId, 111);
	assert.equal(attachment.entry.id, 20);
	assert.deepEqual(attachment.media, {
		fileId: 8001, fileType: 'Document', fileExtension: 'pdf', thumbnailUrl: '',
		fileUrl: letter.attachments![0].downloadUrl
	});
	assert.equal(cache.findLearnlogMedia(8002)?.media.fileExtension, 'xlsx');
	assert.equal(cache.findLearnlogMedia(9999), null, 'unknown files must not be downloadable');
	mediaBody = Buffer.from('%PDF-1.4\nsynthetic attachment\n%%EOF');
	const attachmentPath = await ensureMedia(createCookieJar(), attachment.media, attachment.pupilSwitchId, attachment.entry.id);
	assert.equal(mediaUrls.at(-1), `https://hub.infomentor.se${letter.attachments![0].downloadUrl}`, 'preserve the LearnLogAttachment URL and connectionId');
	assert.deepEqual(await readFile(attachmentPath), mediaBody);
	assert.deepEqual(cache.listLearnlogPage().cachedMediaFileIds, [8001]);
	assert.ok(cache.listCachedMediaFileIds().has(8001));
	const photo = { fileId: 8003, fileType: 'Image', fileExtension: 'png', fileUrl: '/Resources/Resource/Download/8003', thumbnailUrl: '/Resources/Resource/Thumbnail/8003' };
	cache.upsertLearnlogEntries(111, [{ ...letter, media: [photo] }]);
	assert.deepEqual(cache.findLearnlogMedia(8003)?.media, photo, 'mixed media and attachments keep photo lookup intact');
	assert.ok(cache.findLearnlogMedia(8001));
	mediaRequests = 0;
	mediaBody = Buffer.from('sample media bytes');
	console.log('OK: monthly titles/filenames, legacy cache, PDF/generic attachments, trusted downloads and mixed media');

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
	assert.deepEqual(pages.map((page) => page.size), [4, 4], 'navigation fetches only recent posts for each pupil');
	assert.equal(cold.newEntries, 6);
	assert.equal(cold.moreHistory, true);
	assert.equal(cache.listLearnlogEntries().length, 6);
	async function drainHistory(pupils: number[]) {
		let summary = await syncLearnlog(jar, pupils);
		for (let count = 0; summary.moreHistory && !summary.historyPaused; count++) {
			assert.ok(count < 100, 'history must eventually finish');
			const next = await syncLearnlog(jar, pupils, undefined, undefined, 'history');
			summary = { ...next, newEntries: summary.newEntries + next.newEntries };
		}
		return summary;
	}
	await drainHistory([111, 222]);
	assert.equal(cache.listLearnlogEntries().length, 63);
	assert.equal(mediaRequests, 0, 'metadata sync must not download media');
	pages = [];
	const warm = await syncLearnlog(jar, [111, 222]);
	assert.equal(warm.newEntries, 0);
	assert.equal(warm.pagesFetched, 2);
	assert.ok(pages.every((page) => page.size === 4));
	source.get(111)!.unshift(...[107, 106, 105, 104, 103, 102, 101].map(entry));
	assert.equal((await drainHistory([111])).newEntries, 7);
	console.log('OK: progressive cold sync, correct counts, small no-change sync, catch-up');

	reset();
	source = new Map([[111, Array.from({ length: 260 }, (_, i) => entry(1000 - i))]]);
	const capped = await syncLearnlog(jar, [111]);
	assert.equal(capped.moreHistory, true);
	assert.equal(cache.listLearnlogEntries().length, 4, 'a cold visit must not scan history');
	pages = [];
	await syncLearnlog(jar, [111], undefined, undefined, 'history');
	assert.deepEqual(pages.map(({ page, size }) => [page, size]), [[1, 4], [1, 12]]);
	assert.equal(cache.listLearnlogEntries().length, 12, 'only two UI pages ahead');
	pages = [];
	await syncLearnlog(jar, [111], undefined, undefined, 'history');
	assert.deepEqual(pages.map(({ page, size }) => [page, size]), [[1, 4], [1, 12], [2, 12]]);
	assert.equal(cache.listLearnlogEntries().length, 24);
	await syncLearnlog(jar, [111]);
	assert.equal(cache.listLearnlogEntries().length, 24, 'revisiting must not resume history');
	const resumed = await drainHistory([111]);
	assert.equal(resumed.moreHistory, false);
	assert.equal(cache.listLearnlogEntries().length, 260, 'scrolling must not strand older posts');
	reset();
	source = new Map([[111, Array.from({ length: 70 }, (_, i) => entry(1000 - i))]]);
	await syncLearnlog(jar, [111], undefined, undefined, 'history');
	failPage = 2;
	await assert.rejects(syncLearnlog(jar, [111], undefined, undefined, 'history'), /simulated network/);
	assert.equal(cache.listLearnlogEntries().length, 12);
	failPage = 0;
	await drainHistory([111]);
	assert.equal(cache.listLearnlogEntries().length, 70, 'partial latest page must not advance the completed watermark');
	console.log('OK: backfill cap and failure resume without gaps');

	// Feed order is not numeric ID order. An older post can be moved to page 1.
	reset();
	source = new Map([[111, [entry(1), ...Array.from({ length: 59 }, (_, i) => entry(1000 - i))]]]);
	const unordered = await drainHistory([111]);
	assert.equal(unordered.newEntries, 60);
	assert.equal(unordered.historyPaused, false);
	assert.equal(unordered.moreHistory, false);
	source.get(111)!.unshift(entry(2));
	source.get(111)!.splice(10, 0, entry(3));
	const lowIdPosts = await drainHistory([111]);
	assert.equal(lowIdPosts.newEntries, 2, 'overlap must use known IDs, not a numeric high-water mark');
	assert.ok(cache.listLearnlogEntries().some((row) => row.entryId === 3));

	reset();
	source = new Map([[111, Array.from({ length: 80 }, (_, i) => entry(1000 - i))]]);
	pageOverride = (page, size) => page === 2 && size === 12 ? [...source.get(111)!.slice(0, 12)].reverse() : undefined;
	const repeated = await drainHistory([111]);
	assert.equal(repeated.moreHistory, true);
	assert.equal(repeated.historyPaused, true, 'identical ID sets should pause even in a different order');
	assert.equal(cache.listLearnlogEntries().length, 12);
	const pausedPosition = db.prepare('SELECT target_highest, completed_highest, next_page FROM learnlog_sync WHERE pupil_switch_id = 111').get()!;
	assert.ok(pausedPosition.target_highest !== null);
	assert.equal(pausedPosition.completed_highest, null, 'a repeat must not mark missing history complete');
	assert.equal(pausedPosition.next_page, 2);
	pageOverride = undefined;
	const recovered = await drainHistory([111]);
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

	reset();
	source = new Map([[111, Array.from({ length: 100 }, (_, i) => entry(1000 - i))], [222, [entry(3)]]]);
	let releaseSecond = () => {};
	const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
	beforePage = async (pupil) => { if (pupil === 222) await secondReady; };
	const streamedJar = createCookieJar();
	const response = streamLearnlogJob(streamedJar, () => true, 'latest');
	const updates = readSync(response);
	assert.equal((await updates.next()).value?.running, true);
	const firstBatch = await updates.next();
	assert.equal(firstBatch.value?.summary?.newEntries, 4);
	assert.equal(firstBatch.value?.running, true);
	assert.equal(cache.listLearnlogEntries().length, 4, 'committed first pupil is visible before the second response');
	releaseSecond();
	let terminal;
	for await (const status of updates) terminal = status;
	assert.equal(terminal?.running, false);
	assert.equal(terminal?.summary?.moreHistory, true);
	beforePage = undefined;

	const cancelledJar = createCookieJar();
	const cancelledStream = streamLearnlogJob(cancelledJar, () => true, 'history');
	const beforeCancel = pages.length;
	await cancelledStream.body!.cancel();
	const cancelledJob = startLearnlogJob(cancelledJar, () => true);
	while (cancelledJob.running) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(pages.length, beforeCancel, 'disconnect before work starts must not fetch upstream');
	const unfinished = new Response('{"ok":true,"running":true}\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
	await assert.rejects(async () => { for await (const _status of readSync(unfinished)) { /* consume */ } }, /avbröts/);
	const finalLine = new TextEncoder().encode('{"ok":true,"running":false,"detail":"Hämtat"}\n');
	const fragmented = new Response(new ReadableStream({ start(controller) {
		for (const byte of finalLine) controller.enqueue(new Uint8Array([byte]));
		controller.close();
	} }), { headers: { 'Content-Type': 'application/x-ndjson' } });
	for await (const status of readSync(fragmented)) assert.equal(status.detail, 'Hämtat');
	console.log('OK: incremental stream, cold first batch, bounded completion, disconnect and fragmented/truncated responses');

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
	await assert.rejects(ensureMedia(createCookieJar(), { ...media, fileId: 9201 }, 111, 1000, true), InfoMentorSessionExpiredError);
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
	const requestsAfterExpiry = mediaRequests;
	await assert.rejects(ensureMedia(jar, { ...media, fileId: 9500 }, 111, 1000), InfoMentorSessionExpiredError);
	assert.equal(mediaRequests, requestsAfterExpiry, 'expired jar must fail before making another media request');
	const expiredJar = createCookieJar();
	let tasksRun = 0;
	const failedTasks = await Promise.allSettled(Array.from({ length: 8 }, () => withInfoMentorSession(expiredJar, async () => {
		tasksRun++;
		throw new InfoMentorSessionExpiredError();
	})));
	assert.equal(tasksRun, 1, 'queued work must stop after confirmed expiry');
	assert.ok(failedTasks.every((task) => task.status === 'rejected' && task.reason instanceof InfoMentorSessionExpiredError));
	assert.equal(await withInfoMentorSession(createCookieJar(), async () => 'fresh'), 'fresh', 'reauthentication uses an unblocked new jar');
	console.log('OK: session-wide expiry circuit breaker and new-cookie recovery');
} finally {
	globalThis.fetch = realFetch;
	db.close();
	await rm(directory, { recursive: true, force: true });
}
