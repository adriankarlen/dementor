import type { CookieJar } from './infomentor/cookieJar.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import type { SyncStatus } from '../sync-status.ts';
import type { LearnlogSyncMode } from './learnlog-sync.ts';
import { syncLearnlog } from './sync.ts';

interface Job {
	status: SyncStatus;
	listeners: Set<(status: SyncStatus) => void>;
	streamed: boolean;
}
const jobs = new WeakMap<CookieJar, Job>();
// Shared SQLite positions need one writer. Each job is bounded; the remote
// per-jar queue is released between pages so media can run too.
let tail = Promise.resolve();

export function learnlogJobStatus(jar: CookieJar): SyncStatus {
	return jobs.get(jar)?.status ?? { ok: true, running: false };
}

export function startLearnlogJob(
	jar: CookieJar,
	isActive: () => boolean,
	mode: LearnlogSyncMode = 'latest'
): SyncStatus {
	const existing = jobs.get(jar);
	if (existing?.status.running) return existing.status;
	const job: Job = {
		status: { ok: true, running: true },
		listeners: new Set(),
		streamed: false
	};
	jobs.set(jar, job);
	const active = () => isActive() && (!job.streamed || job.listeners.size > 0);
	function publish() {
		for (const listener of job.listeners) listener(job.status);
	}
	tail = tail
		.then(async () => {
			if (!active()) return;
			job.status.summary = await syncLearnlog(
				jar,
				undefined,
				(summary) => {
					job.status.summary = summary;
					publish();
				},
				active,
				mode
			);
		})
		.catch((err) => {
			job.status.ok = false;
			job.status.error =
				err instanceof InfoMentorSessionExpiredError ? 'session_expired' : 'sync_failed';
			job.status.detail =
				err instanceof InfoMentorSessionExpiredError
					? undefined
					: 'Kunde inte hämta inläggen. Försök igen.';
			console.warn(`[dementor] learnlog sync: ${err instanceof Error ? err.message : 'failed'}`);
		})
		.finally(() => {
			job.status.running = false;
			publish();
			job.listeners.clear();
		});
	return job.status;
}

/** Push committed batches over one response. No timer or status polling. */
export function streamLearnlogJob(
	jar: CookieJar,
	isActive: () => boolean,
	mode: LearnlogSyncMode
): Response {
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			startLearnlogJob(jar, isActive, mode);
			const job = jobs.get(jar)!;
			job.streamed = true;
			const send = (status: SyncStatus) => {
				controller.enqueue(encoder.encode(JSON.stringify(status) + '\n'));
				if (!status.running) controller.close();
			};
			job.listeners.add(send);
			unsubscribe = () => job.listeners.delete(send);
			send(job.status);
		},
		cancel() {
			unsubscribe();
		}
	});
	return new Response(body, {
		headers: {
			'Content-Type': 'application/x-ndjson',
			'Cache-Control': 'private, no-store',
			'X-Accel-Buffering': 'no'
		}
	});
}
