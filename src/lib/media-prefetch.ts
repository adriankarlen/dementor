// Background photo prefetching for the Lärlogg/Månadsbrev feeds.
//
// Thumbnails already load lazily as their `<img>` tiles scroll into
// view. That leaves the *full* image only fetched once a post is
// opened in the lightbox — first-open of any post used to feel slow
// even though InfoMentor's API is inherently slow, not our server.
// We already know which posts are on screen (or about to be, via the
// infinite-scroll query) well before the user clicks a thumbnail, so
// this module uses that lead time: once a page of posts is loaded,
// their photos are fetched in the background at low priority, so the
// bytes are already on disk and in the browser's HTTP cache by the
// time the user opens one.
//
// Deliberately image-only. A video's full body can be up to 256 MiB
// (see docs/learnlog-loading.md "Media") and the player already
// streams it progressively via byte-range requests; eagerly pulling
// whole videos in the background would fight that design and burn
// bandwidth on videos the user may never open. Video *thumbnails*
// still load the same lazy way as image thumbnails, unaffected by
// this module.
import { mediaKind } from './components/media-kind.ts';

const CONCURRENCY = 3;

export interface PrefetchableMedia {
	fileId: number;
	fileType: string;
}

export interface MediaPrefetcher {
	/**
	 * Queue every not-yet-seen image among `items` for a background
	 * fetch, skipping videos/documents and anything `cachedFileIds`
	 * already reports as cached on disk. Safe to call repeatedly
	 * with overlapping/growing lists (e.g. once per loaded feed
	 * page) — already-queued or already-fetched ids are ignored.
	 */
	queue(items: PrefetchableMedia[], cachedFileIds: ReadonlySet<number>): void;
}

/**
 * `onUnauthorized` is called (at most once — the prefetcher stops
 * queueing work after that) when a background fetch comes back 401,
 * i.e. the InfoMentor session expired server-side. Callers pass the
 * same coalesced session-check used for thumbnail/video load errors
 * (see `media-session.ts`) so a background prefetch failure surfaces
 * the same re-login prompt instead of failing silently forever.
 */
export function createMediaPrefetcher(onUnauthorized: () => void): MediaPrefetcher {
	const seen = new Set<number>();
	const queue: number[] = [];
	let active = 0;
	let stopped = false;

	function pump(): void {
		while (!stopped && active < CONCURRENCY && queue.length > 0) {
			const fileId = queue.shift();
			if (fileId === undefined) break;
			active++;
			void run(fileId).finally(() => {
				active--;
				pump();
			});
		}
	}

	async function run(fileId: number): Promise<void> {
		try {
			const response = await fetch(`/media/${fileId}`, {
				// Hints the browser to schedule this behind the page's own
				// requests (thumbnails, sync, user-initiated fetches).
				// Unsupported browsers just ignore the field.
				priority: 'low'
			});
			if (response.status === 401) {
				stopped = true;
				queue.length = 0;
				onUnauthorized();
				return;
			}
			// Drain the body so the response is actually stored in the
			// HTTP cache and the connection is freed; the bytes
			// themselves aren't needed here.
			await response.arrayBuffer();
		} catch {
			// Best-effort only — the lightbox still fetches on demand if
			// this failed (offline, aborted navigation, transient 503).
		}
	}

	return {
		queue(items, cachedFileIds) {
			if (stopped) return;
			for (const item of items) {
				if (mediaKind(item.fileType) !== 'image') continue;
				if (seen.has(item.fileId) || cachedFileIds.has(item.fileId)) continue;
				seen.add(item.fileId);
				queue.push(item.fileId);
			}
			pump();
		}
	};
}
