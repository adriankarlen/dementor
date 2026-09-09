#!/usr/bin/env node
// Benchmark script: times `getlearnlogs` at different pageSize values
// against your real InfoMentor account, to answer a concrete question —
// is a bigger pageSize (10, what `syncLearnlog` currently uses)
// actually slower per-request than the small pageSize (2) InfoMentor's
// own web app uses? Confirmed capture data (captures/) shows their app
// paginating genuinely (distinct small responses per page), so the
// endpoint itself isn't secretly dumping everything — this script
// exists to settle the *timing* question, which a static capture can't
// answer.
//
// Read-only: every request here is a plain GET on `getlearnlogs`, no
// state-changing calls. Safe to run repeatedly.
//
// USAGE
//   1. Local `.env` (gitignored) in the repo root:
//        INFOMENTOR_USERNAME=your-username
//        INFOMENTOR_PASSWORD=your-password
//   2. Run:
//        node --env-file=.env tools/bench-learnlog.ts
//   3. Optional: pass a pupil switchId as the first CLI arg to skip
//      pupil discovery (`discoverPupils` scrapes the pupil-switcher
//      links out of hub.infomentor.se's landing page — if that page
//      shape doesn't match, discovery comes back empty even though
//      you're logged in fine):
//        node --env-file=.env tools/bench-learnlog.ts 3887588
//      The switchId is the numeric id from a
//      `/Account/PupilSwitcher/SwitchPupil/{id}` link — grab it from
//      your browser's devtools network tab (or the address bar if
//      InfoMentor's UI ever exposes it directly).
//
// OUTPUT
// Only structural/timing information — status codes, byte counts,
// elapsed milliseconds, entry counts. No entry text, titles, or media
// URLs are printed.
import { login } from '../src/lib/server/infomentor/login.ts';
import { InfoMentorLoginError } from '../src/lib/server/infomentor/errors.ts';
import { createSession } from '../src/lib/server/infomentor/httpClient.ts';
import { discoverPupils, switchPupil, HUB_ROOT } from '../src/lib/server/infomentor/api.ts';
import type { CookieJar } from '../src/lib/server/infomentor/cookieJar.ts';

interface TimedResult {
	pageSize: number;
	pageNumber: number;
	ms: number;
	status: number;
	bytes: number;
	itemCount: number | null;
}

async function timedGetLearnlogs(
	jar: CookieJar,
	pageNumber: number,
	pageSize: number
): Promise<TimedResult> {
	const session = createSession(jar);
	const url = `${HUB_ROOT}learnlog/learnlog/getlearnlogs?learnLogType=0&pageNumber=${pageNumber}&pageSize=${pageSize}`;
	const start = performance.now();
	const response = await session.request(url);
	const text = await response.text();
	const ms = performance.now() - start;

	let itemCount: number | null = null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) itemCount = parsed.length;
	} catch {
		// leave itemCount null — status/bytes below still tell the story
	}

	return {
		pageSize,
		pageNumber,
		ms: Math.round(ms),
		status: response.status,
		bytes: text.length,
		itemCount
	};
}

function printTable(results: TimedResult[]): void {
	console.log(
		'pageSize'.padEnd(9),
		'pageNumber'.padEnd(11),
		'ms'.padEnd(7),
		'status'.padEnd(7),
		'bytes'.padEnd(8),
		'items'
	);
	for (const r of results) {
		console.log(
			String(r.pageSize).padEnd(9),
			String(r.pageNumber).padEnd(11),
			String(r.ms).padEnd(7),
			String(r.status).padEnd(7),
			String(r.bytes).padEnd(8),
			String(r.itemCount ?? '?')
		);
	}
}

async function main(): Promise<void> {
	const username = process.env.INFOMENTOR_USERNAME;
	const password = process.env.INFOMENTOR_PASSWORD;
	if (!username || !password) {
		console.error(
			'Set INFOMENTOR_USERNAME and INFOMENTOR_PASSWORD (e.g. via a local .env + `node --env-file=.env`).'
		);
		process.exit(1);
	}

	let jar: CookieJar;
	try {
		const result = await login(username, password);
		jar = result.cookieJar;
	} catch (err) {
		if (err instanceof InfoMentorLoginError) {
			console.error(`InfoMentor login failed: ${err.message}`);
		} else {
			console.error('Login failed:', err instanceof Error ? err.message : err);
		}
		process.exit(1);
		return;
	}
	console.log('✅ logged in');

	let switchId: number;
	const argSwitchId = process.argv[2];
	if (argSwitchId !== undefined) {
		switchId = Number(argSwitchId);
		if (!Number.isInteger(switchId) || switchId <= 0) {
			console.error(`Invalid pupil switchId argument: ${JSON.stringify(argSwitchId)}`);
			process.exit(1);
			return;
		}
		console.log(`\u2139\ufe0f using pupil switchId=${switchId} from CLI arg (skipped discovery)`);
	} else {
		const pupils = await discoverPupils(jar);
		if (pupils.length === 0) {
			console.error(
				'No pupils discovered and no switchId argument given. ' +
					'Pass one explicitly: node --env-file=.env tools/bench-learnlog.ts <switchId> ' +
					'(find it in a /Account/PupilSwitcher/SwitchPupil/{id} link via your browser devtools).'
			);
			process.exit(1);
			return;
		}
		switchId = pupils[0].switchId;
		console.log(`\u2139\ufe0f discovered ${pupils.length} pupil(s), using switchId=${switchId}`);
	}
	await switchPupil(jar, switchId);
	console.log(`\u2705 switched to pupil switchId=${switchId}`);

	// Round 1: same pageNumber=1 at increasing pageSize. Answers
	// "does a bigger page cost more per request?" for a FIXED offset.
	console.log('\n--- fixed pageNumber=1, varying pageSize ---');
	const sizesResults: TimedResult[] = [];
	for (const pageSize of [2, 5, 10, 25, 50]) {
		// Sequential on purpose — this is exactly the access pattern
		// `syncLearnlog` uses (one request at a time against a single
		// session), and concurrent requests on the same cookie jar risk
		// InfoMentor's server-side "current pupil" state stepping on
		// itself.
		const r = await timedGetLearnlogs(jar, 1, pageSize);
		sizesResults.push(r);
	}
	printTable(sizesResults);

	// Round 2: fixed pageSize=2 (matches InfoMentor's own app),
	// increasing pageNumber. Answers "does a deeper OFFSET cost more,
	// independent of page size?" — if per-request time climbs with
	// pageNumber even though pageSize never changes, that points to
	// the backend re-scanning from the start on every call (an
	// OFFSET-without-index pattern), which would mean total sync time
	// is dominated by REQUEST COUNT, not bytes-per-request — the
	// opposite conclusion from round 1's likely finding.
	console.log('\n--- fixed pageSize=2, varying pageNumber ---');
	const depthResults: TimedResult[] = [];
	for (const pageNumber of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const r = await timedGetLearnlogs(jar, pageNumber, 2);
		depthResults.push(r);
	}
	printTable(depthResults);

	// Round 3: repeat pageNumber=1, pageSize=10 (today's actual
	// `syncLearnlog` request) a few times, to see typical variance —
	// a single sample from rounds 1/2 could just be a slow outlier.
	console.log('\n--- repeat: pageNumber=1, pageSize=10 (current syncLearnlog shape) x5 ---');
	const repeatResults: TimedResult[] = [];
	for (let i = 0; i < 5; i++) {
		repeatResults.push(await timedGetLearnlogs(jar, 1, 10));
	}
	printTable(repeatResults);

	console.log(
		'\nDone. Paste this output back — it only contains status codes, byte counts, timings, and item counts.'
	);
}

main().catch((err: unknown) => {
	console.error('Benchmark failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
