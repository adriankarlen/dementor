import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import { MEDIA_DIR } from './db.ts';
import { ensureMedia, MAX_MEDIA_BYTES } from './media.ts';
import type { LearnlogMedia } from './infomentor/api.ts';
import type { CookieJar } from './infomentor/cookieJar.ts';

const Probe = type({
	streams: type({
		index: 'number.integer >= 0',
		codec_type: 'string',
		'codec_name?': 'string',
		'pix_fmt?': 'string'
	}).array(),
	format: { duration: 'string' }
});

export class VideoToolsUnavailableError extends Error {
	constructor() {
		super('Video repair requires FFmpeg and FFprobe on the server');
	}
}

function tool(executable: string, args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{ timeout, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', windowsHide: true },
			(err, stdout) => {
				if (!err) resolve(stdout);
				else if (err.code === 'ENOENT') reject(new VideoToolsUnavailableError());
				// Do not log stderr: it can include metadata from the original file.
				else
					reject(
						new Error(
							'Video inspection or conversion failed (invalid file, unsupported codec or time limit)'
						)
					);
			}
		);
	});
}

async function probe(path: string) {
	const output = await tool(
		process.env.FFPROBE_PATH ?? 'ffprobe',
		[
			'-v',
			'error',
			'-protocol_whitelist',
			'file',
			'-format_whitelist',
			'mov,matroska,webm,avi,asf',
			'-show_entries',
			'stream=index,codec_type,codec_name,pix_fmt:format=duration',
			'-of',
			'json',
			path
		],
		15_000
	);
	return Probe.assert(JSON.parse(output));
}

export function compatibleVideoPath(fileId: number): string {
	return join(MEDIA_DIR, `${fileId}.compatible-v1.mp4`);
}

export async function cachedCompatibleVideo(fileId: number): Promise<string | null> {
	const path = compatibleVideoPath(fileId);
	const info = await stat(path).catch(() => null);
	return info?.isFile() && info.size > 0 ? path : null;
}

const pending = new WeakMap<CookieJar, Map<number, Promise<string>>>();
const failures = new WeakMap<CookieJar, Map<number, number>>();
// Only one CPU-heavy conversion at a time across both parents. Original file
// downloads use the existing per-session queue, not this CPU queue.
let tail = Promise.resolve();

/** Explicit playback repair only. Originals and their range caches stay intact. */
export async function ensureCompatibleVideo(
	jar: CookieJar,
	media: LearnlogMedia,
	pupil: number,
	entryId: number,
	isActive: () => boolean
): Promise<string> {
	const cached = await cachedCompatibleVideo(media.fileId);
	if (cached) return cached;
	const jobs = pending.get(jar) ?? new Map<number, Promise<string>>();
	pending.set(jar, jobs);
	const existing = jobs.get(media.fileId);
	if (existing) return existing;
	const failed = failures.get(jar) ?? new Map<number, number>();
	failures.set(jar, failed);
	if ((failed.get(media.fileId) ?? 0) > Date.now())
		throw new Error('Video repair failed recently; retry later');
	const active = () => {
		if (!isActive()) throw new DOMException('Session replaced', 'AbortError');
	};
	const task = (async () => {
		active();
		// Check availability before downloading a large original unnecessarily.
		await tool(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version'], 5000);
		await tool(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version'], 5000);
		const original = await ensureMedia(jar, media, pupil, entryId, false, isActive);
		const work = tail.then(async () => {
			active();
			const alreadyConverted = await cachedCompatibleVideo(media.fileId);
			if (alreadyConverted) return alreadyConverted;
			return convert(original, media.fileId);
		});
		tail = work.then(
			() => {},
			() => {}
		);
		return work;
	})();
	jobs.set(media.fileId, task);
	try {
		return await task;
	} catch (err) {
		// A new login has a new jar and is never held back by an old failure.
		failed.set(media.fileId, Date.now() + 60_000);
		console.warn(
			`[dementor] video ${media.fileId}: ${err instanceof VideoToolsUnavailableError ? err.message : 'playback repair failed'}`
		);
		throw err;
	} finally {
		jobs.delete(media.fileId);
	}
}

async function convert(original: string, fileId: number): Promise<string> {
	const source = await probe(original);
	const video = source.streams.find((stream) => stream.codec_type === 'video');
	if (!video) throw new Error('Original contains no video stream');
	const duration = Number(source.format.duration);
	if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration');
	// Prefer the standard audio track over auxiliary/spatial Apple audio.
	const audio =
		source.streams.find((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac') ??
		source.streams.find((stream) => stream.codec_type === 'audio');
	const copyVideo = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p';
	console.info(
		`[dementor] video ${fileId}: preparing MP4 from ${video.codec_name ?? 'unknown'}/${video.pix_fmt ?? 'unknown'}, audio=${audio?.codec_name ?? 'none'}`
	);
	const path = compatibleVideoPath(fileId);
	const temp = `${path}.${randomUUID()}.tmp`;
	const args = [
		'-v',
		'error',
		'-nostdin',
		'-y',
		'-protocol_whitelist',
		'file',
		'-format_whitelist',
		'mov,matroska,webm,avi,asf',
		'-i',
		original,
		'-map',
		`0:${video.index}`,
		'-map_metadata',
		'-1',
		'-map_chapters',
		'-1'
	];
	if (copyVideo) args.push('-c:v', 'copy');
	else
		args.push(
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			'-crf',
			'22',
			'-pix_fmt',
			'yuv420p',
			'-threads',
			'2',
			'-vf',
			"scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
		);
	if (audio) {
		args.push('-map', `0:${audio.index}`);
		if (audio.codec_name === 'aac') args.push('-c:a', 'copy');
		else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k');
	} else args.push('-an');
	args.push('-movflags', '+faststart', '-fs', String(MAX_MEDIA_BYTES), '-f', 'mp4', temp);
	try {
		const began = performance.now();
		await tool(process.env.FFMPEG_PATH ?? 'ffmpeg', args, 180_000);
		const info = await stat(temp);
		if (info.size === 0 || info.size >= MAX_MEDIA_BYTES)
			throw new Error('Converted video exceeds size limit');
		const output = await probe(temp);
		const outputVideo = output.streams.find((stream) => stream.codec_type === 'video');
		const outputDuration = Number(output.format.duration);
		if (
			outputVideo?.codec_name !== 'h264' ||
			outputVideo.pix_fmt !== 'yuv420p' ||
			!Number.isFinite(outputDuration) ||
			Math.abs(outputDuration - duration) > Math.max(0.5, duration * 0.01)
		)
			throw new Error('Converted video failed validation or was truncated');
		await chmod(temp, 0o600);
		await rename(temp, path);
		console.info(
			`[dementor] video ${fileId}: compatible MP4 ${copyVideo ? 'remuxed' : 'encoded'} in ${Math.round(performance.now() - began)} ms`
		);
		return path;
	} finally {
		await rm(temp, { force: true });
	}
}
