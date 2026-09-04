// InfoMentor's internal JSON API. Wraps the cookie-jar-aware
// `Session.request` from `httpClient.ts` with typed helpers for each
// endpoint we care about, plus the structural checks needed to detect
// "InfoMentor's own session cookie just expired" and turn it into a
// typed `InfoMentorSessionExpiredError`.
//
// Why this lives next to `login.ts`: the login dance is the only call
// that runs WITHOUT a pre-existing cookie jar. Every other endpoint
// here runs AFTER login, against a cookie jar stashed in the per-
// browser-session map. So the surface here takes a `CookieJar`; the
// login surface in `login.ts` takes credentials and produces a
// `CookieJar`. Everything funnels through `createSession(jar)` so the
// jar's cookies travel with every request and every Set-Cookie gets
// folded back in.
//
// Per `docs/api-notes.md`, fields we care about:
//   - GET  /learnlog/learnlog/getlearnlogs?...&pageNumber=&pageSize=
//   - POST /calendarv2/calendarv2/getentries  body { startDate, endDate }
//   - POST /Communication/News/GetNewsList     body { pageSize, sortBy }
//   - POST /Communication/Documents/GetDocumentsList  body { typeIds, sortBy, page, pageSize }
//   - GET  /Account/PupilSwitcher/SwitchPupil/{id}
//   - GET  hub.infomentor.se/ for pupil-switcher link discovery
//
// Endpoint paths here are ABSOLUTE on hub.infomentor.se. The cookie
// jar transparently carries the session cookie for both that host
// and infomentor.se.
import type { CookieJar } from './cookieJar.ts';
import { createSession } from './httpClient.ts';
import { InfoMentorSessionExpiredError } from './errors.ts';
import { isLoginPage } from './htmlForms.ts';

export const HUB_ROOT = 'https://hub.infomentor.se/';

// ---- Public response shapes (only fields the dashboard reads) ----

export interface LearnlogMedia {
	fileId: number;
	fileType: 'Image' | 'Video' | string;
	fileExtension: string;
	thumbnailUrl: string;
	fileUrl: string;
}

export interface LearnlogEntry {
	id: number;
	title: string;
	text: string;
	groupName: string;
	lastModifiedOn: string;
	subjectsCoursesDisplayString: string;
	media: LearnlogMedia[];
}

export interface CalendarEntry {
	id: number;
	title: string;
	text?: string;
	description?: string;
	calendarEntryTypeId: number;
	isAllDayEvent?: boolean;
	startDateFull: string;
	endDateFull: string;
	formattedStartDate?: string;
	formattedEndDate?: string;
}

export interface CalendarEntryType {
	id: number;
	name: string;
	colour: string;
	className?: string;
	isCustomType?: boolean;
}

export interface NewsItem {
	id: number;
	title: string;
	content: string;
	publishedDate: string;
	publishedDateString: string;
	publishedBy: string;
	newsImageUrl?: string;
	newsThumbnailImageUrl?: string;
}

export interface DocumentItem {
	id: number;
	title: string;
	type?: string;
	fileType?: string;
	fileSize?: number;
	fileUrl: string;
	publishedDateString?: string;
}

export interface DiscoveredPupil {
	switchId: number;
	displayName: string | null;
}

// ---- Internals ----

interface AppDataResponse {
	consentViewConfig?: { pupilIM2Id?: number; parentIM2Id?: number };
	// Other fields exist but the dashboard doesn't read them; cast at
	// the JSON boundary instead of modeling the whole thing.
}

interface CalendarWindow {
	startDate: string;
	endDate: string;
}

/**
 * Throw `InfoMentorSessionExpiredError` if `response` looks like
 * InfoMentor telling us the ASP.NET session has died. The two signals:
 *   - 401/403 status (rare but seen in some flows)
 *   - HTML body matching the login or relay page shapes
 *
 * Note: this helper does NOT consume the body — the caller reads it
 * exactly once, then decides how to handle it. This keeps the body
 * readable for both the session-expiry check AND the JSON parse
 * below, which would otherwise fight over the response stream.
 */
function checkResponseStatus(response: Response): void {
	if (response.status === 401 || response.status === 403) {
		throw new InfoMentorSessionExpiredError();
	}
}

/** True if `html` looks like InfoMentor's session-expired signal. */
function isSessionExpiredHtml(html: string): boolean {
	return isLoginPage(html) || /<body[^>]*\bonload="[^"]*\.submit\(\)[^"]*"/i.test(html);
}

/**
 * Read the body once, throw if the response was an auth-failure HTML
 * page, otherwise parse as JSON. This is the only place that reads
 * the body for JSON endpoints, so the body is consumed exactly once.
 */
async function readJsonOrThrowExpired<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (isSessionExpiredHtml(text)) {
		throw new InfoMentorSessionExpiredError();
	}
	try {
		// SAFETY: `JSON.parse` returns `any`; the cast `as T` narrows to
		// the endpoint-specific response shape. Each call site declares
		// its own `T` (e.g. `LearnlogEntry[]`) and trusts that
		// InfoMentor's API matches. Schema mismatches surface as
		// downstream property-access errors, not at this boundary.
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			`expected JSON from ${response.url}, got non-JSON body (status ${response.status})`
		);
	}
}

/** GET + assert-JSON. */
async function getJson<T>(jar: CookieJar, url: string): Promise<T> {
	const session = createSession(jar);
	const response = await session.request(url);
	checkResponseStatus(response);
	if (!response.ok) {
		throw new Error(`GET ${url} failed with ${response.status}`);
	}
	return readJsonOrThrowExpired<T>(response);
}

/**
 * Request body shape: a flat JSON object with primitive values. Matches
 * every InfoMentor endpoint's body schema (no nested arrays of objects,
 * no required arrays-of-arrays).
 */
interface JsonRequestBody {
	readonly [key: string]:
		| string
		| number
		| boolean
		| null
		| readonly (string | number | boolean | null)[];
}

/** POST + assert-JSON. */
async function postJson<T>(jar: CookieJar, url: string, body: JsonRequestBody): Promise<T> {
	const session = createSession(jar);
	const response = await session.request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=UTF-8' },
		body: JSON.stringify(body)
	});
	checkResponseStatus(response);
	if (!response.ok) {
		throw new Error(`POST ${url} failed with ${response.status}`);
	}
	return readJsonOrThrowExpired<T>(response);
}

// ---- Endpoint helpers ----

/**
 * Switches the server-side "current pupil" context. Per docs/api-notes,
 * this is a plain GET that returns 200 HTML (no JSON), so we DON'T route
 * it through `getJson` — we just check it didn't redirect us to a login
 * page (which would mean session expired).
 */
export async function switchPupil(jar: CookieJar, switchId: number): Promise<void> {
	const session = createSession(jar);
	const response = await session.request(
		`${HUB_ROOT}Account/PupilSwitcher/SwitchPupil/${switchId}`
	);
	checkResponseStatus(response);
	if (!response.ok && response.status !== 302 && response.status !== 303) {
		throw new Error(`switchPupil(${switchId}) failed with ${response.status}`);
	}
	// Drain body so the connection can be reused; the response isn't
	// JSON anyway so we discard.
	await response.text();
}

/**
 * POST /communication/communication/appData — confirms auth and
 * surfaces the currently-active pupil's IM2 id (informational; not
 * load-bearing for the dashboard).
 */
export async function getCommunicationAppData(jar: CookieJar): Promise<AppDataResponse> {
	return postJson<AppDataResponse>(jar, `${HUB_ROOT}communication/communication/appData`, {});
}

/**
 * GET /learnlog/learnlog/getlearnlogs?learnLogType=0&pageNumber=&pageSize=
 * Returns the entries on that page (newest first). 0 is the "Alla"
 * tab's type id — see docs/api-notes.md open questions.
 */
export async function getLearnlogs(
	jar: CookieJar,
	pageNumber: number,
	pageSize: number,
	learnLogType = 0
): Promise<LearnlogEntry[]> {
	return getJson<LearnlogEntry[]>(
		jar,
		`${HUB_ROOT}learnlog/learnlog/getlearnlogs?learnLogType=${learnLogType}&pageNumber=${pageNumber}&pageSize=${pageSize}`
	);
}

/**
 * POST /calendarv2/calendarv2/getentries  body { startDate, endDate }.
 * Dates are `YYYY/MM/DD` (slash-separated, NOT ISO) per docs/api-notes.
 */
export async function getCalendarEntries(
	jar: CookieJar,
	startDate: string,
	endDate: string
): Promise<CalendarEntry[]> {
	return postJson<CalendarEntry[]>(jar, `${HUB_ROOT}calendarv2/calendarv2/getentries`, {
		startDate,
		endDate
	});
}

/**
 * POST /calendarv2/calendarv2/appData — surfaces `calendarEntryTypes`,
 * the per-type id/name/colour the dashboard uses for the small chip
 * next to each calendar entry.
 */
export async function getCalendarAppData(
	jar: CookieJar
): Promise<{ calendarEntryTypes: CalendarEntryType[] }> {
	return postJson<{ calendarEntryTypes: CalendarEntryType[] }>(
		jar,
		`${HUB_ROOT}calendarv2/calendarv2/appData`,
		{}
	);
}

/**
 * POST /Communication/News/GetNewsList  body { pageSize: -1, sortBy }.
 * `pageSize: -1` returns everything (no pagination needed at the
 * volumes InfoMentor shows), per docs/api-notes.
 */
export async function getNews(jar: CookieJar): Promise<{ items: NewsItem[] }> {
	return postJson<{ items: NewsItem[] }>(jar, `${HUB_ROOT}Communication/News/GetNewsList`, {
		pageSize: -1,
		sortBy: 'lastPublishDate___SORT_DESC'
	});
}

/**
 * POST /Communication/Documents/GetDocumentsList  body { typeIds, sortBy, page, pageSize }.
 */
export async function getDocuments(
	jar: CookieJar,
	page: number,
	pageSize: number
): Promise<{ items: DocumentItem[]; totalItemCount: number }> {
	return postJson<{ items: DocumentItem[]; totalItemCount: number }>(
		jar,
		`${HUB_ROOT}Communication/Documents/GetDocumentsList`,
		{
			typeIds: '',
			sortBy: 'lastPublishDate___SORT_DESC',
			page,
			pageSize
		}
	);
}

/**
 * GET hub.infomentor.se/ and pull every `SwitchPupil/{id}` link out of
 * the HTML — that's the auto-discovered pupil list, per the AGENTS.md
 * note "InfoMentor uses at least three unrelated ID schemes for the
 * same pupil" (the switcher id is the only one obtainable without
 * already being logged in as that pupil). Link text becomes the
 * display name; missing/whitespace text yields null.
 *
 * Returns an empty list if the page is the login page (session
 * expired) rather than throwing here — callers decide whether empty
 * means "no children" or "re-auth needed" (they treat the latter as
 * session-expired by checking separately).
 */
export async function discoverPupils(jar: CookieJar): Promise<DiscoveredPupil[]> {
	// Try a few candidate URLs — the dashboard's actual landing page
	// after login has shifted in past captures, and the pupil switcher
	// can be rendered on any of them depending on which section is
	// configured as the home view. We stop at the first one that
	// yields any pupils. A 404 / non-OK on a candidate is fine — the
	// session is still alive, so the next candidate still works.
	const candidates = [HUB_ROOT, `${HUB_ROOT}Communication`];
	const session = createSession(jar);
	let lastHtml = '';
	let lastUrl = HUB_ROOT;

	for (const url of candidates) {
		const response = await session.request(url);
		checkResponseStatus(response);
		if (!response.ok) continue;
		const html = await response.text();
		lastHtml = html;
		lastUrl = response.url;
		if (isSessionExpiredHtml(html)) {
			throw new InfoMentorSessionExpiredError();
		}

		const pupils = extractPupilLinksFromHtml(html);
		if (pupils.length > 0) return pupils;
	}

	console.warn(
		`[dementor] pupil discovery tried ${candidates.length} URLs, found 0 pupils (last url=${lastUrl}, html length ${lastHtml.length})`
	);
	return [];
}

function extractPupilLinksFromHtml(html: string): DiscoveredPupil[] {
	const out = new Map<number, DiscoveredPupil>();
	// Anchors: <a ... href="/Account/PupilSwitcher/SwitchPupil/{id}" ...>name</a>
	const anchorRe =
		/<a\b[^>]*?href="\/Account\/PupilSwitcher\/SwitchPupil\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
	// Options: <option ... value="/Account/PupilSwitcher/SwitchPupil/{id}" ...>name</option>
	const optionRe =
		/<option\b[^>]*?value="\/Account\/PupilSwitcher\/SwitchPupil\/(\d+)"[^>]*>([\s\S]*?)<\/option>/gi;
	for (const re of [anchorRe, optionRe]) {
		for (const match of html.matchAll(re)) {
			const id = Number(match[1]);
			const rawName = match[2]
				.replace(/<[^>]+>/g, '')
				.replace(/&nbsp;/g, ' ')
				.trim();
			if (!Number.isFinite(id) || id <= 0) continue;
			// First occurrence wins; later duplicates are usually just the
			// switcher dropdown re-rendering the same options.
			if (!out.has(id)) {
				out.set(id, { switchId: id, displayName: rawName || null });
			}
		}
	}
	return [...out.values()];
}

/**
 * Build the (current month - 1, current month + 1) window of calendar
 * dates InfoMentor should return entries for, in the slash-separated
 * `YYYY/MM/DD` shape its API expects. The "previous month" padding is
 * timezone safety — a calendar entry posted late on the last day of
 * last month in CET could still be "today" for a server in UTC.
 */
export function calendarWindowForToday(now: Date = new Date()): CalendarWindow {
	const pad = (n: number) => String(n).padStart(2, '0');
	const fmt = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
	const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 2, 0); // day 0 of next month = last day of this month
	return { startDate: fmt(start), endDate: fmt(end) };
}
