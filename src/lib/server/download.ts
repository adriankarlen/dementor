import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export class EmptyDownloadError extends Error {
	constructor() {
		super('empty media response');
	}
}

/** Stream to a private temporary file; publish only a complete, non-empty body. */
export async function saveDownload(
	response: Response,
	path: string,
	maxBytes: number,
	validate?: (path: string) => Promise<void>
): Promise<number> {
	const declared = Number(response.headers.get('content-length'));
	if (response.status !== 200 || !response.body || declared > maxBytes) {
		await response.body?.cancel();
		throw new Error('media response rejected (status, body or size)');
	}
	const temp = `${path}.${randomUUID()}.tmp`;
	const reader = response.body.getReader();
	let file;
	let bytes = 0;
	try {
		file = await open(temp, 'wx', 0o600);
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error(`media exceeds ${maxBytes} byte limit`);
			await file.writeFile(value);
		}
		if (bytes === 0) throw new EmptyDownloadError();
		if (declared > 0 && bytes !== declared) throw new Error('incomplete media response');
		await file.close();
		file = undefined;
		await validate?.(temp);
		await rename(temp, path);
		return bytes;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		await file?.close();
		await rm(temp, { force: true });
	}
}
