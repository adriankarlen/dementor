import type { CookieJar } from './cookieJar.ts';
import { InfoMentorSessionExpiredError } from './errors.ts';

type Priority = 'normal' | 'interactive';
interface Task {
	priority: Priority;
	run: () => Promise<void>;
}
interface Queue {
	running: boolean;
	tasks: Task[];
}
const queues = new WeakMap<CookieJar, Queue>();
const expired = new WeakSet<CookieJar>();

export function isInfoMentorSessionExpired(jar: CookieJar): boolean {
	return expired.has(jar);
}

async function drain(jar: CookieJar, queue: Queue) {
	if (queue.running) return;
	queue.running = true;
	while (queue.tasks.length) {
		// An opened video should not wait behind every lazy thumbnail. Never
		// interrupt an in-flight switch/download: remote pupil state is shared.
		const interactive = queue.tasks.findIndex((task) => task.priority === 'interactive');
		const [task] = queue.tasks.splice(interactive < 0 ? 0 : interactive, 1);
		await task.run();
	}
	queues.delete(jar);
}

export function withInfoMentorSession<T>(
	jar: CookieJar,
	work: () => Promise<T>,
	priority: Priority = 'normal'
): Promise<T> {
	const queue = queues.get(jar) ?? { running: false, tasks: [] };
	queues.set(jar, queue);
	const result = new Promise<T>((resolve, reject) => {
		queue.tasks.push({
			priority,
			async run() {
				try {
					// Test on dequeue, so confirmed expiry stops already-queued work.
					if (expired.has(jar)) throw new InfoMentorSessionExpiredError();
					resolve(await work());
				} catch (err) {
					if (err instanceof InfoMentorSessionExpiredError && !expired.has(jar)) {
						expired.add(jar);
						console.warn(
							'[dementor] InfoMentor session expired; upstream requests paused until re-login'
						);
					}
					reject(err);
				}
			}
		});
	});
	void drain(jar, queue);
	return result;
}
