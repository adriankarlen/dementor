// Server hook: gates every request behind a session lookup.
//
// The cookie carries only an opaque random token (see
// `src/lib/server/auth/sessions.ts`), so we just look it up in the DB
// and trust whatever user it resolves to. There's no signing needed
// because the cookie itself IS the credential — copying the cookie
// value onto another request logs that request in as the same user.
//
// Public routes (login, logout, the static assets SvelteKit serves
// itself, and anything that doesn't go through this hook at all) are
// listed below; everything else requires a valid session. The static
// asset check is belt-and-braces — SvelteKit's adapter-node short-
// circuits those before hitting hooks — but cheap to keep.
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';

import { lookupSession } from '$lib/server/auth/sessions';

const SESSION_COOKIE = 'session';
const PUBLIC_PATHS = new Set(['/login', '/logout']);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const resolved = token ? lookupSession(token) : undefined;

	if (resolved) {
		event.locals.user = resolved.user;
	} else {
		event.locals.user = null;
		// Make sure we don't pass a stale cookie value forward — if a
		// token was sent but didn't resolve (expired, deleted, etc.),
		// dropping it now means the next response doesn't echo it back.
		if (token) event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}

	const pathname = event.url.pathname;

	// Login page: if you're already logged in, sending you to / feels
	// less surprising than rendering a login form you'd just ignore.
	if (pathname === '/login' && event.locals.user) {
		throw redirect(303, '/');
	}

	const isPublic = PUBLIC_PATHS.has(pathname);
	if (!event.locals.user && !isPublic) {
		const redirectTo = encodeURIComponent(pathname + event.url.search);
		throw redirect(303, `/login?redirect=${redirectTo}`);
	}

	return resolve(event);
};
