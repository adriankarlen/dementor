// Phase 4 media caching: walk the media array of freshly-synced
// Lärlogg entries and download any not-yet-cached files to disk.
//
// Design notes (cross-ref docs/implementation-plan.md "Phase 4"):
//   - Bytes come from `fileUrl` (the full-resolution file, not the
//     pre-generated thumbnail — see docs/api-notes.md on the
//     "thumbnail endpoint only serves pre-generated sizes" footgun).
//     Serving the full file locally avoids that whole class of bug
//     and still gives us the "loads fast on a phone" property the
//     cache exists for without us having to know which thumbnail
//     size InfoMentor happens to have pre-rendered.
//   - `thumbnailUrl`/`fileUrl` are NEVER rewritten — per the
//     confirmed hard constraint in docs/api-notes.md.
//   - The on-disk filename is `MEDIA_DIR/<fileId>.<fileExtension>`,
//     so the SvelteKit route can serve any fileId straight off the
//     disk without a separate lookup. The `media` table adds the
//     provenance (pupil/entry) and content-length metadata that
//     looking at the bare file on disk can't tell you.
//   - Per-file-id idempotent: re-syncing the same id is a no-op
//     (`upsertMedia` updates the timestamp but the bytes are
//     unchanged). The `shouldDownload` short-circuit means we don't
//     even hit InfoMentor for known caches.
//   - Per-file failures are LOGGED, not thrown — one bad media file
//     shouldn't fail the whole Lärlogg sync and leave the page
//     stuck on "Hämtar senaste…". The cap on max response bytes
//     protects against InfoMentor accidentally streaming a tarball
//     or a runaway HTML error page in place of an image.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MEDIA_DIR } from './db.ts';
import { createSession } from './infomentor/httpClient.ts';
import type { CookieJar } from './infomentor/cookieJar.ts';
import type { LearnlogEntry, LearnlogMedia } from './infomentor/api.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import { upsertMedia } from './cache.ts';

// 50 MB. Photos from phones are typically <10 MB; InfoMentor videos
// are usually <100 MB but the dashboard is responsive even if we
// don't cache huge videos. Lower = safer; raise as needed.
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
// Used when IM's fileExtension is missing/empty so on-disk paths
// stay plain ("123.bin" instead of "123.") and Content-Type falls
// back to application/octet-stream rather than 404'ing.
const FALLBACK_EXTENSION = 'bin';

/**
 * Normalize IM's `fileExtension` ("jpeg", ".jpeg", "", …) to a
 * bare suffix suitable both for the on-disk path and for matching
 * in `contentTypeForFileExtension`. The original (raw) value is
 * preserved in the DB row; we sanitize at the FS boundary.
 */
function sanitizeExtension(raw: string): string {
	const trimmed = raw.trim().replace(/^\./, '').toLowerCase();
	return trimmed.length > 0 ? trimmed : FALLBACK_EXTENSION;
}

/**
 * Map an InfoMentor `fileExtension` to a `Content-Type` for the
 * SvelteKit route's response. Covers the extensions we've actually
 * seen plus a handful of other common phone-video formats. Anything
 * still unrecognised falls back to `fileType` (IM's own
 * Image/Video classification) so a browser at least gets a generic
 * `image/*` or `video/*` type and renders/plays the file inline
 * instead of treating an unfamiliar extension as an opaque download
 * (`application/octet-stream` forces "Save As" in most browsers).
 * Only if both signals are unhelpful do we fall through to
 * `application/octet-stream`.
 */
export function contentTypeForFileExtension(extension: string, fileType?: string | null): string {
	const ext = sanitizeExtension(extension);
	switch (ext) {
		// images
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
		// videos
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
		default: {
			const kind = fileType?.toLowerCase();
			if (kind === 'video') return 'video/mp4';
			if (kind === 'image') return 'image/jpeg';
			return 'application/octet-stream';
		}
	}
}

/**
 * The `<MEDIA_DIR>/<fileId>.<fileExtension>` path used by both the
 * write path (this module) and the read path (`/media/[fileId]/+server.ts`).
 * `extension` is sanitized to drop leading dots / empty strings so
 * the on-disk filename is never "123..jpeg" or "123.".
 */
export function localMediaPath(fileId: number, extension: string): string {
	return join(MEDIA_DIR, `${fileId}.${sanitizeExtension(extension)}`);
}

/**
 * True if the media file is already on disk + recorded in the
 * cache. The cached index is the source of truth — the on-disk
 * check is belt-and-braces in case the row was deleted but the
 * bytes survived (or vice-versa).
 */
function shouldDownload(cachedFileIds: Set<number>, mediaItem: LearnlogMedia): boolean {
	if (cachedFileIds.has(mediaItem.fileId)) return false;
	if (existsSync(localMediaPath(mediaItem.fileId, mediaItem.fileExtension))) return false;
	return true;
}

/**
 * Download one media item's bytes and persist. Returns true on a
 * fully completed write, false if the file was skipped (already
 * there) or any failure occurred. Per-file failures are logged but
 * never thrown — see the module-level note on why.
 */
async function downloadOneMediaItem(
	jar: CookieJar,
	mediaItem: LearnlogMedia,
	pupilSwitchId: number,
	entryId: number
): Promise<boolean> {
	const url = `https://hub.infomentor.se${mediaItem.fileUrl}`;
	const session = createSession(jar);
	const response = await session.request(url);

	if (response.status === 401 || response.status === 403) {
		console.warn(
			`[dementor] media ${mediaItem.fileId}: HTTP ${response.status} fetching ${url} — treating as InfoMentor session expiry`
		);
		throw new InfoMentorSessionExpiredError();
	}
	if (!response.ok) {
		console.warn(
			`[dementor] media ${mediaItem.fileId}: HTTP ${response.status} ${response.statusText}, skipping`
		);
		return false;
	}

	// Trusted: any InputFile with extension "csv" and MIME type
	// "text/csv" shouldn't matter to us, but defensively check
	// Content-Length + actual byte size against MAX_MEDIA_BYTES.
	const contentLengthHeader = response.headers.get('content-length');
	if (contentLengthHeader !== null) {
		const declared = Number(contentLengthHeader);
		if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
			console.warn(
				`[dementor] media ${mediaItem.fileId}: Content-Length ${declared} > cap ${MAX_MEDIA_BYTES}, skipping`
			);
			await response.body?.cancel();
			return false;
		}
	}

	// Read the body into memory in one go. Bytes have already been
	// size-checked via Content-Length (and Phase 4's media items
	// are realistically small). Streaming-to-disk would buy us
	// robustness against the cap not being declared; rejecting the
	// entire item if the cap is blown is fine because we'd rather
	// skip than buffer an unknown quantity.
	const arrayBuffer = await response.arrayBuffer();
	if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
		console.warn(
			`[dementor] media ${mediaItem.fileId}: actual ${arrayBuffer.byteLength} bytes > cap ${MAX_MEDIA_BYTES}, skipping`
		);
		return false;
	}

	const path = localMediaPath(mediaItem.fileId, mediaItem.fileExtension);
	await writeFile(path, Buffer.from(arrayBuffer));

	upsertMedia(mediaItem, arrayBuffer.byteLength, pupilSwitchId, entryId);
	return true;
}

/**
 * Walk every media item across every provided Lärlogg entry,
 * downloading the ones not already cached. `cachedFileIds` is the
 * pre-cached-id set (a `Set<number>`); `pupilSwitchId` per entry
 * is stored as the file's provenance in the cache. Returns running
 * counts so the caller can log a summary.
 *
 * Errors that are not session expiry (network blips, 5xx, etc.)
 * are caught and logged per item — we don't abort the whole sync
 * because one media file failed. A session-expired error DOES
 * propagate up so the section route can trigger the re-auth UI.
 */
export async function cacheMediaForEntries(
	jar: CookieJar,
	cachedFileIds: Set<number>,
	entries: { pupilSwitchId: number; entry: LearnlogEntry }[]
): Promise<{ attempted: number; downloaded: number; cached: number; failed: number }> {
	let attempted = 0;
	let downloaded = 0;
	let cached = 0;
	let failed = 0;

	for (const { pupilSwitchId, entry } of entries) {
		for (const mediaItem of entry.media) {
			if (!shouldDownload(cachedFileIds, mediaItem)) {
				cached++;
				continue;
			}
			attempted++;
			try {
				const ok = await downloadOneMediaItem(jar, mediaItem, pupilSwitchId, entry.id);
				// Track successful downloads so a media id reappearing
				// on a later entry within this same call is skipped
				// instead of re-downloaded. Failures don't get added,
				// so a transient network glitch might be retried on the
				// next sync — that's the right failure semantics.
				if (ok) cachedFileIds.add(mediaItem.fileId);
				downloaded += ok ? 1 : 0;
				failed += ok ? 0 : 1;
			} catch (err) {
				if (err instanceof InfoMentorSessionExpiredError) {
					// Bubble: the section page needs to show the re-auth panel.
					throw err;
				}
				console.warn(
					`[dementor] media ${mediaItem.fileId}: download failed: ${err instanceof Error ? err.message : 'unknown error'}`
				);
				failed++;
			}
		}
	}

	return { attempted, downloaded, cached, failed };
}
