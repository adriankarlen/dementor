// POST /api/sync/[section] — fire a sync for one section. Called
// from the section pages on mount to refresh the cache in the
// background. Reads the InfoMentor cookie jar from the per-session
// map, runs the relevant sync function, and returns a small JSON
// summary.
//
// Session expiry: if the InfoMentor session has died, the underlying
// sync throws `InfoMentorSessionExpiredError`. We translate that
// into a structured 401 response so the page can prompt for the
// password without dropping the dashboard session.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getSession } from '$lib/server/infomentor/session';
import { InfoMentorSessionExpiredError } from '$lib/server/infomentor/errors';
import {
	refreshCalendarEntryTypes,
	refreshPupils,
	syncCalendar,
	syncDocuments,
	syncLearnlog,
	syncNews
} from '$lib/server/sync';

const SESSION_COOKIE = 'session';

interface SyncSummary {
	pupils?: number;
	newEntries?: number;
	pagesFetched?: number;
	entries?: number;
	items?: number;
}

export const POST: RequestHandler = async ({ cookies, params }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) throw error(401, { message: 'no session' });

	const session = getSession(token);
	if (!session) {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw error(401, { message: 'session not found' });
	}

	const section = params.section;
	if (!section) throw error(400, { message: 'missing section' });

	try {
		let summary: SyncSummary;
		switch (section) {
			case 'pupils':
				// Manual refresh of the pupil list. Used by the UI when the
				// login-flow discovery missed (network glitch, page-shape
				// change, etc.) and the cached list is empty.
				summary = await refreshPupils(session.cookieJar).then((p) => ({
					pupils: p.length
				}));
				break;
			case 'learnlog':
				summary = await syncLearnlog(session.cookieJar);
				break;
			case 'calendar':
				// Refresh entry-type colours (small JSON, cheap) alongside
				// the entries themselves so the chips on the rendered page
				// actually have colours.
				await refreshCalendarEntryTypes(session.cookieJar);
				summary = await syncCalendar(session.cookieJar);
				break;
			case 'news':
				summary = await syncNews(session.cookieJar);
				break;
			case 'documents':
				summary = await syncDocuments(session.cookieJar);
				break;
			default:
				throw error(404, { message: `unknown section: ${section}` });
		}
		return json({ ok: true, section, summary });
	} catch (err) {
		if (err instanceof InfoMentorSessionExpiredError) {
			// Body shape: { error: 'session_expired' }. The page checks
			// for this exact string to decide whether to show the
			// re-auth prompt vs. a generic error.
			return json({ ok: false, error: 'session_expired' }, { status: 401 });
		}
		console.error(`[dementor] sync(${section}) failed:`, err);
		const detail = err instanceof Error ? err.message : 'unknown error';
		return json({ ok: false, error: 'sync_failed', detail }, { status: 500 });
	}
};
