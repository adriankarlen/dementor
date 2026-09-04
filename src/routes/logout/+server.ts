// POST /logout — drop the InfoMentor session entry from the
// in-memory map and clear the session cookie. Then redirect to
// /login.
//
// POST (not GET) so a stray <img src> or prefetch can't accidentally
// log someone out.
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { dropSession } from '$lib/server/infomentor/session';

const SESSION_COOKIE = 'session';

export const POST: RequestHandler = ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) dropSession(token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	throw redirect(303, '/login');
};
