// Login form action. Verifies the submitted credentials, on success
// creates a new session row, sets the session cookie, and redirects
// back to wherever the user was trying to go (or `/` as fallback).
//
// Validation is deliberately minimal — username + password both
// non-empty — because this is an internal app for two people, not a
// public signup form. The real anti-abuse layer is the rate-limit on
// InfoMentor's side, not here.
//
// `redirectTo` is constrained to same-origin paths only: an attacker
// can craft a /login?redirect=https://evil.example link and rely on
// the post-login redirect to send a logged-in user off-site. Reject
// anything that doesn't start with a single `/`.
import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.ts';

import { findCredentialsByUsername } from '$lib/server/auth/users';
import { createSession } from '$lib/server/auth/sessions';
import { verifyPassword } from '$lib/server/auth/passwords';

const SESSION_COOKIE = 'session';
// Anything not a single-leading-slash path is rejected, including
// `//evil.example` (browsers may treat that as protocol-relative).
const SAFE_REDIRECT = /^\/(?!\/)/;

// Decode one FormData field into a plain string. Our login form has no
// file inputs, so any non-string `FormDataEntryValue` is a programming
// error rather than something to silently coerce. This is the one
// place we cross the I/O boundary for form data; the action body below
// only ever sees `string`s, so further narrowing is unneeded.
function getStringField(form: FormData, name: string): string {
	const value = form.get(name);
	if (value === null) return '';
	if (value instanceof File) {
		throw new Error(`Form field "${name}" was a File, expected a string`);
	}
	return value;
}

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

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/');
	return { redirect: url.searchParams.get('redirect') ?? '' };
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const username = getStringField(form, 'username').trim();
		const password = getStringField(form, 'password');
		const wantedRedirect = safeRedirectPath(getStringField(form, 'redirect'), '/');

		if (!username || !password) {
			return fail(400, {
				username,
				error: 'Användarnamn och lösenord krävs.'
			});
		}

		const credentials = findCredentialsByUsername(username);
		// Run the hash comparison regardless of whether the user was
		// found, so the response time doesn't leak "this username is
		// real" vs "this username is fake". With only two accounts on
		// the system that's academic, but it's free to do and keeps
		// the timing constant.
		const dummySalt = '0'.repeat(32);
		const dummyHash = '0'.repeat(128);
		const ok = credentials
			? await verifyPassword(password, credentials.password_salt, credentials.password_hash)
			: (await verifyPassword(password, dummySalt, dummyHash), false);

		if (!credentials || !ok) {
			return fail(400, {
				username,
				error: 'Fel användarnamn eller lösenord.'
			});
		}

		const session = createSession(credentials.id);
		cookies.set(SESSION_COOKIE, session.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev,
			expires: session.expiresAt
		});

		throw redirect(303, wantedRedirect);
	}
};
