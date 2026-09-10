import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import { MEDIA_DIR } from './db.ts';
import { upsertMedia } from './cache.ts';
import { saveDownload } from './download.ts';
import { fileResponse, parseRange } from './file-response.ts';
import {
	contentTypeForFileExtension,
	ensureMedia,
	localMediaPath,
	MAX_MEDIA_BYTES,
	requestMedia,
	validateMediaBody
} from './media.ts';
import type { LearnlogMedia } from './infomentor/api.ts';
import type { CookieJar } from './infomentor/cookieJar.ts';
import { withInfoMentorSession } from './infomentor/queue.ts';

export const VIDEO_CHUNK_BYTES = 1024 * 1024;
const Metadata = type({
	size: 'number.integer > 0',
	etag: 'string | null',
	modified: 'string | null'
});
type VideoMetadata = typeof Metadata.infer;
interface Chunk {
	path: string;
	start: number;
	end: number;
	metadata: VideoMetadata;
}
interface Timings {
	queue: number;
	upstream: number;
	cache: 'hit' | 'miss' | 'range-unsupported';
}
interface ChunkJob {
	promise: Promise<Chunk>;
	controller: AbortController;
	readers: number;
	timings: Timings;
}
const pending = new WeakMap<CookieJar, Map<string, ChunkJob>>();

async function readChunk(job: ChunkJob, signal: AbortSignal): Promise<Chunk> {
	job.readers++;
	let onAbort = () => {};
	try {
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		});
		return await Promise.race([job.promise, cancelled]);
	} finally {
		signal.removeEventListener('abort', onAbort);
		if (--job.readers === 0) job.controller.abort();
	}
}
class UnsatisfiableRangeError extends Error {
	readonly size: number;
	constructor(size: number) {
		super('video range outside file');
		this.size = size;
	}
}
function videoEtag(fileId: number, metadata: VideoMetadata) {
	return `"video-${fileId}-${version(metadata)}"`;
}

function directory(fileId: number) {
	return join(MEDIA_DIR, `${fileId}.ranges`);
}
function version(metadata: VideoMetadata) {
	return createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(0, 24);
}
function chunkDirectory(fileId: number, metadata: VideoMetadata) {
	return join(directory(fileId), version(metadata));
}
async function readMetadata(fileId: number): Promise<VideoMetadata | null> {
	try {
		const value = Metadata.assert(
			JSON.parse(await readFile(join(directory(fileId), 'info.json'), 'utf8'))
		);
		return value.size <= MAX_MEDIA_BYTES ? value : null;
	} catch {
		return null;
	} // Missing/corrupt cache metadata is rebuildable.
}
async function findChunk(
	fileId: number,
	metadata: VideoMetadata,
	start: number
): Promise<Chunk | null> {
	const folder = chunkDirectory(fileId, metadata);
	for (const name of await readdir(folder).catch(() => [])) {
		const match = /^(\d+)-(\d+)\.chunk$/.exec(name);
		if (!match) continue;
		const first = Number(match[1]);
		const last = Number(match[2]);
		if (first > start || last < start || last >= metadata.size) continue;
		const path = join(folder, name);
		const info = await stat(path).catch(() => null);
		if (info?.isFile() && info.size === last - first + 1)
			return { path, start: first, end: last, metadata };
	}
	return null;
}

function unsatisfiable(size?: number): Response {
	const headers = new Headers({ 'Cache-Control': 'no-store' });
	if (size !== undefined) headers.set('Content-Range', `bytes */${size}`);
	return new Response(null, { status: 416, headers });
}

/**
 * Cache only the bounded ranges requested by an opened player. MOV metadata
 * can be at EOF: a suffix/seek must not wait for a full sequential download.
 * Complete legacy files still use fileResponse directly in the route.
 */
export async function videoRangeResponse(
	jar: CookieJar,
	media: LearnlogMedia,
	pupil: number,
	entryId: number,
	request: Request,
	isActive: () => boolean
): Promise<Response> {
	const header = request.headers.get('range');
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? '');
	if (!match || (!match[1] && !match[2])) return unsatisfiable();
	const numbers = match.slice(1).filter(Boolean).map(Number);
	if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_MEDIA_BYTES))
		return unsatisfiable();
	const metadata = await readMetadata(media.fileId);
	const ifRange = request.headers.get('if-range');
	if (
		ifRange &&
		(!metadata || (ifRange !== videoEtag(media.fileId, metadata) && ifRange !== metadata.modified))
	) {
		const path = await ensureMedia(jar, media, pupil, entryId, false, isActive);
		return fileResponse(
			path,
			contentTypeForFileExtension(media.fileExtension, media.fileType),
			request
		);
	}
	const desired = metadata ? parseRange(header, metadata.size) : null;
	if (desired === 'unsatisfiable') return unsatisfiable(metadata?.size);
	const suffix = !match[1];
	if (suffix && Number(match[2]) === 0) return unsatisfiable(metadata?.size);
	if (!suffix && match[2] && Number(match[1]) > Number(match[2]))
		return unsatisfiable(metadata?.size);
	const start = desired ? desired.start : Number(match[1]);
	const cached =
		metadata && desired ? await findChunk(media.fileId, metadata, desired.start) : null;
	let timings: Timings = { queue: 0, upstream: 0, cache: cached ? 'hit' : 'miss' };
	let chunk = cached;
	if (!chunk) {
		const block = Math.floor(start / VIDEO_CHUNK_BYTES) * VIDEO_CHUNK_BYTES;
		const range =
			suffix && !metadata
				? `bytes=-${VIDEO_CHUNK_BYTES}`
				: `bytes=${block}-${block + VIDEO_CHUNK_BYTES - 1}`;
		const key = `${media.fileId}:${range}`;
		const jobs = pending.get(jar) ?? new Map<string, ChunkJob>();
		pending.set(jar, jobs);
		let job = jobs.get(key);
		if (!job || job.controller.signal.aborted) {
			const controller = new AbortController();
			const queued = performance.now();
			const task = withInfoMentorSession(
				jar,
				async () => {
					timings.queue = performance.now() - queued;
					controller.signal.throwIfAborted();
					if (!isActive()) throw new DOMException('Session replaced', 'AbortError');
					// Another browser/parent may have filled this chunk while we waited.
					const current = await readMetadata(media.fileId);
					const wanted = current ? parseRange(header, current.size) : null;
					if (current && wanted && wanted !== 'unsatisfiable') {
						const found = await findChunk(media.fileId, current, wanted.start);
						if (found) {
							timings.cache = 'hit';
							return found;
						}
					}
					const began = performance.now();
					const response = await requestMedia(jar, media, pupil, false, range, controller.signal);
					try {
						return await saveRange(response, media, pupil, entryId, range, timings);
					} finally {
						timings.upstream = performance.now() - began;
						await response.body?.cancel().catch(() => {});
					}
				},
				'interactive'
			);
			job = { promise: task, controller, readers: 0, timings };
			jobs.set(key, job);
			void task
				.finally(() => {
					if (jobs.get(key)?.promise === task) jobs.delete(key);
				})
				.catch(() => {});
		} else timings = job.timings;
		try {
			chunk = await readChunk(job, request.signal);
		} catch (err) {
			if (err instanceof UnsatisfiableRangeError) return unsatisfiable(err.size);
			throw err;
		}
	}
	const wanted = parseRange(header, chunk.metadata.size);
	if (!wanted || wanted === 'unsatisfiable') return unsatisfiable(chunk.metadata.size);
	// A first-ever suffix larger than one chunk needs the total size first.
	// The tail probe saved it; fetch the chunk at the actual requested start.
	if (suffix && !metadata && wanted.start < chunk.start)
		return videoRangeResponse(jar, media, pupil, entryId, request, isActive);
	if (wanted.start < chunk.start || wanted.start > chunk.end)
		return unsatisfiable(chunk.metadata.size);
	const end = Math.min(wanted.end, chunk.end);
	const etag = videoEtag(media.fileId, chunk.metadata);
	// Translate absolute offsets into this chunk's local offsets. Partial cache
	// files are never entered in the complete-media table or served as full files.
	const localRequest = new Request(request.url, {
		headers: { Range: `bytes=${wanted.start - chunk.start}-${end - chunk.start}` }
	});
	const result = await fileResponse(
		chunk.path,
		contentTypeForFileExtension(media.fileExtension, media.fileType),
		localRequest
	);
	result.headers.set('Content-Range', `bytes ${wanted.start}-${end}/${chunk.metadata.size}`);
	result.headers.set('ETag', etag);
	result.headers.set(
		'Server-Timing',
		`queue;dur=${timings.queue.toFixed(1)}, upstream;dur=${timings.upstream.toFixed(1)}, cache;desc="${timings.cache}"`
	);
	return result;
}

async function saveRange(
	response: Response,
	media: LearnlogMedia,
	pupil: number,
	entryId: number,
	requestedRange: string,
	timings: Timings
): Promise<Chunk> {
	const mime = response.headers.get('content-type')?.toLowerCase() ?? '';
	if (response.status === 416) {
		const size = Number(/^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
		if (Number.isSafeInteger(size) && size >= 0 && size <= MAX_MEDIA_BYTES)
			throw new UnsatisfiableRangeError(size);
	}
	if (response.status === 200) {
		// Range support is not assumed. Reuse this body for the existing bounded,
		// validated full-file cache rather than issuing a second full download.
		timings.cache = 'range-unsupported';
		const path = localMediaPath(media.fileId, media.fileExtension);
		const size = await saveDownload(response, path, MAX_MEDIA_BYTES, (temp) =>
			validateMediaBody(temp, false, mime)
		);
		upsertMedia(media, size, pupil, entryId);
		console.info(
			`[dementor] video ${media.fileId}: upstream ignored Range; cached full file (${size} bytes)`
		);
		return { path, start: 0, end: size - 1, metadata: { size, etag: null, modified: null } };
	}
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
	if (response.status !== 206 || !match)
		throw new Error('video range response missing a valid Content-Range');
	const [start, end, size] = match.slice(1).map(Number);
	if (
		![start, end, size].every(Number.isSafeInteger) ||
		size <= 0 ||
		size > MAX_MEDIA_BYTES ||
		start > end ||
		end >= size ||
		end - start + 1 > VIDEO_CHUNK_BYTES
	)
		throw new Error('video range response has invalid bounds');
	const requested = parseRange(requestedRange, size);
	if (
		!requested ||
		requested === 'unsatisfiable' ||
		requested.start !== start ||
		requested.end !== end
	)
		throw new Error('video range response does not match requested bytes');
	const metadata: VideoMetadata = {
		size,
		etag: response.headers.get('etag'),
		modified: response.headers.get('last-modified')
	};
	const folder = chunkDirectory(media.fileId, metadata);
	await mkdir(folder, { recursive: true });
	const complete = start === 0 && end === size - 1;
	const path = complete
		? localMediaPath(media.fileId, media.fileExtension)
		: join(folder, `${start}-${end}.chunk`);
	// saveDownload accepts only complete 200 bodies. Here "complete" means the
	// validated range, with an exact expected byte count, not a whole video.
	const headers = new Headers(response.headers);
	const declared = headers.get('content-length');
	if (declared !== null && Number(declared) !== end - start + 1)
		throw new Error('video range length mismatch');
	headers.set('Content-Length', String(end - start + 1));
	await saveDownload(new Response(response.body, { headers }), path, VIDEO_CHUNK_BYTES, (temp) =>
		validateMediaBody(temp, false, mime)
	);
	if (complete) {
		upsertMedia(media, size, pupil, entryId);
		return { path, start, end, metadata };
	}
	const temp = join(directory(media.fileId), `${randomUUID()}.tmp`);
	await writeFile(temp, JSON.stringify(metadata), { mode: 0o600 });
	await rename(temp, join(directory(media.fileId), 'info.json'));
	return { path, start, end, metadata };
}
