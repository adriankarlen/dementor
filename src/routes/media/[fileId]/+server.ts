import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stat } from 'node:fs/promises';
import { findLearnlogMedia, getCachedMedia } from '$lib/server/cache';
import {
	contentTypeForFileExtension,
	ensureMedia,
	localMediaPath,
	localThumbnailPath,
	thumbnailContentType,
	ThumbnailUnavailableError
} from '$lib/server/media';
import { fileResponse } from '$lib/server/file-response';
import { videoThumbnailPlaceholder } from '$lib/server/video-placeholder';
import { getSession } from '$lib/server/infomentor/session';
import { InfoMentorSessionExpiredError } from '$lib/server/infomentor/errors';

const serve: RequestHandler = async ({ params, locals, request, url, cookies }) => {
	if (!locals.infoMentor) error(401, 'no session');
	const fileId = Number(params.fileId);
	if (!Number.isSafeInteger(fileId) || fileId <= 0) error(400, 'invalid fileId');
	const thumbnail = url.searchParams.get('thumbnail') === '1';
	const row = getCachedMedia(fileId);
	let path = thumbnail
		? localThumbnailPath(fileId)
		: row
			? localMediaPath(fileId, row.fileExtension)
			: null;
	const info = path ? await stat(path).catch(() => null) : null;
	let contentType = row
		? contentTypeForFileExtension(row.fileExtension, row.fileType)
		: 'application/octet-stream';

	if (!info?.isFile() || info.size === 0) {
		// Invalid old cache files are repaired on demand, not retried on every sync.
		const source = findLearnlogMedia(fileId);
		if (!source) error(404, 'media not found');
		if (request.method === 'HEAD')
			return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
		const token = cookies.get('session');
		const session = token ? getSession(token) : undefined;
		if (!session) error(401, 'no session');
		try {
			path = await ensureMedia(
				session.cookieJar,
				source.media,
				source.pupilSwitchId,
				source.entry.id,
				thumbnail,
				() => !!token && getSession(token)?.cookieJar === session.cookieJar
			);
			contentType = contentTypeForFileExtension(source.media.fileExtension, source.media.fileType);
		} catch (err) {
			if (
				thumbnail &&
				source.media.fileType.toLowerCase() === 'video' &&
				err instanceof ThumbnailUnavailableError
			) {
				return videoThumbnailPlaceholder();
			}
			if (err instanceof InfoMentorSessionExpiredError) {
				return json(
					{ error: 'session_expired' },
					{ status: 401, headers: { 'Cache-Control': 'no-store' } }
				);
			}
			return new Response(null, {
				status: 503,
				headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' }
			});
		}
	}
	if (!path) error(404, 'media not found');
	if (thumbnail) contentType = await thumbnailContentType(path);
	return fileResponse(path, contentType, request);
};

export const GET = serve;
export const HEAD = serve;
