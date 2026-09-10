#!/usr/bin/env node
// Requires FFmpeg + FFprobe. Synthetic media only; originals are never changed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'dementor-compatible-'));
process.env.DATABASE_PATH = join(directory, 'cache.sqlite');
process.env.MEDIA_DIR = join(directory, 'media');
const { db } = await import('../src/lib/server/db.ts');
const { createCookieJar } = await import('../src/lib/server/infomentor/cookieJar.ts');
const { localMediaPath } = await import('../src/lib/server/media.ts');
const { ensureCompatibleVideo, cachedCompatibleVideo, compatibleVideoPath, VideoToolsUnavailableError } = await import('../src/lib/server/video-compatible.ts');
const { fileResponse } = await import('../src/lib/server/file-response.ts');
const realFetch = globalThis.fetch;
const oldFfmpeg = process.env.FFMPEG_PATH;
globalThis.fetch = async () => { throw new Error('these cached fixtures need no upstream request'); };
function media(fileId: number) {
	return { fileId, fileType: 'Video', fileExtension: 'mov', fileUrl: `/Resources/Resource/Download/${fileId}`, thumbnailUrl: '' };
}
async function inspect(path: string) {
	const { stdout } = await exec(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,pix_fmt,width,height', '-of', 'json', path]);
	return JSON.parse(stdout) as { streams: { codec_name: string; codec_type: string; pix_fmt?: string; width?: number; height?: number }[] };
}
function atoms(bytes: Buffer) {
	const names: string[] = [];
	for (let offset = 0; offset + 8 <= bytes.length;) {
		const size = bytes.readUInt32BE(offset);
		names.push(bytes.toString('ascii', offset + 4, offset + 8));
		assert.ok(size >= 8);
		offset += size;
	}
	return names;
}
try {
	const jar = createCookieJar();
	for (const [id, fixture] of [[1, 'black-h264-tail.mov'], [2, 'black-h264-444-pcm.mov']] as const) {
		const original = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url));
		const originalPath = localMediaPath(id, 'mov');
		await writeFile(originalPath, original);
		const [first, second] = await Promise.all([
			ensureCompatibleVideo(jar, media(id), 111, 1000, () => true),
			ensureCompatibleVideo(jar, media(id), 111, 1000, () => true)
		]);
		assert.equal(first, second);
		assert.equal(first, compatibleVideoPath(id));
		assert.deepEqual(await readFile(originalPath), original, 'repair must not modify the original');
		const output = await inspect(first);
		const video = output.streams.find((stream) => stream.codec_type === 'video')!;
		assert.equal(video.codec_name, 'h264');
		assert.equal(video.pix_fmt, 'yuv420p');
		assert.equal(video.width, 32, 'never upscale a small source');
		assert.equal(video.height, 32);
		assert.ok(output.streams.filter((stream) => stream.codec_type === 'audio').every((stream) => stream.codec_name === 'aac'));
		assert.equal(output.streams.length, id === 1 ? 1 : 2, 'keep only the selected video and standard audio');
		const topAtoms = atoms(await readFile(first));
		assert.ok(topAtoms.indexOf('moov') < topAtoms.indexOf('mdat'), 'MP4 metadata must be at the front');
		const range = await fileResponse(first, 'video/mp4', new Request('http://localhost/media/1?compatible=1', { headers: { Range: 'bytes=0-1' } }));
		assert.equal(range.status, 206);
		assert.equal(range.headers.get('content-type'), 'video/mp4');
		assert.equal((await range.arrayBuffer()).byteLength, 2);
		const cachedBytes = await readFile(first);
		// Cached repair should work for another parent even without converter tools.
		process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';
		assert.equal(await ensureCompatibleVideo(createCookieJar(), media(id), 111, 1000, () => true), first);
		assert.deepEqual(await readFile(first), cachedBytes);
		if (oldFfmpeg === undefined) delete process.env.FFMPEG_PATH;
		else process.env.FFMPEG_PATH = oldFfmpeg;
	}
	await writeFile(localMediaPath(3, 'mov'), 'not a movie');
	await assert.rejects(ensureCompatibleVideo(jar, media(3), 111, 1000, () => true), /inspection or conversion/);
	assert.equal(await cachedCompatibleVideo(3), null);
	assert.ok(!(await readdir(join(directory, 'media'))).some((name) => name.endsWith('.tmp')), 'failed conversions leave no temporary/published MP4');
	process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';
	await assert.rejects(ensureCompatibleVideo(jar, media(4), 111, 1000, () => true), VideoToolsUnavailableError);
	console.log('OK: MP4 remux and H.264/AAC conversion, fast-start, original preservation, deduplication, reusable disk cache, ranges and failure cleanup');
} finally {
	if (oldFfmpeg === undefined) delete process.env.FFMPEG_PATH;
	else process.env.FFMPEG_PATH = oldFfmpeg;
	globalThis.fetch = realFetch;
	db.close();
	await rm(directory, { recursive: true, force: true });
}
