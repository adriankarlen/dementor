// Login form action: runs the InfoMentor login dance, attaches the
// resulting cookie jar to a fresh opaque session token, sets the
// session cookie, and redirects home (or to the `redirect` query
// param, same-origin only).
//
// There is no separate dashboard user account — InfoMentor creds are
// the only credentials, per the Phase 2 architectural pivot recorded
// in AGENTS.md / docs/implementation-plan.md.
//
// Error reporting: InfoMentor's login failure surfaces their generic
// localized message ("Inloggning misslyckades…") verbatim — it's
// the same text InfoMentor shows everyone, not personal data.
import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { login as infoMentorLogin, attachSession } from '$lib/server/infomentor';
import { InfoMentorLoginError } from '$lib/server/infomentor/errors';
import { refreshPupils } from '$lib/server/sync';

const SESSION_COOKIE = 'session';
// Anything not a single-leading-slash path is rejected, including
// `//evil.example` (browsers may treat that as protocol-relative).
const SAFE_REDIRECT = /^\/(?!\/)/;

function safeRedirectPath(input: string | null | undefined, fallback: string): string {
	if (!input) return fallback;
	try {
		const decoded = decodeURIComponent(input);
		if (SAFE_REDIRECT.test(decoded)) return decoded;
	} catch {
		// Malformed encoding — fall through to fallback.
	}
	return fallback;
}

// Decode one FormData field into a plain string. Our login form has
// no file inputs, so any non-string `FormDataEntryValue` is a
// programming error rather than something to silently coerce.
function getStringField(form: FormData, name: string): string {
	const value = form.get(name);
	if (value === null) return '';
	if (value instanceof File) {
		throw new Error(`Form field "${name}" was a File, expected a string`);
	}
	return value;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.infoMentor) throw redirect(303, '/');
	return { redirect: url.searchParams.get('redirect') ?? '' };
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const username = getStringField(form, 'infomentorUsername').trim();
		const password = getStringField(form, 'infomentorPassword');
		const wantedRedirect = safeRedirectPath(getStringField(form, 'redirect'), '/');

		if (!username || !password) {
			return fail(400, {
				infomentorUsername: username,
				error: 'Användarnamn och lösenord krävs.'
			});
		}

		// Run the InfoMentor login dance. Multi-second, multi-relay-page;
		// the only async boundary in this action.
		let infoMentorSession;
		try {
			infoMentorSession = await infoMentorLogin(username, password);
		} catch (err) {
			const detail =
				err instanceof InfoMentorLoginError
					? err.message
					: err instanceof Error
						? err.message
						: 'okänt fel';
			return fail(400, {
				infomentorUsername: username,
				error: `Inloggning misslyckades: ${detail}`
			});
		}

		// Mint an opaque session token. The token IS the credential —
		// the cookie just carries it. No JWT, no signing; the server-side
		// map (`infomentor/session.ts`) is what gives it meaning.
		const token = crypto.randomUUID();
		attachSession(token, {
			username: infoMentorSession.username,
			cookieJar: infoMentorSession.cookieJar,
			loggedInAt: new Date(),
			lastUsedAt: new Date()
		});
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev
			// No `expires` — the session lives until logout or server
			// restart. InfoMentor's own session expiry is the real
			// session boundary; re-prompting for the IM password
			// (Phase 3's re-auth flow) handles that.
		});

		// Best-effort pupil discovery right after login. A failure
		// here doesn't fail the login — section pages will trigger
		// their own refresh later. We log to the server console for
		// debugging; the user-visible UX stays the same.
		try {
			await refreshPupils(infoMentorSession.cookieJar);
		} catch (err) {
			console.error('[dementor] pupil discovery after login failed:', err);
		}

		throw redirect(303, wantedRedirect);
	}
};
