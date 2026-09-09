import type { CookieJar } from './cookieJar.ts';

// Switching pupil changes remote session state. Keep the switch and its
// dependent request together, including when media and sync overlap.
const tails = new WeakMap<CookieJar, Promise<void>>();

export async function withInfoMentorSession<T>(jar: CookieJar, work: () => Promise<T>): Promise<T> {
	const previous = tails.get(jar) ?? Promise.resolve();
	const result = previous.then(work);
	const tail = result.then(
		() => {},
		() => {}
	);
	tails.set(jar, tail);
	try {
		return await result;
	} finally {
		if (tails.get(jar) === tail) tails.delete(jar);
	}
}
