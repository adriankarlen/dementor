import type { CookieJar } from './infomentor/cookieJar.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import type { SyncStatus } from '../sync-status.ts';
import { syncLearnlog } from './sync.ts';

const jobs = new WeakMap<CookieJar, SyncStatus>();
// Both parents write shared sync positions. Serialize metadata jobs across
// parents, but release the per-jar remote queue between individual pages.
let tail = Promise.resolve();
let revision = 0;

export function learnlogJobStatus(jar: CookieJar): SyncStatus {
	return jobs.get(jar) ?? { ok: true, running: false, revision: 0 };
}

/** On-demand work only. No timers/scheduler or persisted credentials. */
export function startLearnlogJob(jar: CookieJar, isActive: () => boolean): SyncStatus {
	const existing = jobs.get(jar);
	if (existing?.running) return existing;
	const job: SyncStatus = { ok: true, running: true, revision: ++revision };
	jobs.set(jar, job);
	tail = tail
		.then(async () => {
			if (!isActive()) return;
			job.summary = await syncLearnlog(
				jar,
				undefined,
				(summary) => {
					job.summary = summary;
					job.revision = ++revision;
				},
				isActive
			);
		})
		.catch((err) => {
			job.ok = false;
			job.error = err instanceof InfoMentorSessionExpiredError ? 'session_expired' : 'sync_failed';
			job.detail =
				err instanceof InfoMentorSessionExpiredError
					? undefined
					: 'Kunde inte hämta inläggen. Försök igen.';
			console.warn(`[dementor] learnlog sync: ${err instanceof Error ? err.message : 'failed'}`);
		})
		.finally(() => {
			job.running = false;
			job.revision = ++revision;
		});
	return job;
}
