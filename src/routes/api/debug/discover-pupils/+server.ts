// GET /api/debug/discover-pupils — diagnostic endpoint that runs
// pupil discovery and returns what the regex scanner saw, plus a
// truncated HTML sample from the candidate URLs. The match count
// tells us whether the page is just empty (SPA shell) or has the
// switcher in a shape we don't recognize. The HTML sample lets us
// eyeball the actual page structure without dumping the whole doc.
//
// Authenticated: requires a valid session cookie. Doesn't mutate
// state, so safe to call repeatedly during debugging.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getSession } from '$lib/server/infomentor/session';
import { HUB_ROOT, discoverPupils } from '$lib/server/infomentor/api';
import { createSession } from '$lib/server/infomentor/httpClient';

const SESSION_COOKIE = 'session';
const MAX_HTML_LENGTH = 20_000;

interface PageSample {
	url: string;
	finalUrl: string;
	status: number;
	htmlLength: number;
	truncated: boolean;
	htmlSample: string;
	contains: { switchPupilPath: boolean; pupilSwitcherWord: boolean; loginForm: boolean };
}

export const GET: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) throw error(401, { message: 'no session' });

	const session = getSession(token);
	if (!session) {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw error(401, { message: 'session not found' });
	}

	// Sample each candidate URL the way discoverPupils walks them.
	const internalSession = createSession(session.cookieJar);
	const candidates = [HUB_ROOT, `${HUB_ROOT}Communication`];
	const samples: PageSample[] = [];
	for (const url of candidates) {
		const response = await internalSession.request(url);
		const html = await response.text();
		const truncated = html.length > MAX_HTML_LENGTH;
		samples.push({
			url,
			finalUrl: response.url,
			status: response.status,
			htmlLength: html.length,
			truncated,
			htmlSample: truncated ? html.slice(0, MAX_HTML_LENGTH) : html,
			contains: {
				switchPupilPath: html.includes('/Account/PupilSwitcher/SwitchPupil/'),
				pupilSwitcherWord: html.toLowerCase().includes('pupilswitcher'),
				loginForm: html.includes('login_ascx$txtNotandanafn')
			}
		});
		// If the first URL gave us matches, we can stop. Mirrors
		// discoverPupils' short-circuit.
		if (samples[samples.length - 1]?.contains.switchPupilPath) {
			// keep going for diagnostic purposes; the discovery
			// itself stops earlier.
		}
	}

	const discovered = await discoverPupils(session.cookieJar);

	return json({
		matched: discovered.length,
		discovered,
		samples
	});
};
