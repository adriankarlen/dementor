#!/usr/bin/env node
// Offline, synthetic video/range regressions. Never reads the family cache.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'dementor-video-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const { db } = await import('../src/lib/server/db.ts');
const { getCachedMedia } = await import('../src/lib/server/cache.ts');
const { videoRangeResponse, VIDEO_CHUNK_BYTES: chunkSize } = await import('../src/lib/server/video-ranges.ts');
const { parseRange } = await import('../src/lib/server/file-response.ts');
const { createCookieJar } = await import('../src/lib/server/infomentor/cookieJar.ts');
const { createSession } = await import('../src/lib/server/infomentor/httpClient.ts');
const { withInfoMentorSession } = await import('../src/lib/server/infomentor/queue.ts');
const { InfoMentorSessionExpiredError } = await import('../src/lib/server/infomentor/errors.ts');
const realFetch = globalThis.fetch;
const source = Buffer.alloc(chunkSize * 3 + 1000, 7);
source.write('synthetic binary video');
let requests: string[] = [];
let sentBytes = 0;
let ignoreRange = false;
let broken = false;
let expired = false;
let slowFullReads = 0;
let waitForRange: Promise<void> | undefined;
let rangeRequested = () => {};
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.equal(url.hostname, 'hub.infomentor.se');
	if (url.pathname.includes('SwitchPupil')) return new Response('<html>Hub</html>');
	const range = new Headers(init?.headers).get('range');
	if (url.pathname === '/header-check') return Response.json({ range });
	assert.ok(range, 'Range must survive the cookie-aware Headers wrapper');
	requests.push(range);
	rangeRequested();
	await waitForRange;
	init?.signal?.throwIfAborted();
	if (expired) return new Response('<html><body onload="document.forms[0].submit()"><form></form></body></html>');
	if (ignoreRange) { sentBytes += source.length; return new Response(source); }
	const part = parseRange(range, source.length);
	assert.ok(part);
	if (part === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${source.length}` } });
	const bytes = source.subarray(part.start, part.end + 1);
	sentBytes += bytes.length;
	if (bytes.length === source.length) slowFullReads++;
	return new Response(broken ? bytes.subarray(0, 8) : bytes, {
		status: 206,
		headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${part.start}-${part.end}/${source.length}`, 'Content-Length': String(bytes.length), ETag: '"synthetic"' }
	});
};
const jar = createCookieJar();
function media(id: number) {
	return { fileId: id, fileType: 'Video', fileExtension: 'mov', fileUrl: `/Resources/Resource/Download/${id}`, thumbnailUrl: '' };
}
function request(id: number, range: string, cookieJar = jar, extraHeaders = {}) {
	return videoRangeResponse(cookieJar, media(id), 111, 1000, new Request(`http://localhost/media/${id}`, { headers: { Range: range, ...extraHeaders } }), () => true);
}
try {
	for (const headers of [new Headers({ Range: 'bytes=0-3' }), [['Range', 'bytes=0-3']] as [string, string][], { Range: 'bytes=0-3' }]) {
		const response = await createSession(jar).request('https://hub.infomentor.se/header-check', { headers });
		assert.equal((await response.json()).range, 'bytes=0-3');
	}
	const first = await request(1, 'bytes=0-4095');
	assert.equal(first.status, 206);
	assert.equal(first.headers.get('content-range'), `bytes 0-4095/${source.length}`);
	assert.equal((await first.arrayBuffer()).byteLength, 4096);
	assert.equal(sentBytes, chunkSize, 'tiny browser probes must not download the full video');
	assert.match(first.headers.get('server-timing')!, /queue;dur=.*upstream;dur=.*cache;desc="miss"/);
	assert.equal(getCachedMedia(1), null, 'partial chunks must not be recorded as a full file');
	const tail = await request(1, 'bytes=-256');
	assert.deepEqual(Buffer.from(await tail.arrayBuffer()), source.subarray(-256));
	assert.ok(sentBytes <= chunkSize * 2, 'EOF metadata must be fetched without reading the middle');
	assert.equal(slowFullReads, 0);
	const beforeCached = requests.length;
	const cached = await request(1, 'bytes=10-19', createCookieJar());
	assert.deepEqual(Buffer.from(await cached.arrayBuffer()), source.subarray(10, 20));
	assert.match(cached.headers.get('server-timing')!, /cache;desc="hit"/);
	assert.equal(requests.length, beforeCached, 'disk ranges are reusable by another session');
	const ifRange = await request(1, 'bytes=20-29', jar, { 'If-Range': cached.headers.get('etag')! });
	assert.equal(ifRange.status, 206);
	await ifRange.arrayBuffer();
	const boundary = await request(1, `bytes=${chunkSize - 10}-${chunkSize + 10}`);
	assert.equal((await boundary.arrayBuffer()).byteLength, 10, 'only return the cached portion, with an honest Content-Range');
	assert.equal(boundary.headers.get('content-range'), `bytes ${chunkSize - 10}-${chunkSize - 1}/${source.length}`);
	for (const range of ['bytes=99-1', 'bytes=-0', 'bytes=999999999999999999-', 'bytes=0-1,3-4', `bytes=${source.length}-`]) {
		assert.equal((await request(1, range)).status, 416);
	}
	assert.equal((await request(2, `bytes=${source.length + chunkSize}-`)).status, 416, 'cold unsatisfiable ranges preserve 416');
	const suffixFirst = await request(3, 'bytes=-1024');
	assert.deepEqual(Buffer.from(await suffixFirst.arrayBuffer()), source.subarray(-1024));
	const largeSuffix = await request(4, `bytes=-${chunkSize * 2}`);
	assert.equal(largeSuffix.status, 206);
	assert.ok((await largeSuffix.arrayBuffer()).byteLength <= chunkSize);
	const beforeConcurrent = requests.length;
	const concurrent = await Promise.all([request(5, 'bytes=0-1'), request(5, 'bytes=0-10')]);
	await Promise.all(concurrent.map((res) => res.arrayBuffer()));
	assert.equal(requests.length - beforeConcurrent, 1, 'same chunk shares one upstream request');
	let releaseShared = () => {};
	waitForRange = new Promise<void>((resolve) => { releaseShared = resolve; });
	const sharedStarted = new Promise<void>((resolve) => { rangeRequested = resolve; });
	const firstController = new AbortController();
	const firstReader = videoRangeResponse(jar, media(11), 111, 1000, new Request('http://localhost/media/11', { headers: { Range: 'bytes=0-1' }, signal: firstController.signal }), () => true);
	const firstCancelled = assert.rejects(firstReader, (err: Error) => err.name === 'AbortError');
	const secondReader = request(11, 'bytes=0-10');
	await sharedStarted;
	await new Promise((resolve) => setTimeout(resolve, 20));
	firstController.abort();
	await firstCancelled;
	releaseShared();
	const sharedResponse = await secondReader;
	assert.equal((await sharedResponse.arrayBuffer()).byteLength, 11, 'one cancelled reader must not cancel a shared chunk for another reader');
	waitForRange = undefined;
	rangeRequested = () => {};
	broken = true;
	await assert.rejects(request(6, 'bytes=0-1'), /incomplete/);
	broken = false;
	assert.equal(getCachedMedia(6), null);
	assert.ok(!(await readdir(join(directory, 'media', '6.ranges'), { recursive: true })).some((name) => name.endsWith('.chunk') || name.endsWith('.tmp')), 'failed chunks are never published');
	ignoreRange = true;
	const fallback = await request(7, 'bytes=0-1');
	assert.equal((await fallback.arrayBuffer()).byteLength, 2);
	assert.equal(getCachedMedia(7)?.contentLength, source.length, 'upstream 200 reuses the one response as a full cache download');
	assert.match(fallback.headers.get('server-timing')!, /range-unsupported/);
	ignoreRange = false;
	expired = true;
	await assert.rejects(request(8, 'bytes=0-1'), InfoMentorSessionExpiredError);
	const afterExpired = requests.length;
	await assert.rejects(request(9, 'bytes=0-1'), InfoMentorSessionExpiredError);
	assert.equal(requests.length, afterExpired);

	const priorityJar = createCookieJar();
	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const order: string[] = [];
	const busy = withInfoMentorSession(priorityJar, async () => { order.push('in-flight'); await gate; });
	const thumbnail = withInfoMentorSession(priorityJar, async () => { order.push('thumbnail'); });
	const video = withInfoMentorSession(priorityJar, async () => { order.push('video'); }, 'interactive');
	release();
	await Promise.all([busy, thumbnail, video]);
	assert.deepEqual(order, ['in-flight', 'video', 'thumbnail']);
	let releaseQueued = () => {};
	const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
	const held = withInfoMentorSession(priorityJar, () => queuedGate);
	const abort = new AbortController();
	const beforeAbort = requests.length;
	const cancelled = videoRangeResponse(priorityJar, media(10), 111, 1000, new Request('http://localhost/media/10', { headers: { Range: 'bytes=0-1' }, signal: abort.signal }), () => true);
	abort.abort();
	releaseQueued();
	await assert.rejects(cancelled, (err: Error) => err.name === 'AbortError');
	await held;
	assert.equal(requests.length, beforeAbort, 'closing a video while queued must not start its download');
	console.log('OK: bounded cold video ranges, EOF seeks, disk cache, suffixes, coalescing, malformed/truncated responses, auth, Range headers and interactive priority');
} finally {
	globalThis.fetch = realFetch;
	db.close();
	await rm(directory, { recursive: true, force: true });
}
