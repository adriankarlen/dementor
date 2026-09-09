import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

interface ByteRange {
	start: number;
	end: number;
}

export function parseRange(
	header: string | null,
	size: number
): ByteRange | null | 'unsatisfiable' {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return null;
	const [, first, last] = match;
	if (size === 0) return 'unsatisfiable';
	if (!first) {
		const suffix = Number(last);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last ? Number(last) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
		return 'unsatisfiable';
	}
	return { start, end: Math.min(end, size - 1) };
}

/** Reads only the requested range. Cancelling the response closes the file. */
export async function fileResponse(
	path: string,
	contentType: string,
	request: Request
): Promise<Response> {
	const file = await open(path, 'r');
	try {
		const { size, mtimeMs } = await file.stat();
		// Empty legacy cache files are not valid media. Do not cache a 416 forever.
		if (size === 0) {
			await file.close();
			return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
		}
		const etag = `"${size}-${Math.trunc(mtimeMs)}"`;
		const headers = new Headers({
			'Content-Type': contentType,
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'private, max-age=86400',
			'X-Content-Type-Options': 'nosniff',
			ETag: etag
		});
		if (request.headers.get('if-none-match') === etag) {
			await file.close();
			return new Response(null, { status: 304, headers });
		}
		const ifRange = request.headers.get('if-range');
		const range = parseRange(
			!ifRange || ifRange === etag ? request.headers.get('range') : null,
			size
		);
		if (range === 'unsatisfiable') {
			await file.close();
			headers.set('Content-Range', `bytes */${size}`);
			headers.set('Cache-Control', 'no-store');
			return new Response(null, { status: 416, headers });
		}
		headers.set('Content-Length', String(range ? range.end - range.start + 1 : size));
		if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
		const status = range ? 206 : 200;
		if (request.method === 'HEAD') {
			await file.close();
			return new Response(null, { status, headers });
		}
		const stream = range ? file.createReadStream(range) : file.createReadStream();
		// SAFETY: Node's byte-mode ReadStream produces Buffer (Uint8Array)
		// chunks; toWeb exposes the same chunks as a standard web stream.
		const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
		return new Response(body, { status, headers });
	} catch (err) {
		await file.close();
		throw err;
	}
}
