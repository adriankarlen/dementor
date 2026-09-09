// Media is downloaded only when a thumbnail becomes visible or a full
// item is opened. Syncing post metadata never waits for these bytes.
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_DIR } from './db.ts';
import { createSession } from './infomentor/httpClient.ts';
import type { CookieJar } from './infomentor/cookieJar.ts';
import {
	getCommunicationAppData,
	switchPupil,
	type LearnlogEntry,
	type LearnlogMedia
} from './infomentor/api.ts';
import { isLoginPage, isRelayPage } from './infomentor/htmlForms.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import { withInfoMentorSession } from './infomentor/queue.ts';
import { upsertMedia } from './cache.ts';
import { EmptyDownloadError, saveDownload } from './download.ts';

export class ThumbnailUnavailableError extends Error {}

// Full videos are fetched on explicit open, streamed to disk, not buffered.
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

function sanitizeExtension(raw: string): string {
	const extension = raw.trim().replace(/^\./, '').toLowerCase();
	return /^[a-z0-9]{1,10}$/.test(extension) ? extension : 'bin';
}

export function contentTypeForFileExtension(extension: string, fileType?: string | null): string {
	switch (sanitizeExtension(extension)) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'heic':
			return 'image/heic';
		case 'bmp':
			return 'image/bmp';
		case 'mp4':
			return 'video/mp4';
		case 'mov':
		case 'qt':
			return 'video/quicktime';
		case 'webm':
			return 'video/webm';
		case 'm4v':
			return 'video/x-m4v';
		case '3gp':
			return 'video/3gpp';
		case 'avi':
			return 'video/x-msvideo';
		case 'wmv':
			return 'video/x-ms-wmv';
		case 'mkv':
			return 'video/x-matroska';
		case 'pdf':
			return 'application/pdf';
		default:
			return fileType?.toLowerCase() === 'image' ? 'image/jpeg' : 'application/octet-stream';
	}
}

export function localMediaPath(fileId: number, extension: string): string {
	return join(MEDIA_DIR, `${fileId}.${sanitizeExtension(extension)}`);
}

export function localThumbnailPath(fileId: number): string {
	return join(MEDIA_DIR, `${fileId}.thumbnail`);
}

async function nonEmptySize(path: string): Promise<number> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : 0;
	} catch {
		return 0;
	}
}

/** Thumbnail MIME follows the bytes, not the full video's .mov extension. */
export async function thumbnailContentType(path: string): Promise<string> {
	const file = await open(path, 'r');
	try {
		const header = Buffer.alloc(12);
		await file.read(header, 0, header.length, 0);
		if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
		if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
			return 'image/png';
		if (header.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
		if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
			return 'image/webp';
		throw new ThumbnailUnavailableError('unsupported thumbnail response');
	} finally {
		await file.close();
	}
}

// A denial of one resource does not prove the whole InfoMentor session died.
// This probe runs inside the existing per-jar lock; it must not acquire it again.
async function confirmMediaSession(jar: CookieJar): Promise<void> {
	try {
		await getCommunicationAppData(jar);
	} catch (err) {
		if (err instanceof InfoMentorSessionExpiredError) throw err;
		// An inconclusive probe (5xx/network/invalid JSON) is not evidence of
		// expiry. The caller still reports the original media failure.
	}
}

async function validateMediaBody(
	path: string,
	thumbnail: boolean,
	contentType: string
): Promise<void> {
	const file = await open(path, 'r');
	let text: string;
	try {
		// Bounded prefix only, even for large full-resolution files. Recognize
		// login/relay responses even when their MIME header is missing or wrong.
		const prefix = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
		text = prefix.toString('utf8', 0, bytesRead);
	} finally {
		await file.close();
	}
	if (isLoginPage(text) || isRelayPage(text)) throw new InfoMentorSessionExpiredError();
	if (thumbnail) {
		// Serve our own MIME based on the signature, not InfoMentor's label.
		// Invalid/HTML/JSON bodies still fail here before the atomic rename.
		await thumbnailContentType(path);
	} else if (
		contentType.includes('html') ||
		contentType.includes('json') ||
		/^\s*(?:<!doctype html|<html\b)/i.test(text)
	) {
		throw new Error('unexpected media response body');
	}
}

// Deduplicate concurrent requests and back off on empty/failed upstream files.
// Per jar: one parent's auth failure must not prevent another parent's retry.
const pending = new WeakMap<CookieJar, Map<string, Promise<string>>>();
interface FailedMedia {
	retryAt: number;
	thumbnailUnavailable: boolean;
}
const failures = new WeakMap<CookieJar, Map<string, FailedMedia>>();

export async function ensureMedia(
	jar: CookieJar,
	media: LearnlogMedia,
	pupilSwitchId: number,
	entryId: number,
	thumbnail = false,
	isActive: () => boolean = () => true
): Promise<string> {
	const path = thumbnail
		? localThumbnailPath(media.fileId)
		: localMediaPath(media.fileId, media.fileExtension);
	const size = await nonEmptySize(path);
	if (size > 0) return path;
	const key = `${media.fileId}:${thumbnail}`;
	const active = pending.get(jar) ?? new Map<string, Promise<string>>();
	pending.set(jar, active);
	const existing = active.get(key);
	if (existing) return existing;
	const retryAfter = failures.get(jar) ?? new Map<string, FailedMedia>();
	failures.set(jar, retryAfter);
	const failure = retryAfter.get(key);
	if (failure && failure.retryAt > Date.now()) {
		if (failure.thumbnailUnavailable)
			throw new ThumbnailUnavailableError('thumbnail unavailable; retry later');
		throw new Error('media unavailable; retry later');
	}

	let responseInfo = '';
	const task = withInfoMentorSession(jar, async () => {
		if (!isActive()) throw new InfoMentorSessionExpiredError();
		// Another parent may have finished downloading while this request waited.
		if ((await nonEmptySize(path)) > 0) return path;
		const relative = thumbnail ? media.thumbnailUrl : media.fileUrl;
		if (!relative) {
			if (thumbnail) throw new ThumbnailUnavailableError('no thumbnail available');
			throw new Error('no media URL available');
		}
		const url = new URL(relative, 'https://hub.infomentor.se/');
		if (url.origin !== 'https://hub.infomentor.se') throw new Error('invalid media origin');
		try {
			await switchPupil(jar, pupilSwitchId);
		} catch (err) {
			if (!(err instanceof InfoMentorSessionExpiredError)) throw err;
			await confirmMediaSession(jar);
			throw new Error('media pupil unavailable; session expiry not confirmed');
		}
		// Keep the thumbnail URL exactly as supplied. Arbitrary sizes return empty 200s.
		const response = await createSession(jar).request(url.href, {
			signal: AbortSignal.timeout(120_000)
		});
		const type = response.headers.get('content-type')?.toLowerCase() ?? '';
		// Structural diagnostics only: no upstream URL, cookies or response body.
		responseInfo = `${thumbnail ? 'thumbnail' : 'full'} HTTP ${response.status} content-type=${JSON.stringify(type.slice(0, 100) || 'missing')} content-length=${JSON.stringify(response.headers.get('content-length')?.slice(0, 30) ?? 'missing')}`;
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			await confirmMediaSession(jar);
			throw new Error('media access denied; session expiry not confirmed');
		}
		const bytes = await saveDownload(
			response,
			path,
			thumbnail ? MAX_THUMBNAIL_BYTES : MAX_MEDIA_BYTES,
			async (temp) => {
				responseInfo += ` received-bytes=${(await stat(temp)).size}`;
				await validateMediaBody(temp, thumbnail, type);
			}
		).catch((err) => {
			if (thumbnail && err instanceof EmptyDownloadError)
				throw new ThumbnailUnavailableError(err.message);
			throw err;
		});
		if (!thumbnail) upsertMedia(media, bytes, pupilSwitchId, entryId);
		return path;
	});
	active.set(key, task);
	try {
		return await task;
	} catch (err) {
		const unavailable = err instanceof ThumbnailUnavailableError;
		if (!(err instanceof InfoMentorSessionExpiredError)) {
			retryAfter.set(key, {
				retryAt: Date.now() + (unavailable ? 3_600_000 : 60_000),
				thumbnailUnavailable: unavailable
			});
		}
		// Missing video posters are an expected fallback, not a sync failure.
		if (!(thumbnail && media.fileType.toLowerCase() === 'video' && unavailable)) {
			console.warn(
				`[dementor] media ${media.fileId}: ${responseInfo ? responseInfo + ' — ' : ''}${err instanceof Error ? err.message : 'download failed'}`
			);
		}
		throw err;
	} finally {
		active.delete(key);
	}
}

// Kept for manual cache-warming tools. Normal page sync does not call this.
export async function cacheMediaForEntries(
	jar: CookieJar,
	cachedFileIds: Set<number>,
	entries: { pupilSwitchId: number; entry: LearnlogEntry }[]
): Promise<{ attempted: number; downloaded: number; cached: number; failed: number }> {
	const totals = { attempted: 0, downloaded: 0, cached: 0, failed: 0 };
	for (const { pupilSwitchId, entry } of entries) {
		for (const media of entry.media) {
			if ((await nonEmptySize(localMediaPath(media.fileId, media.fileExtension))) > 0) {
				totals.cached++;
				continue;
			}
			totals.attempted++;
			try {
				await ensureMedia(jar, media, pupilSwitchId, entry.id);
				cachedFileIds.add(media.fileId);
				totals.downloaded++;
			} catch (err) {
				if (err instanceof InfoMentorSessionExpiredError) throw err;
				totals.failed++;
			}
		}
	}
	return totals;
}
