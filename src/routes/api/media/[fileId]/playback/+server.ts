import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findLearnlogMedia, getCachedMedia } from '$lib/server/cache';
import { cachedCompatibleVideo } from '$lib/server/video-compatible';

// A small, uncached selection request. Never serve different video bytes at
// the same cacheable URL: original MOV ranges and repaired MP4 ranges differ.
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.infoMentor) error(401, 'no session');
	const fileId = Number(params.fileId);
	if (!Number.isSafeInteger(fileId) || fileId <= 0) error(400, 'invalid fileId');
	const repaired = await cachedCompatibleVideo(fileId);
	if (!repaired) {
		const media = getCachedMedia(fileId) ?? findLearnlogMedia(fileId)?.media;
		if (media?.fileType?.toLowerCase() !== 'video') error(404, 'video not found');
	}
	return json(
		{ variant: repaired ? 'compatible' : 'original' },
		{ headers: { 'Cache-Control': 'private, no-store' } }
	);
};
