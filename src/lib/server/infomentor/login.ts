// InfoMentor's username/password login flow, ported from
// tools/probe-login.ts into real app code. Same dance, same field
// names, same relay detection. Returns an authenticated cookie jar
// — what the caller does with it is their problem (the dashboard
// stashes it in the per-session map; tools/probe-login prints a
// structural summary).
//
// Why this lives in src/ rather than tools/: the tools/ copy now
// imports from here, so the flow lives in exactly one place.
import { createSession } from './httpClient.ts';
import { type CookieJar } from './cookieJar.ts';
import { isLoginPage, isRelayPage, parseFirstForm, parseLoginError } from './htmlForms.ts';
import { InfoMentorLoginError } from './errors.ts';

const HUB_ROOT = 'https://hub.infomentor.se/';
const APP_DATA_URL = 'https://hub.infomentor.se/communication/communication/appData';

const MAX_RELAY_HOPS = 5;

interface RelayResult {
	response: Response;
	html: string;
}

/**
 * Walk auto-submit relay pages, POSTing each form back. We never know
 * how many hops InfoMentor's flow will take (could be 0, could be a
 * few — `tools/probe-login.ts`'s flow notes confirm at least 2), so we
 * loop on the relay-page detector with a safety cap rather than
 * assuming a fixed number.
 *
 * `html` may be passed in when the caller already read the body
 * (Response bodies can only be consumed once — no re-reading via
 * `.clone()` after the fact, that throws "Body has already been
 * consumed").
 */
async function followRelays(
	session: ReturnType<typeof createSession>,
	initial: Response,
	initialHtml?: string
): Promise<RelayResult> {
	let response = initial;
	let html = initialHtml ?? (await response.text());

	for (let hop = 0; hop < MAX_RELAY_HOPS; hop++) {
		if (!isRelayPage(html)) return { response, html };

		const form = parseFirstForm(html);
		if (!form) {
			throw new InfoMentorLoginError(
				'relay page detected but no <form> found — page shape changed, needs re-investigation'
			);
		}

		const actionUrl = new URL(form.action, response.url).href;
		response = await session.request(actionUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form.hiddenFields)
		});
		html = await response.text();
	}
	throw new InfoMentorLoginError(
		`followed ${MAX_RELAY_HOPS} relay hops without landing anywhere — likely a loop, needs re-investigation`
	);
}

export interface InfoMentorLoginResult {
	username: string;
	cookieJar: CookieJar;
}

/**
 * Run the full username/password login dance against InfoMentor. On
 * success, returns a cookie jar already proven to be authenticated
 * (via a follow-up POST to `appData`). On failure, throws
 * `InfoMentorLoginError` with a structural message — never includes
 * the password or any personal data.
 */
export async function login(username: string, password: string): Promise<InfoMentorLoginResult> {
	const session = createSession();

	// 1. GET hub.infomentor.se — should redirect into the login flow.
	let response = await session.request(HUB_ROOT);
	let relay = await followRelays(session, response);
	response = relay.response;
	let html = relay.html;

	if (!isLoginPage(html)) {
		// Structural diagnostics only — hostname/path/status from
		// InfoMentor's own response, no credentials or personal
		// content, safe to paste back for debugging. A common cause
		// here is InfoMentor rate-limiting/blocking repeated login
		// attempts from the same IP after several failed or rapid
		// tries, which can serve a different page shape than the
		// normal login form.
		const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
		throw new InfoMentorLoginError(
			`did not land on the username/password login page — InfoMentor flow may have changed ` +
				`(landed on ${response.url}, HTTP ${response.status}, title: ${titleMatch ? JSON.stringify(titleMatch[1].trim()) : 'none'}, ${html.length} bytes)`
		);
	}

	// 2. POST the credentials. Field names confirmed 2026-09-04 via
	//    tools/probe-login.ts against a real account.
	const form = parseFirstForm(html);
	if (!form) {
		throw new InfoMentorLoginError('login page had no parseable <form>');
	}

	const loginActionUrl = new URL(form.action || response.url, response.url).href;
	response = await session.request(loginActionUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			...form.hiddenFields,
			login_ascx$txtNotandanafn: username,
			login_ascx$txtLykilord: password,
			login_ascx$btnLogin: 'Logga in'
		})
	});
	html = await response.text();

	// 3. If the same login page comes back, InfoMentor rejected the
	//    credentials. surface their generic message verbatim.
	const loginError = parseLoginError(html);
	if (loginError) {
		throw new InfoMentorLoginError(loginError);
	}

	// 4. Walk any post-login relay pages back to hub.infomentor.se.
	relay = await followRelays(session, response, html);
	response = relay.response;
	html = relay.html;

	// 5. Confirm we're actually authenticated. A bare 200 from a
	//    misconfigured endpoint wouldn't prove anything; we check for
	//    the structural marker in the JSON body too.
	const appDataResponse = await session.request(APP_DATA_URL, { method: 'POST' });
	if (!appDataResponse.ok) {
		throw new InfoMentorLoginError(
			`post-login appData call returned ${appDataResponse.status} — login may have landed somewhere unexpected`
		);
	}
	// SAFETY: appData is the JSON-decoded body of InfoMentor's
	// consentViewConfig endpoint. We only need the presence of one
	// field to confirm auth, so we cast to a narrow owner contract
	// rather than a generic `Record<string, unknown>` (which the
	// anti-slop `no-unsafe-dictionary-type` rule rejects).
	const appData = (await appDataResponse.json()) as {
		consentViewConfig?: unknown;
	};
	if (appData.consentViewConfig === undefined) {
		throw new InfoMentorLoginError(
			'authenticated-looking response lacked the expected `consentViewConfig` field — flow may have changed'
		);
	}

	return { username, cookieJar: session.jar };
}
