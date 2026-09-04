// Small, regex-based helpers for scraping the two HTML shapes
// InfoMentor's login flow produces. Not a general HTML parser —
// deliberately narrow to what these two page types actually contain,
// confirmed against real responses on 2026-09-04 (see
// docs/api-notes.md and tools/probe-login.ts, which also used this).
const HTML_ENTITIES = new Map<string, string>([
	['&amp;', '&'],
	['&lt;', '<'],
	['&gt;', '>'],
	['&quot;', '"'],
	['&#39;', "'"]
]);

function decodeEntities(value: string): string {
	return value.replace(/&amp;|&lt;|&gt;|&quot;|&#39/g, (m) => HTML_ENTITIES.get(m) ?? m);
}

/**
 * True for InfoMentor's "relay" pages — an auto-submitting form
 * InfoMentor uses to hand a token off between hub.infomentor.se (IM2)
 * and infomentor.se (IM1), in either direction. Detected structurally
 * (a `<body onload="...submit()">`) rather than by a specific form id,
 * since we've only confirmed the hub→infomentor.se direction and don't
 * want to assume the reverse looks identical.
 */
export function isRelayPage(html: string): boolean {
	return /<body[^>]*\bonload="[^"]*\.submit\(\)[^"]*"/i.test(html);
}

interface ParsedForm {
	action: string;
	hiddenFields: Record<string, string>;
}

/**
 * Extracts the first <form>'s action and all of its hidden <input>
 * fields. Used both for the relay pages (just an action + one
 * oauth_token field) and for pulling __VIEWSTATE/__VIEWSTATEGENERATOR/
 * __EVENTVALIDATION off the real ASP.NET WebForms login page.
 */
export function parseFirstForm(html: string): ParsedForm | null {
	const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
	if (!formMatch) return null;
	const [, attrs, body] = formMatch;
	const actionMatch = /\baction="([^"]*)"/i.exec(attrs);
	const action = actionMatch ? decodeEntities(actionMatch[1]) : '';

	const hiddenFields: Record<string, string> = {};
	const inputRe = /<input\b[^>]*>/gi;
	let inputMatch: RegExpExecArray | null;
	while ((inputMatch = inputRe.exec(body))) {
		const tag = inputMatch[0];
		if (!/\btype="hidden"/i.test(tag)) continue;
		const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
		if (!name) continue;
		const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? '';
		hiddenFields[decodeEntities(name)] = decodeEntities(value);
	}
	return { action, hiddenFields };
}

/**
 * Pulls the login-failure message off InfoMentor's login page, if
 * present. The message text itself is generic ("check your
 * username/password"), not personal data, safe to print/log.
 */
export function parseLoginError(html: string): string | null {
	const match = /<span id="login_ascx_lblInnskraSkilabod"[^>]*>([^<]*)<\/span>/i.exec(html);
	return match ? decodeEntities(match[1]).trim() : null;
}

/** True if the page is InfoMentor's username/password login form. */
export function isLoginPage(html: string): boolean {
	return (
		html.includes('name="login_ascx$txtNotandanafn"') &&
		html.includes('name="login_ascx$txtLykilord"')
	);
}
