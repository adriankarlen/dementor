#!/usr/bin/env node
// Probe script: confirms InfoMentor's username/password login flow works
// end to end, using your own real credentials, run locally.
//
// Why this exists now is mostly a smoke test for the login dance in
// `src/lib/server/infomentor/login.ts` — the actual dance lives there
// (single source of truth), and this script just calls it and prints a
// structural summary.
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

import { login } from '../src/lib/server/infomentor/login.ts';
import { InfoMentorLoginError } from '../src/lib/server/infomentor/errors.ts';

async function main(): Promise<void> {
	const username = process.env.INFOMENTOR_USERNAME;
	const password = process.env.INFOMENTOR_PASSWORD;
	if (!username || !password) {
		console.error('Set INFOMENTOR_USERNAME and INFOMENTOR_PASSWORD (e.g. via a local .env + `node --env-file=.env`).');
		process.exit(1);
	}

	let result;
	try {
		result = await login(username, password);
	} catch (err) {
		if (err instanceof InfoMentorLoginError) {
			console.error(`InfoMentor login failed: ${err.message}`);
		} else {
			console.error('Probe failed:', err instanceof Error ? err.message : err);
		}
		process.exit(1);
	}

	console.log('✅ InfoMentor username/password login flow confirmed end to end.');
	console.log(`   username: @${result.username}`);
	console.log(`   cookies acquired: ${result.cookieJar.dump().length}`);
}

main().catch((err: unknown) => {
	console.error('Probe failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
