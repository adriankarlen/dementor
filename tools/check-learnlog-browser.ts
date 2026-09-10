#!/usr/bin/env node
// Browser + route regression test with synthetic data and a disposable cache.
// pnpm exec playwright install chromium
// node tools/check-learnlog-browser.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parseRange } from '../src/lib/server/file-response.ts';
import type { LearnlogEntry } from '../src/lib/server/infomentor/api.ts';

const directory = await mkdtemp(join(tmpdir(), 'dementor-browser-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const realFetch = globalThis.fetch;
const mov = await readFile(new URL('./fixtures/black-h264.mov', import.meta.url));
const incompatibleMov = await readFile(new URL('./fixtures/black-prores-pcm.mov', import.meta.url));
const tailMov = await readFile(new URL('./fixtures/black-h264-tail.mov', import.meta.url));
let moovOffset = 0;
let mdatOffset = 0;
while (tailMov.toString('ascii', moovOffset + 4, moovOffset + 8) !== 'moov') {
	if (tailMov.toString('ascii', moovOffset + 4, moovOffset + 8) === 'mdat') mdatOffset = moovOffset;
	moovOffset += tailMov.readUInt32BE(moovOffset);
}
const padding = Buffer.alloc(48 * 1024 * 1024);
// Match phone MOVs: a large mdat atom, followed by EOF metadata. A large
// 'free' atom does not exercise the browser's media-data buffering behavior.
const largeMov = Buffer.concat([tailMov.subarray(0, moovOffset), padding, tailMov.subarray(moovOffset)]);
largeMov.writeUInt32BE(tailMov.readUInt32BE(mdatOffset) + padding.length, mdatOffset);
let largeVideoBytes = 0;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTf8AAAAASUVORK5CYII=', 'base64');
const entries = Array.from({ length: 14 }, (_, i) => ({
	id: 200 - i, title: `Test post ${i + 1}`, text: '<p>A day at preschool.</p>', groupName: 'Example group',
	lastModifiedOn: 'Today', subjectsCoursesDisplayString: '',
	media: Array.from({ length: 4 }, (_, n) => ({
		fileId: 10000 + i * 4 + n, fileType: n === 0 ? 'Video' : 'Image', fileExtension: n === 0 ? 'mov' : 'png',
		thumbnailUrl: `/Resources/Resource/Thumbnail/${10000 + i * 4 + n}?width=100&height=100`,
		fileUrl: `/Resources/Resource/Download/${10000 + i * 4 + n}`
	}))
}));
const newsletters: LearnlogEntry[] = [
	{ ...entries[0], id: 503, title: 'Månadsbrev september', media: [], attachments: [
		{ fileId: 20001, fileName: 'September.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/20001?api=IM2&moduleType=LearnLogAttachment&connectionId=503' },
		{ fileId: 20002, fileName: 'Schema.docx', fileType: 'Word processor', extension: 'docx', downloadUrl: '/Resources/Resource/Download/20002?api=IM2&moduleType=LearnLogAttachment&connectionId=503' }
	] },
	{ ...entries[0], id: 502, title: 'Information från förskolan', media: [entries[0].media[1]], attachments: [
		{ fileId: 20003, fileName: 'Förskolan_manadsbrev_oktober_med_ett_långt_filnamn.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/20003?api=IM2&moduleType=LearnLogAttachment&connectionId=502' }
	] },
	{ ...entries[0], id: 501, title: 'Utflykt', media: [], attachments: [
		{ fileId: 20004, fileName: 'Utflykt.pdf', fileType: 'Document', extension: 'pdf', downloadUrl: '/Resources/Resource/Download/20004?api=IM2&moduleType=LearnLogAttachment&connectionId=501' }
	] }
];
let showNewsletters = false;
const activityMedia = [entries[0].media[0], ...entries.flatMap((entry) => entry.media).filter((file) => file.fileType === 'Image').slice(0, 10)];
const activityBase = { ...entries[0], title: 'Skogen', text: '', lastModifiedOn: 'den 9 september 2026 klockan 17:34' };
const activities: LearnlogEntry[] = [
	{ ...entries[0], id: 706 },
	{ ...activityBase, id: 705, media: activityMedia.slice(0, 1) },
	{ ...activityBase, id: 704, lastModifiedOn: 'den 9 september 2026 klockan 17:32', media: activityMedia.slice(1, 5) },
	{ ...entries[1], id: 703 },
	{ ...activityBase, id: 702, text: '<p>We explored the forest together.</p>', lastModifiedOn: 'den 9 september 2026 klockan 17:29', media: activityMedia.slice(5) }
];
let showActivities = false;
const pdf = Buffer.from('%PDF-1.4\nsynthetic attachment\n%%EOF');
const attachmentRequests: string[] = [];
let upstreamDownloads = 0;
// Split out so "must not fetch a full video"/"prefetch fetched the photos"
// assertions stay meaningful once background photo prefetch (intentionally)
// starts making full-image requests alongside explicit opens/attachments.
let upstreamVideoDownloads = 0;
let upstreamImageDownloads = 0;
let historyDelay = 150;
let selectedPupil = 111;
let secondPupilDelay = 0;
let expiredUpstream = false;
const learnlogRequests: { page: number; size: number }[] = [];
let upstreamRequests = 0;
const thumbnailRequests = new Map<number, number>();
let repeatHistory = false;
const repeatedBatch = Array.from({ length: 12 }, (_, i) => ({ ...entries[0], id: 1000 + i }));

/** Poll a Node-side counter until a background prefetch batch settles, instead
 *  of guessing a fixed sleep duration. */
async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== 'hub.infomentor.se') return realFetch(input, init);
	upstreamRequests++;
	if (expiredUpstream) return new Response('<html><body onload="document.forms[0].submit()"><form></form></body></html>');
	if (url.pathname.includes('SwitchPupil')) {
		selectedPupil = Number(url.pathname.split('/').at(-1));
		return new Response('<html>Hub</html>');
	}
	if (url.pathname.includes('getlearnlogs')) {
		const size = Number(url.searchParams.get('pageSize'));
		await new Promise((resolve) => setTimeout(resolve, selectedPupil === 222 ? secondPupilDelay : size === 4 ? 150 : historyDelay));
		const page = Number(url.searchParams.get('pageNumber'));
		learnlogRequests.push({ page, size });
		if (selectedPupil === 222) return Response.json([]);
		if (repeatHistory) return Response.json(size === 4 ? repeatedBatch.slice(0, 4) : repeatedBatch);
		const posts = showNewsletters ? newsletters : showActivities ? activities : entries;
		return Response.json(posts.slice((page - 1) * size, page * size));
	}
	if (url.pathname.includes('Thumbnail')) {
		// Valid image bytes with generic/missing MIME must still render through our route.
		const id = Number(url.pathname.split('/').at(-1));
		thumbnailRequests.set(id, (thumbnailRequests.get(id) ?? 0) + 1);
		if (id % 4 === 0 || id === entries[13].media[1].fileId) {
			return new Response('<html>Video thumbnail unavailable</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
		}
		return new Response(png, { headers: id % 2 === 0 ? { 'Content-Type': 'application/octet-stream' } : undefined });
	}
	if (url.pathname.includes('Download')) {
		upstreamDownloads++;
		const attachment = newsletters.flatMap((entry) => entry.attachments ?? []).find((file) => file.fileId === Number(url.pathname.split('/').at(-1)));
		if (attachment) {
			assert.equal(url.href, `https://hub.infomentor.se${attachment.downloadUrl}`, 'use the attachment URL unchanged');
			attachmentRequests.push(url.href);
			return new Response(attachment.extension === 'pdf' ? pdf : Buffer.from('synthetic document'), { headers: { 'Content-Type': 'application/octet-stream' } });
		}
		const fileId = Number(url.pathname.split('/').at(-1));
		// Every video fileId in this fixture set (base entries' n===0 slot, plus
		// every special-cased id reusing that same slot below) is a multiple of
		// 4; image fileIds never are. Background prefetch must only touch images.
		if (fileId % 4 === 0) upstreamVideoDownloads++;
		else upstreamImageDownloads++;
		// 80000 intentionally stays invalid to exercise the decode fallback.
		const bytes = fileId === 88884 ? incompatibleMov : fileId === 88888 || fileId === 88904 ? largeMov : fileId % 4 === 0 && fileId !== 80000 ? mov : png;
		const range = parseRange(new Headers(init?.headers).get('range'), bytes.length);
		if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
		if (fileId === 88888) largeVideoBytes += range ? range.end - range.start + 1 : bytes.length;
		return new Response(range ? bytes.subarray(range.start, range.end + 1) : bytes, {
			status: range ? 206 : 200,
			headers: { 'Content-Type': 'application/octet-stream', ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}) }
		});
	}
	throw new Error(`unexpected upstream request ${url.pathname}`);
};

const server = await createServer({ envDir: false, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
	const cache = await server.ssrLoadModule('/src/lib/server/cache.ts');
	cache.upsertPupil(111, 'Example pupil');
	cache.upsertLearnlogEntries(111, entries.slice(2));
	// Reproduce a poisoned legacy zero-byte video cache entry.
	cache.upsertMedia(entries[2].media[0], 0, 111, entries[2].id);
	await writeFile(join(directory, 'media', `${entries[2].media[0].fileId}.mov`), '');
	const sessions = await server.ssrLoadModule('/src/lib/server/infomentor/session.ts');
	const cookies = await server.ssrLoadModule('/src/lib/server/infomentor/cookieJar.ts');
	const testJar = cookies.createCookieJar();
	sessions.attachSession('browser-test', { username: 'synthetic', cookieJar: testJar, loggedInAt: new Date(), lastUsedAt: new Date() });
	await server.listen();
	const address = server.httpServer!.address();
	assert.ok(address && typeof address !== 'string');
	const base = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
	const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
	await context.addCookies([{ name: 'session', value: 'browser-test', url: base }]);
	const page = await context.newPage();
	page.setDefaultNavigationTimeout(120_000);
	const errors: string[] = [];
	const mediaRequests: string[] = [];
	const syncRequests: string[] = [];
	page.on('pageerror', (err) => errors.push(err.message));
	page.on('request', (request) => {
		if (request.url().includes('/media/')) mediaRequests.push(request.url());
		if (request.url().includes('/api/sync/learnlog')) syncRequests.push(request.method());
	});
	const response = await page.goto(`${base}/larLogg`);
	assert.equal(response?.status(), 200);
	const html = await response!.text();
	assert.equal((html.match(/<h2\b/g) ?? []).length, 4, 'SSR should contain just four cards');
	assert.ok(!html.includes('<video'), 'SSR should not preload videos');
	await page.waitForFunction(() => document.querySelector('h2')?.textContent?.includes('Test post 1'));
	// The cold cache renders a transient earlier page (pre-sync) before
	// settling on entries 1-4, so this is a lower bound, not an exact count —
	// see docs/learnlog-loading.md's incremental-publish behavior.
	const initialPageImages = entries
		.slice(0, 4)
		.flatMap((entry) => entry.media)
		.filter((m) => m.fileType === 'Image').length;
	await waitFor(
		() => upstreamImageDownloads >= initialPageImages,
		"background prefetch of the first four posts' photos"
	);
	await page.waitForTimeout(200);
	assert.equal(await page.locator('h2').count(), 4, 'sync should update the first page without rendering all rows');
	assert.equal(await page.locator('video').count(), 0);
	assert.ok(
		mediaRequests.some((url) => !url.includes('thumbnail=1')),
		'background prefetch should request full images, not just thumbnails'
	);
	assert.ok(
		mediaRequests.every(
			(url) => url.includes('thumbnail=1') || Number(new URL(url).pathname.split('/').pop()) % 4 !== 0
		),
		'background prefetch must never request full video bytes'
	);
	assert.equal(
		upstreamVideoDownloads,
		0,
		'scroll previews, sync and background photo prefetch must not fetch full video files'
	);
	assert.ok(
		upstreamImageDownloads >= initialPageImages,
		"background prefetch should fetch at least the currently loaded posts' photos"
	);
	await page.waitForFunction(() => {
		const thumbnails = [...document.querySelectorAll<HTMLImageElement>('section > ul > li:first-child img')];
		return thumbnails.length === 4 && thumbnails.every((image) => image.complete && image.naturalWidth > 0);
	});
	const thumbnailResponse = await context.request.get(`${base}/media/${entries[0].media[1].fileId}?thumbnail=1`);
	assert.equal(thumbnailResponse.status(), 200);
	assert.equal(thumbnailResponse.headers()['content-type'], 'image/png', 'serve a detected image MIME, not the upstream generic MIME');
	for (let attempt = 0; attempt < 2; attempt++) {
		const placeholder = await context.request.get(`${base}/media/${entries[0].media[0].fileId}?thumbnail=1`);
		assert.equal(placeholder.status(), 200);
		assert.equal(placeholder.headers()['x-thumbnail-placeholder'], '1');
		assert.match(await placeholder.text(), /Förhandsvisning saknas/);
	}
	assert.equal(thumbnailRequests.get(entries[0].media[0].fileId), 1, 'unavailable video posters must not be repeatedly downloaded');
	assert.equal(upstreamVideoDownloads, 0, 'a placeholder must not fetch a full video');
	const missingPhoto = await context.request.get(`${base}/media/${entries[13].media[1].fileId}?thumbnail=1`);
	assert.equal(missingPhoto.status(), 503, 'do not hide an unrelated photo failure behind a video placeholder');
	await page.screenshot({ path: '/tmp/dementor-learnlog-desktop.png', fullPage: false });

	await page.getByRole('button', { name: 'Visa fler inlägg' }).scrollIntoViewIfNeeded();
	await page.waitForFunction(() => document.querySelectorAll('h2').length > 4);
	assert.ok(await page.locator('h2').count() <= 8);
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.waitForSelector('dialog[open] video');
	await page.waitForFunction(() => {
		const video = document.querySelector('dialog[open] video');
		return video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth === 32;
	});
	assert.equal(await page.locator('video').count(), 1, 'valid H.264 MOV must decode; only the selected video may mount');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	assert.equal(await page.locator('video').count(), 0, 'closing must unmount and stop video');

	const fullUrl = `${base}/media/${entries[2].media[0].fileId}`;
	const range = await context.request.get(fullUrl, { headers: { Range: 'bytes=0-1' } });
	assert.equal(range.status(), 206, 'empty cached file should repair on explicit open');
	assert.equal((await range.body()).length, 2);
	const invalid = await context.request.get(`${base}/api/learnlog?cursor=invalid`);
	assert.equal(invalid.status(), 400);
	const head = await context.request.head(fullUrl);
	assert.equal(head.status(), 200);
	const pastEnd = await context.request.get(fullUrl, { headers: { Range: 'bytes=999999-' } });
	assert.equal(pastEnd.status(), 416);
	const anonymous = await browser.newContext();
	assert.ok((await anonymous.request.get(`${base}/api/learnlog`, { maxRedirects: 0 })).status() >= 300);
	await anonymous.close();

	showNewsletters = true;
	cache.upsertLearnlogEntries(111, newsletters);
	const monthlyResponse = await page.goto(`${base}/manadsbrev`);
	assert.equal(monthlyResponse?.status(), 200);
	const monthlyHtml = await monthlyResponse!.text();
	assert.ok(monthlyHtml.includes('September.pdf'), 'attachment-only letters must render in SSR from existing cached JSON');
	assert.ok(monthlyHtml.includes('Information från förskolan'), 'match a monthly attachment filename even with a generic post title');
	assert.ok(!monthlyHtml.includes('Utflykt.pdf'), 'do not classify every PDF as a monthly letter');
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	assert.equal(await page.locator('h2').count(), 2);
	assert.equal(await page.getByRole('heading', { name: 'Bilagor' }).count(), 2);
	assert.equal(attachmentRequests.length, 0, 'viewing or syncing a monthly letter must not preload attachments');
	const pdfLink = page.getByRole('link', { name: 'September.pdf', exact: false });
	assert.equal(await pdfLink.getAttribute('target'), '_blank');
	assert.equal(await pdfLink.getAttribute('href'), '/media/20001');
	for (let attempt = 0; attempt < 2; attempt++) {
		const downloadedPdf = await context.request.get(`${base}/media/20001`);
		assert.equal(downloadedPdf.status(), 200);
		assert.equal(downloadedPdf.headers()['content-type'], 'application/pdf');
		assert.deepEqual(await downloadedPdf.body(), pdf);
	}
	assert.equal(attachmentRequests.length, 1, 'second PDF request must use the local disk cache');
	const otherDocument = await context.request.get(`${base}/media/20002`);
	assert.equal(otherDocument.status(), 200, 'non-PDF attachments use the same download path');
	assert.equal(await otherDocument.text(), 'synthetic document');
	assert.equal((await context.request.get(`${base}/media/999999`)).status(), 404);
	const anonymousFiles = await browser.newContext();
	assert.ok((await anonymousFiles.request.get(`${base}/media/20001`, { maxRedirects: 0 })).status() >= 300, 'cached PDFs must still require login');
	await anonymousFiles.close();
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long attachment filenames must not overflow on mobile');
	await page.screenshot({ path: '/tmp/dementor-manadsbrev-mobile.png' });
	await page.goto(`${base}/larLogg`);
	await page.getByRole('link', { name: 'September.pdf', exact: false }).waitFor();
	await page.getByRole('button', { name: 'Öppna foto', exact: true }).first().click();
	await page.waitForSelector('dialog[open] img');
	assert.equal(await page.locator('dialog[open] img').count(), 1, 'attachments must not become lightbox slides');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	showNewsletters = false;
	console.log('OK: monthly title/filename routing, named attachments in both feeds, PDF MIME/cache/auth and mobile layout');

	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const jobs = await server.ssrLoadModule('/src/lib/server/learnlog-jobs.ts');
	async function clearLearnlog() {
		await page.goto(`${base}/barn`);
		while (jobs.learnlogJobStatus(testJar).running) await page.waitForTimeout(20);
		db.exec('DELETE FROM learnlog_sync; DELETE FROM learnlog_entries;');
	}
	await clearLearnlog();
	showActivities = true;
	cache.upsertLearnlogEntries(111, activities);
	await page.setViewportSize({ width: 1100, height: 600 });
	const activityResponse = await page.goto(`${base}/larLogg`);
	const activityHtml = await activityResponse!.text();
	assert.equal((activityHtml.match(/<h2\b/g) ?? []).length, 3, 'SSR groups related posts within the first four raw entries');
	assert.ok(activityHtml.includes('2 sammanslagna inlägg'));
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	const downloadsBeforeGrouping = upstreamDownloads;
	await page.getByRole('button', { name: 'Visa fler inlägg' }).scrollIntoViewIfNeeded();
	await page.getByText('3 sammanslagna inlägg', { exact: true }).waitFor();
	assert.equal(await page.getByRole('heading', { name: 'Skogen', exact: true }).count(), 1, 'loading the next page must extend one card, not add a duplicate');
	const activityCard = page.locator('section > ul > li').filter({ has: page.getByRole('heading', { name: 'Skogen', exact: true }) });
	assert.equal(await activityCard.getByText('We explored the forest together.', { exact: true }).count(), 1);
	assert.equal(await activityCard.getByRole('button', { name: 'Öppna foto', exact: true }).count(), 10);
	assert.equal(await activityCard.getByRole('button', { name: 'Öppna video', exact: true }).count(), 1);
	assert.equal(await page.locator('video').count(), 0);
	assert.equal(upstreamDownloads, downloadsBeforeGrouping, 'grouping and pagination must not fetch full media');
	await activityCard.getByRole('button', { name: 'Öppna foto', exact: true }).first().click();
	await page.getByText('2 / 11', { exact: true }).waitFor();
	assert.equal(await page.locator('dialog[open] button[aria-label^="Media "]').count(), 11, 'all source posts share one gallery');
	await page.getByRole('button', { name: 'Föregående', exact: true }).click();
	await page.waitForSelector('dialog[open] video');
	await page.getByText('1 / 11', { exact: true }).waitFor();
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	assert.equal(await page.locator('video').count(), 0);
	await page.setViewportSize({ width: 390, height: 844 });
	await activityCard.scrollIntoViewIfNeeded();
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'grouped media must fit mobile');
	await page.screenshot({ path: '/tmp/dementor-learnlog-grouped-mobile.png', fullPage: true });
	showActivities = false;
	console.log('OK: grouped SSR, cross-page body/media merging, shared photo/video gallery and mobile layout');

	// A cold cache must publish the first pupil before a slow second pupil.
	await clearLearnlog();
	cache.upsertPupil(222, 'Second pupil');
	secondPupilDelay = 3500;
	learnlogRequests.length = 0;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/larLogg`);
	await page.waitForSelector('h2');
	assert.equal(await page.locator('h2').count(), 4);
	assert.ok(await page.getByRole('status').isVisible(), 'first four should render while the second pupil is still loading');
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	assert.equal(await page.locator('h2').count(), 4);
	assert.equal(await page.locator('video').count(), 0);
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile must not overflow horizontally');
	await page.screenshot({ path: '/tmp/dementor-learnlog-mobile.png' });
	await page.waitForTimeout(2000);
	assert.deepEqual(learnlogRequests, [{ page: 1, size: 4 }, { page: 1, size: 4 }], 'idle cold view must not fetch history');
	assert.ok(syncRequests.every((method) => method === 'POST'), 'there must be no status polling');
	cache.deletePupil(222);
	secondPupilDelay = 0;
	await page.getByRole('button', { name: 'Visa fler inlägg' }).scrollIntoViewIfNeeded();
	await page.waitForFunction(() => document.querySelectorAll('h2').length > 4);
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	assert.equal(learnlogRequests.filter((request) => request.size === 12).length, 1, 'first scroll fetches just one 12-post upstream page');
	await page.waitForTimeout(2000);
	assert.equal(learnlogRequests.filter((request) => request.size === 12).length, 1, 'history stops when the reader stops');
	repeatHistory = true;
	historyDelay = 150;
	await clearLearnlog();
	await page.goto(`${base}/larLogg`);
	// Deliberately ask for more until the upstream repeats its history page.
	for (let attempt = 0; attempt < 8; attempt++) {
		await page.waitForFunction(() => !document.querySelector('[role="status"]'));
		if (await page.getByText('Hämtningen av äldre inlägg är pausad.', { exact: false }).count()) break;
		await page.getByRole('button', { name: 'Visa fler inlägg' }).click();
	}
	await page.getByText('Hämtningen av äldre inlägg är pausad.', { exact: false }).waitFor();
	assert.ok(await page.getByRole('button', { name: 'Visa fler inlägg' }).isVisible());
	assert.equal(await page.getByText('Synk misslyckades:', { exact: false }).count(), 0);
	assert.ok(await page.locator('h2').count() > 0, 'paused history must keep the feed visible');
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	cache.upsertLearnlogEntries(111, [{ ...entries[0], id: 8999, title: 'MOV with EOF metadata', media: [{ ...entries[0].media[0], fileId: 88888, fileUrl: '/Resources/Resource/Download/88888', thumbnailUrl: '' }] }]);
	await page.goto(`${base}/larLogg`);
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.waitForFunction(() => {
		const video = document.querySelector('dialog[open] video');
		return video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth === 32;
	});
	assert.ok(largeVideoBytes <= 3 * 1024 * 1024, `EOF-metadata MOV must decode without a full download (received ${largeVideoBytes})`);
	assert.equal(cache.getCachedMedia(88888), null, 'partial video ranges must not masquerade as a full cache file');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	console.log('OK: real MOV with EOF metadata decodes using bounded head/tail requests');
	// Codec support differs across OS/browser versions. Force one original
	// source failure, then repair a real ProRes/PCM file and decode its MP4.
	await page.route('**/media/88884?original=1', (route) => route.fulfill({ status: 200, contentType: 'video/quicktime', body: 'unsupported video source' }), { times: 1 });
	cache.upsertLearnlogEntries(111, [{ ...entries[0], id: 8999, title: 'Needs playback repair', media: [{ ...entries[0].media[0], fileId: 88884, fileUrl: '/Resources/Resource/Download/88884', thumbnailUrl: '' }] }]);
	await page.goto(`${base}/larLogg`);
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.waitForFunction(() => {
		const video = document.querySelector('dialog[open] video');
		return video instanceof HTMLVideoElement && video.src.includes('compatible=1') && video.readyState >= 2 && video.videoWidth === 32;
	});
	assert.equal(await page.getByRole('link', { name: 'Hämta originalvideon' }).count(), 0, 'a repairable codec must play inline, not just offer a download');
	assert.ok(mediaRequests.some((url) => url.includes('/media/88884?compatible=1')));
	const compatible = await context.request.get(`${base}/media/88884?compatible=1`, { headers: { Range: 'bytes=0-1' } });
	assert.equal(compatible.status(), 206);
	assert.equal(compatible.headers()['content-type'], 'video/mp4');
	const anonymousRepair = await browser.newContext();
	assert.ok((await anonymousRepair.request.get(`${base}/media/88884?playback=1`, { maxRedirects: 0 })).status() >= 300, 'cached repaired videos still require login');
	await anonymousRepair.close();
	const original = await context.request.get(`${base}/media/88884`);
	assert.deepEqual(await original.body(), incompatibleMov, 'the original download stays untouched');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	const requestsBeforeReopen = upstreamDownloads;
	const repairedPath = join(directory, 'media', '88884.compatible-v1.mp4');
	const repairedBeforeReopen = (await stat(repairedPath)).mtimeMs;
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('dialog[open] video')?.readyState === 4);
	assert.equal(upstreamDownloads, requestsBeforeReopen, 'reopening uses the cached MP4 without another download');
	assert.ok((await page.locator('dialog[open] video').getAttribute('src'))?.includes('compatible=1'), 'playback selects the repaired copy directly');
	assert.equal((await stat(repairedPath)).mtimeMs, repairedBeforeReopen, 'reopening must not run conversion again');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	console.log('OK: original playback failure triggers ProRes/PCM repair, plays MP4 inline, reuses cache, and preserves original');
	// page.route disables HTTP caching. Use a fresh context with NO routing so
	// cached original byte ranges cannot hide bugs in post-conversion reopening.
	const cacheContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
	await cacheContext.addCookies([{ name: 'session', value: 'browser-test', url: base }]);
	const cachePage = await cacheContext.newPage();
	cachePage.on('pageerror', (err) => errors.push(err.message));
	cache.upsertLearnlogEntries(111, [{ ...entries[0], id: 8999, title: 'Cache-safe reopening', media: [{ ...entries[0].media[0], fileId: 88904, fileUrl: '/Resources/Resource/Download/88904', thumbnailUrl: '' }] }]);
	const selectionUrl = `${base}/api/media/88904/playback`;
	const originalSelection = await cacheContext.request.get(selectionUrl);
	assert.deepEqual(await originalSelection.json(), { variant: 'original' });
	assert.match(originalSelection.headers()['cache-control'], /no-store/);
	assert.equal((await cacheContext.request.get(`${base}/api/media/invalid/playback`)).status(), 400);
	assert.equal((await cacheContext.request.get(`${base}/api/media/999999/playback`)).status(), 404);
	const anonymousSelection = await browser.newContext();
	assert.ok((await anonymousSelection.request.get(selectionUrl, { maxRedirects: 0 })).status() >= 300, 'selection must require login even for a cached video');
	await anonymousSelection.close();
	const beforeAlias = await cacheContext.request.get(`${base}/media/88904?playback=1`, { maxRedirects: 0 });
	assert.equal(beforeAlias.status(), 307);
	assert.equal(beforeAlias.headers().location, '/media/88904?original=1');
	assert.match(beforeAlias.headers()['cache-control'], /no-store/);
	await cachePage.goto(`${base}/larLogg`);
	await cachePage.waitForFunction(() => !document.querySelector('[role="status"]'));
	await cachePage.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await cachePage.waitForFunction(() => {
		const video = document.querySelector<HTMLVideoElement>('dialog[open] video');
		return video && video.readyState >= 2 && video.currentSrc.endsWith('?original=1');
	});
	// Browser/OS codec support varies. Inject a decode failure without request
	// interception; original 206 responses remain in the real browser cache.
	await cachePage.locator('dialog[open] video').evaluate((video) => {
		Object.defineProperty(video, 'error', { value: { code: 4 }, configurable: true });
		video.dispatchEvent(new Event('error'));
	});
	await cachePage.waitForFunction(() => {
		const video = document.querySelector<HTMLVideoElement>('dialog[open] video');
		return video && video.readyState >= 2 && video.currentSrc.endsWith('?compatible=1');
	});
	const repairedSelection = await cacheContext.request.get(selectionUrl);
	assert.deepEqual(await repairedSelection.json(), { variant: 'compatible' });
	assert.match(repairedSelection.headers()['cache-control'], /no-store/);
	const afterAlias = await cacheContext.request.get(`${base}/media/88904?playback=1`, { maxRedirects: 0 });
	assert.equal(afterAlias.status(), 307);
	assert.equal(afterAlias.headers().location, '/media/88904?compatible=1');
	assert.match(afterAlias.headers()['cache-control'], /no-store/);
	await cachePage.getByRole('button', { name: 'Stäng ✕' }).click();
	const downloadsAfterRepair = upstreamDownloads;
	const repairedCachePath = join(directory, 'media', '88904.compatible-v1.mp4');
	const mtimeAfterRepair = (await stat(repairedCachePath)).mtimeMs;
	for (const navigate of [false, true]) {
		if (navigate) {
			await cachePage.goto(`${base}/barn`);
			await cachePage.goto(`${base}/larLogg`);
			await cachePage.waitForFunction(() => !document.querySelector('[role="status"]'));
		}
		await cachePage.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
		await cachePage.waitForFunction(() => {
			const video = document.querySelector<HTMLVideoElement>('dialog[open] video');
			return video && video.readyState >= 2 && video.currentSrc.endsWith('?compatible=1');
		});
		assert.equal(await cachePage.getByText('Anpassar videon för uppspelning…', { exact: false }).count(), 0);
		assert.equal(upstreamDownloads, downloadsAfterRepair, 'reopening must not download from InfoMentor');
		assert.equal((await stat(repairedCachePath)).mtimeMs, mtimeAfterRepair, 'reopening must not reconvert');
		await cachePage.getByRole('button', { name: 'Stäng ✕' }).click();
	}
	const originalAfterRepair = await cacheContext.request.get(`${base}/media/88904?original=1`, { headers: { Range: 'bytes=0-31' } });
	assert.equal(originalAfterRepair.headers()['content-type'], 'video/quicktime');
	assert.deepEqual(await originalAfterRepair.body(), largeMov.subarray(0, 32), 'the original URL never switches to MP4 bytes');
	await cacheContext.close();
	console.log('OK: real browser cache enabled, distinct original/MP4 URLs, reopened and navigated playback without download or conversion');
	const uncachedVideo = { ...entries[0], id: 9000, title: 'Uncached MOV', media: [{ ...entries[0].media[0], fileId: 80000, fileUrl: '/Resources/Resource/Download/80000', thumbnailUrl: '/Resources/Resource/Thumbnail/80000' }] };
	cache.upsertLearnlogEntries(111, [uncachedVideo]);
	await page.goto(`${base}/larLogg`);
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	expiredUpstream = true;
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.getByRole('alertdialog').waitFor();
	assert.equal(await page.locator('dialog[open]').count(), 0, 'close media so the reauth prompt is reachable');
	const afterExpiry = upstreamRequests;
	await Promise.all([80000, 10052, 10048].map((id) => context.request.get(`${base}/media/${id}`)));
	assert.equal(upstreamRequests, afterExpiry, 'confirmed expiry must stop queued/new upstream requests');
	assert.equal((await context.request.get(`${base}/api/session`)).status(), 200);
	expiredUpstream = false;
	await page.route('**/api/reauth', async (route) => {
		// Exercise the UI without sending any credentials to InfoMentor.
		sessions.attachSession('browser-test', { username: 'synthetic', cookieJar: cookies.createCookieJar(), loggedInAt: new Date(), lastUsedAt: new Date() });
		await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
	});
	await page.getByLabel('Lösenord', { exact: true }).fill('synthetic-password');
	await page.getByRole('button', { name: 'Logga in', exact: true }).click();
	await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.getByRole('link', { name: 'Hämta originalvideon' }).waitFor();
	assert.equal(await page.getByRole('alertdialog').count(), 0, 'a decode failure must not imply session expiry');
	assert.equal(await page.getByRole('link', { name: 'Hämta originalvideon' }).getAttribute('href'), '/media/80000');
	await page.getByRole('button', { name: 'Stäng ✕' }).click();
	assert.deepEqual(errors, []);
	console.log('OK: progressive streaming without polls, bounded scroll history, media expiry/reauth, decode fallback, video lifecycle, routes and mobile layout');
} finally {
	await browser?.close();
	// Wait for any bounded synthetic sync job to finish before closing its database.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	db.close();
	await server.close();
	globalThis.fetch = realFetch;
	await rm(directory, { recursive: true, force: true });
}
