// POST /logout — delete the current session row and clear the cookie,
// then redirect to /login. POST (not GET) so a stray <img src> or
// prefetch can't accidentally log someone out.
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types.ts';

import { dropSession } from '$lib/server/auth/sessions';

const SESSION_COOKIE = 'session';

export const POST: RequestHandler = ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) dropSession(token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	throw redirect(303, '/login');
};
