// POST /api/reauth — run the InfoMentor login dance again with the
// same username (looked up from the in-memory session map) and a
// fresh password (entered by the parent in the re-auth UI). On
// success, the cookie jar in the map is swapped for the new one, so
// the dashboard session stays alive and subsequent sync calls work.
//
// The body shape is `{ password: string }`. The username is taken
// from the session map — the UI doesn't send it because that would
// require trusting the client.
import { error, json } from '@sveltejs/kit';
import { type } from 'arktype';
import type { RequestHandler } from './$types';

import { reauthSession } from '$lib/server/infomentor/session';
import { InfoMentorLoginError } from '$lib/server/infomentor/errors';

const SESSION_COOKIE = 'session';

const ReauthBody = type({
	// atLeastLength(1) so an empty password string is rejected as
	// missing — the re-auth UI also enforces this on the client side
	// via `required`, but we want server-side validation too.
	password: 'string >= 1'
});

export const POST: RequestHandler = async ({ cookies, request }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) throw error(401, { message: 'no session' });

	// SAFETY: `request.json()` returns `Promise<any>`. arktype parses
	// and narrows to `ReauthBody.in`; the `instanceof` check
	// discriminates a successful parse from validation errors.
	const raw = await request.json();
	const parsed = ReauthBody(raw);
	if (parsed instanceof type.errors) {
		return json({ ok: false, error: 'missing_password' }, { status: 400 });
	}

	try {
		const result = await reauthSession(token, parsed.password);
		if (!result) {
			cookies.delete(SESSION_COOKIE, { path: '/' });
			throw error(401, { message: 'session not found' });
		}
		return json({ ok: true, username: result.username });
	} catch (err) {
		if (err instanceof InfoMentorLoginError) {
			return json({ ok: false, error: 'login_failed', detail: err.message }, { status: 401 });
		}
		console.error('[dementor] reauth failed:', err);
		const detail = err instanceof Error ? err.message : 'unknown error';
		return json({ ok: false, error: 'reauth_failed', detail }, { status: 500 });
	}
};
