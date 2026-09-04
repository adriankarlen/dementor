#!/usr/bin/env node
// Probe script: confirms InfoMentor's username/password login flow works
// end to end, using your own real credentials, run locally.
//
// WHY THIS EXISTS
// AGENTS.md flags the password login flow as unconfirmed. Everything up
// to "submit the login form" below has already been confirmed safely,
// without any real credentials, by fetching the real pages and trying a
// deliberately wrong login (see the flow notes at the bottom of this
// file). What hasn't been confirmed yet is what happens on a *successful*
// login — that needs your real credentials, which is why this runs on
// your machine rather than being explored in chat.
//
// USAGE
//   1. Create a local `.env` file (gitignored) in the repo root:
//        INFOMENTOR_USERNAME=your-username
//        INFOMENTOR_PASSWORD=your-password
//   2. Run (Node 22.6+ needed for TS support; this repo was tested on
//      Node 24, which runs .ts files directly with no build step):
//        node --env-file=.env tools/probe-login.ts
//
// OUTPUT
// Only structural information is printed — status codes, hostnames,
// field names, generic error text. It does not print page bodies, your
// credentials, or personal data, so it's safe to paste back for
// discussion.

import { createSession } from "./lib/httpClient.ts";
import { isRelayPage, parseFirstForm, parseLoginError, isLoginPage } from "./lib/htmlForms.ts";

const HUB_ROOT = "https://hub.infomentor.se/";
const APP_DATA_URL = "https://hub.infomentor.se/communication/communication/appData";
const MAX_RELAY_HOPS = 5;

function log(...args: unknown[]) {
  console.log(...args);
}

interface RelayResult {
  response: Response;
  html: string;
}

// `html` may be passed in when the caller already read the body (Response
// bodies can only be consumed once — no re-reading via .clone() after the
// fact, that throws "Body has already been consumed").
async function followRelays(session: ReturnType<typeof createSession>, initial: Response, initialHtml?: string): Promise<RelayResult> {
  let response = initial;
  let html = initialHtml ?? (await response.text());

  for (let hop = 0; hop < MAX_RELAY_HOPS; hop++) {
    if (!isRelayPage(html)) return { response, html };

    const form = parseFirstForm(html);
    if (!form) throw new Error("Relay page detected but no <form> found — page shape changed, needs re-investigation.");

    const actionUrl = new URL(form.action, response.url).href;
    log(`  relay hop ${hop + 1}: POST ${new URL(actionUrl).hostname}${new URL(actionUrl).pathname} (fields: ${Object.keys(form.hiddenFields).join(", ")})`);

    response = await session.request(actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form.hiddenFields),
    });
    html = await response.text();
  }
  throw new Error(`Followed ${MAX_RELAY_HOPS} relay hops without landing anywhere — likely a loop, needs re-investigation.`);
}

async function main() {
  const username = process.env.INFOMENTOR_USERNAME;
  const password = process.env.INFOMENTOR_PASSWORD;
  if (!username || !password) {
    console.error("Set INFOMENTOR_USERNAME and INFOMENTOR_PASSWORD (e.g. via a local .env + `node --env-file=.env`).");
    process.exit(1);
  }

  const session = createSession();

  log("1. GET hub.infomentor.se (expect a redirect into the login flow)");
  let response = await session.request(HUB_ROOT);
  log(`   landed on: ${new URL(response.url).hostname}${new URL(response.url).pathname} [${response.status}]`);

  log("2. Following any auto-submit relay pages...");
  let relayResult = await followRelays(session, response);
  response = relayResult.response;
  let html = relayResult.html;
  log(`   landed on: ${new URL(response.url).hostname}${new URL(response.url).pathname} [${response.status}]`);

  if (!isLoginPage(html)) {
    console.error("Did not land on the expected username/password login page — InfoMentor's flow may have changed. Structural details only:");
    console.error(`  status: ${response.status}, url: ${response.url}, looks-like-relay: ${isRelayPage(html)}`);
    process.exit(1);
  }
  log("   confirmed: this is the username/password login page (login_ascx fields present)");

  const form = parseFirstForm(html);
  if (!form) throw new Error("Login page had no parseable <form> — needs re-investigation.");

  log("3. Submitting credentials...");
  const loginActionUrl = new URL(form.action || response.url, response.url).href;
  response = await session.request(loginActionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...form.hiddenFields,
      "login_ascx$txtNotandanafn": username,
      "login_ascx$txtLykilord": password,
      "login_ascx$btnLogin": "Logga in",
    }),
  });
  html = await response.text();
  log(`   response: ${response.status} from ${new URL(response.url).hostname}`);

  const loginError = parseLoginError(html);
  if (loginError) {
    console.error(`Login rejected by InfoMentor: "${loginError}"`);
    console.error("(This is InfoMentor's own generic message — check the credentials in .env.)");
    process.exit(1);
  }

  log("4. Following any post-login relay pages...");
  relayResult = await followRelays(session, response, html);
  response = relayResult.response;
  html = relayResult.html;
  log(`   landed on: ${new URL(response.url).hostname}${new URL(response.url).pathname} [${response.status}]`);

  log("5. Confirming the session is actually authenticated (POST appData)...");
  const appDataResponse = await session.request(APP_DATA_URL, { method: "POST" });
  log(`   appData response: ${appDataResponse.status}`);
  if (!appDataResponse.ok) {
    console.error("appData call failed — login may have redirected somewhere unexpected. Not necessarily fatal, but needs a look.");
    process.exit(1);
  }
  const appData = (await appDataResponse.json()) as Record<string, unknown>;
  const hasConsentConfig = typeof appData === "object" && appData !== null && "consentViewConfig" in appData;
  log(`   appData JSON parsed OK, has consentViewConfig: ${hasConsentConfig}`);

  if (hasConsentConfig) {
    log("\n✅ Username/password login flow confirmed end to end.");
  } else {
    log("\n⚠️  Reached an authenticated-looking response, but the shape differs from what docs/api-notes.md expects — worth a manual look before building on it.");
  }
}

main().catch((err) => {
  console.error("Probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

/*
 * FLOW NOTES (confirmed 2026-09-04, without using any real credentials)
 *
 * 1. GET https://hub.infomentor.se/ → 302 → /Authentication/Authentication/Login?ReturnUrl=%2F
 * 2. That page's body is an auto-submitting relay form:
 *      <form id="openid_message" action="https://infomentor.se/swedish/production/mentor/" method="post">
 *        <input type="hidden" name="oauth_token" value="..." />
 *      </form>
 *    (fresh oauth_token per request — do not hardcode it)
 * 3. POSTing that lands on the real login page: a classic ASP.NET
 *    WebForms page (__VIEWSTATE/__VIEWSTATEGENERATOR/__EVENTVALIDATION)
 *    with fields:
 *      login_ascx$txtNotandanafn   (username)
 *      login_ascx$txtLykilord      (password)
 *      login_ascx$btnLogin         (submit button, value "Logga in")
 *    posting back to the same URL ("action=./").
 * 4. Confirmed (with a deliberately wrong username/password, not a real
 *    account) that submitting this form is recognized and validated by
 *    the server: it re-renders the same page with
 *      <span id="login_ascx_lblInnskraSkilabod" class="error-message ...">
 *        Inloggning misslyckades - vänligen kontrollera användarnamn och
 *        lösenord eller kontakta skolan.
 *      </span>
 *    This proves the field names/action/anti-forgery tokens are right —
 *    what's NOT yet confirmed is what a *successful* login does (redirect
 *    target, whether it relays back to hub.infomentor.se the same way it
 *    relayed out). That's what this script confirms when run with real
 *    credentials.
 */
