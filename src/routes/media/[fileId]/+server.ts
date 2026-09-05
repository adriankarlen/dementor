// GET /media/[fileId] — serves the locally-cached bytes of one
// Lärlogg media item. Phase 4 of the implementation plan; this is the
// "stands in front of hub.infomentor.se" part of the cache.
//
// Auth: requires a valid dashboard session, same as every other
// page. The manifest doesn't expose `/media/X` to the public —
// anyone hitting it without a `session` cookie gets redirected to
// /login (404 would leak the existence of file ids).
//
// Lookup: `fileId` is IM's `LearnlogMedia.fileId` (confirmed unique
// enough for our scale by being the lookup key on the thumbnail and
// download endpoints themselves). We resolve the on-disk path via
// the cached row's `file_extension`; we do NOT trust URL-based
// extensions because `docs/api-notes.md` notes file extensions can
// vary by media type.
//
// Range requests: `<video>` playback (particularly Safari/iOS) does
// NOT reliably play inline without byte-range support — some mobile
// browsers fall back to downloading the file instead of playing it
// if the server never answers a `Range` request with `206 Partial
// Content`. We support single-range requests (`bytes=start-end`,
// `bytes=start-`, `bytes=-suffixLength`); anything we can't parse
// falls back to a full 200 response with `Accept-Ranges: bytes` so
// the client knows to retry with a real range next time.
//
// Headers: `Cache-Control: private, immutable` is the right shape
// for a personal-only cache; the dashboard won't revalidate, and a
// browser-tied cache is appropriate here. `Content-Type` is derived
// from the cached row's extension via `contentTypeForFileExtension`,
// with `file_type` (IM's own Image/Video classification) as a
// fallback so an unrecognised extension still gets a generic
// `image/*`/`video/*` type instead of `application/octet-stream`
// (which browsers treat as an opaque download).
import { error } from '@sveltejs/kit';
import { readFile, stat } from 'node:fs/promises';
import type { RequestHandler } from './$types';

import { getCachedMedia, listCachedMediaFileIds } from '$lib/server/cache';
import { contentTypeForFileExtension, localMediaPath } from '$lib/server/media';

/** Parsed single-range request, in the [start, end] inclusive form. */
interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parse a `Range: bytes=...` header against a known total size.
 * Returns `null` if the header is absent/unparseable (caller should
 * fall back to a full response), or `'unsatisfiable'` if it parsed
 * but is out of bounds (caller should reply 416).
 */
function parseRange(header: string | null, totalSize: number): ByteRange | null | 'unsatisfiable' {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, startStr, endStr] = match;

	let start: number;
	let end: number;
	if (startStr === '' && endStr !== '') {
		// Suffix form: "bytes=-500" means "last 500 bytes".
		const suffixLength = Number(endStr);
		if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
		start = Math.max(0, totalSize - suffixLength);
		end = totalSize - 1;
	} else {
		start = startStr === '' ? 0 : Number(startStr);
		end = endStr === '' ? totalSize - 1 : Number(endStr);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
		return 'unsatisfiable';
	}
	if (start >= totalSize) return 'unsatisfiable';
	return { start, end: Math.min(end, totalSize - 1) };
}

export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.infoMentor) throw error(401, { message: 'no session' });

	const raw = params.fileId;
	const fileId = Number(raw);
	if (!Number.isInteger(fileId) || fileId <= 0) {
		throw error(400, { message: 'invalid fileId' });
	}

	// Fast-pre-check: the cached-id Set covers the vast majority of
	// render lookups (the page passes it in `data.cachedMediaFileIds`,
	// but a direct GET hitting this route won't). Fast path before
	// the table read so hot reload doesn't always round-trip SQLite.
	if (!listCachedMediaFileIds().has(fileId)) {
		throw error(404, { message: 'not cached' });
	}

	const row = getCachedMedia(fileId);
	if (!row) {
		// Set said yes but the row's gone. Treat as 404; the next sync
		// (which writes rows via `upsertMedia`) will re-populate.
		throw error(404, { message: 'not cached' });
	}

	const path = localMediaPath(row.fileId, row.fileExtension);
	let statResult;
	try {
		statResult = await stat(path);
	} catch {
		// The row exists but the file is gone. The next sync's
		// download step will re-fetch on demand. Don't throw a hard
		// 500 — surface a 404 so the <img>/<video> onerror handler
		// can skip the alert noise.
		throw error(404, { message: 'file missing on disk' });
	}

	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch {
		throw error(500, { message: 'read failed' });
	}

	const totalSize = statResult.size;
	const contentType = contentTypeForFileExtension(row.fileExtension, row.fileType);
	// `immutable` because we never mutate or delete a file once it's
	// in the cache; the only refresh path is to write the same
	// bytes to the same path (idempotent per
	// `cacheMediaForEntries.shouldDownload`, which gates on the
	// cached Set). `private` keeps the response out of shared CDN
	// caches (we don't run one, but the marker is correct).
	const cacheControl = 'private, max-age=31536000, immutable';

	const range = parseRange(request.headers.get('range'), totalSize);
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' }
		});
	}

	if (range) {
		const chunk = bytes.subarray(range.start, range.end + 1);
		const headers = new Headers({
			'Content-Type': contentType,
			'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': chunk.length.toString(),
			'Cache-Control': cacheControl
		});
		return new Response(new Uint8Array(chunk), { status: 206, headers });
	}

	const headers = new Headers({
		'Content-Type': contentType,
		'Content-Length': totalSize.toString(),
		'Accept-Ranges': 'bytes',
		'Cache-Control': cacheControl,
		// Attachment would force a "Save As" prompt in some browsers;
		// inline lets <img>/<video> render the response directly.
		'Content-Disposition': `inline; filename="${row.fileId}.${row.fileExtension}"`
	});
	return new Response(new Uint8Array(bytes), { headers });
};
