import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/infomentor/session';
import { isInfoMentorSessionExpired } from '$lib/server/infomentor/queue';

// Called after a browser media error, never on a timer. No upstream request.
export const GET: RequestHandler = ({ cookies }) => {
	const token = cookies.get('session');
	const session = token ? getSession(token) : undefined;
	if (!session) error(401, 'no session');
	return json(
		{ expired: isInfoMentorSessionExpired(session.cookieJar) },
		{ headers: { 'Cache-Control': 'private, no-store' } }
	);
};
