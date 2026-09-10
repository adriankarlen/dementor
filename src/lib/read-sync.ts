import type { SyncStatus } from './sync-status.ts';

/** The sync route sends one JSON status per line, including a terminal status. */
export async function* readSync(response: Response): AsyncGenerator<SyncStatus> {
	if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
		// SAFETY: our sync endpoints return the shared SyncStatus contract.
		yield (await response.json()) as SyncStatus;
		return;
	}
	if (!response.body) throw new Error('Hämtningen saknar svar. Försök igen.');
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let pending = '';
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += value;
			let newline;
			while ((newline = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				// SAFETY: streamLearnlogJob serializes SyncStatus on each line.
				const status = JSON.parse(line) as SyncStatus;
				finished = !status.running;
				yield status;
			}
		}
		if (!finished || pending.trim()) throw new Error('Hämtningen avbröts. Försök igen.');
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
