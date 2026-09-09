#!/usr/bin/env node
// Browser + route regression test with synthetic data and a disposable cache.
// pnpm exec playwright install chromium
// node tools/check-learnlog-browser.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const directory = await mkdtemp(join(tmpdir(), 'dementor-browser-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const realFetch = globalThis.fetch;
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
let upstreamDownloads = 0;
let historyDelay = 150;
const thumbnailRequests = new Map<number, number>();
let repeatHistory = false;
const repeatedBatch = Array.from({ length: 25 }, (_, i) => ({ ...entries[0], id: 1000 + i }));
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== 'hub.infomentor.se') return realFetch(input, init);
	if (url.pathname.includes('SwitchPupil')) return new Response('<html>Hub</html>');
	if (url.pathname.includes('getlearnlogs')) {
		const size = Number(url.searchParams.get('pageSize'));
		await new Promise((resolve) => setTimeout(resolve, size === 4 ? 150 : historyDelay));
		const page = Number(url.searchParams.get('pageNumber'));
		if (repeatHistory) return Response.json(size === 4 ? repeatedBatch.slice(0, 4) : repeatedBatch);
		return Response.json(entries.slice((page - 1) * size, page * size));
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
		return new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } });
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
	sessions.attachSession('browser-test', { username: 'synthetic', cookieJar: cookies.createCookieJar(), loggedInAt: new Date(), lastUsedAt: new Date() });
	await server.listen();
	const address = server.httpServer!.address();
	assert.ok(address && typeof address !== 'string');
	const base = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
	const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
	await context.addCookies([{ name: 'session', value: 'browser-test', url: base }]);
	const page = await context.newPage();
	const errors: string[] = [];
	const mediaRequests: string[] = [];
	page.on('pageerror', (err) => errors.push(err.message));
	page.on('request', (request) => { if (request.url().includes('/media/')) mediaRequests.push(request.url()); });
	const response = await page.goto(`${base}/larLogg`);
	assert.equal(response?.status(), 200);
	const html = await response!.text();
	assert.equal((html.match(/<h2\b/g) ?? []).length, 4, 'SSR should contain just four cards');
	assert.ok(!html.includes('<video'), 'SSR should not preload videos');
	await page.waitForFunction(() => document.querySelector('h2')?.textContent?.includes('Test post 1'));
	await page.waitForTimeout(1800);
	assert.equal(await page.locator('h2').count(), 4, 'sync should update the first page without rendering all rows');
	assert.equal(await page.locator('video').count(), 0);
	assert.ok(mediaRequests.every((url) => url.includes('thumbnail=1')));
	assert.equal(upstreamDownloads, 0, 'scroll previews and sync must not fetch full files');
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
	assert.equal(upstreamDownloads, 0, 'a placeholder must not fetch a full video');
	const missingPhoto = await context.request.get(`${base}/media/${entries[13].media[1].fileId}?thumbnail=1`);
	assert.equal(missingPhoto.status(), 503, 'do not hide an unrelated photo failure behind a video placeholder');
	await page.screenshot({ path: '/tmp/dementor-learnlog-desktop.png', fullPage: false });

	await page.getByRole('button', { name: 'Visa fler inlägg' }).scrollIntoViewIfNeeded();
	await page.waitForFunction(() => document.querySelectorAll('h2').length > 4);
	assert.ok(await page.locator('h2').count() <= 8);
	await page.getByRole('button', { name: 'Öppna video', exact: true }).first().click();
	await page.waitForSelector('dialog[open] video');
	assert.equal(await page.locator('video').count(), 1, 'only the selected full video may mount');
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

	// A genuinely cold cache must show the first four before slow history finishes.
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	db.exec('DELETE FROM learnlog_sync; DELETE FROM learnlog_entries;');
	historyDelay = 3500;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/larLogg`);
	await page.waitForSelector('h2');
	assert.equal(await page.locator('h2').count(), 4);
	assert.ok(await page.getByRole('status').isVisible(), 'first four should render while history is still loading');
	await page.waitForFunction(() => !document.querySelector('[role="status"]'));
	assert.equal(await page.locator('h2').count(), 4);
	assert.equal(await page.locator('video').count(), 0);
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile must not overflow horizontally');
	await page.screenshot({ path: '/tmp/dementor-learnlog-mobile.png' });
	repeatHistory = true;
	historyDelay = 150;
	db.exec('DELETE FROM learnlog_sync; DELETE FROM learnlog_entries;');
	await page.goto(`${base}/larLogg`);
	await page.getByText('InfoMentor upprepade en sida.', { exact: false }).waitFor();
	assert.ok(await page.getByRole('button', { name: 'Hämta äldre inlägg' }).isVisible());
	assert.equal(await page.getByText('Synk misslyckades:', { exact: false }).count(), 0);
	assert.ok(await page.locator('h2').count() > 0, 'paused history must keep the feed visible');
	assert.deepEqual(errors, []);
	console.log('OK: SSR four cards, progressive refresh, scroll loading, video fallback/backoff, video lifecycle, media repair, range routes, auth, paused history and mobile layout');
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
