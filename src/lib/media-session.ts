import { createContext } from 'svelte';

interface MediaSession {
	check: () => Promise<void>;
	readonly revision: number;
}
export const [getMediaSession, setMediaSession] = createContext<MediaSession>();

/** Per-page, coalesced checks after media errors (img/video hide HTTP status). */
export function createMediaSessionCheck(onExpired: () => void): () => Promise<void> {
	let pending: Promise<void> | undefined;
	let checkedAt = 0;
	return () => {
		if (pending) return pending;
		if (Date.now() - checkedAt < 1000) return Promise.resolve();
		pending = (async () => {
			try {
				const response = await fetch('/api/session', { cache: 'no-store' });
				if (response.redirected) {
					window.location.assign('/login');
					return;
				}
				if (!response.ok) return;
				// SAFETY: /api/session exposes only the in-memory expiry flag.
				const body = (await response.json()) as { expired: boolean };
				if (body.expired) onExpired();
			} catch {
				// A failed status check is not proof of expiry. Keep the media fallback.
			} finally {
				checkedAt = Date.now();
				pending = undefined;
			}
		})();
		return pending;
	};
}
