// Server hook: gates every request behind an InfoMentor session
// lookup. The cookie carries only an opaque random token (see
// `src/lib/server/infomentor/session.ts`); whatever session entry it
// resolves to IS the user, no separate dashboard auth.
//
// There is no signed-cookie scheme because the cookie itself IS the
// credential — copying the cookie value onto another request logs
// that request in as the same parent.
//
// Public routes (login, static assets SvelteKit serves itself, and
// anything that doesn't go through this hook at all) are listed
// below; everything else requires a valid InfoMentor session. The
// static asset check is belt-and-braces — SvelteKit's adapter-node
// short-circuits those before hitting hooks — but cheap to keep.
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';

import { getSession as getInfoMentorSession, touchSession } from '$lib/server/infomentor/session';

const SESSION_COOKIE = 'session';
const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const infoMentor = token ? getInfoMentorSession(token) : undefined;

	if (infoMentor && token) {
		event.locals.infoMentor = { username: infoMentor.username };
		touchSession(token);
	} else {
		event.locals.infoMentor = null;
		// Make sure we don't pass a stale cookie value forward — if a
		// token was sent but didn't resolve (server restart, manual
		// drop), dropping it now means the next response doesn't echo
		// it back.
		if (token) event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}

	const pathname = event.url.pathname;

	// Login page: if you're already logged in, sending you to /
	// feels less surprising than rendering a login form you'd just
	// ignore.
	if (pathname === '/login' && event.locals.infoMentor) {
		throw redirect(303, '/');
	}

	const isPublic = PUBLIC_PATHS.has(pathname);
	if (!event.locals.infoMentor && !isPublic) {
		const redirectTo = encodeURIComponent(pathname + event.url.search);
		throw redirect(303, `/login?redirect=${redirectTo}`);
	}

	return resolve(event);
};
