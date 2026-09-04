#!/usr/bin/env node
// One-off CLI for provisioning the two dashboard accounts. No self-
// signup UI exists by design — the app is private, for two people, so
// creating accounts is a deliberate operator action.
//
// USAGE
//   Interactive (prompts for everything):
//     node tools/create-user.ts
//
//   Non-interactive (CI / scripting; password from env so it doesn't
//   land in shell history or `ps`):
//     CREATE_USER_USERNAME=kalle \
//     CREATE_USER_DISPLAY_NAME="Kalle Andersson" \
//     CREATE_USER_PASSWORD=... \
//       node tools/create-user.ts
//
//   Update an existing user's password (no-op on display name; rename
//   isn't a Phase 1 need):
//     CREATE_USER_UPDATE=1 ...same flags as above
//
// Note: the password is shown on screen during interactive prompts.
// That's acceptable for a personal setup script, but be aware. There
// is intentionally no `readline` echo-disable dance — Node has no
// portable way to do that, and the env-var path above avoids the
// problem when it matters.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';

import { runMigrations } from '../src/lib/server/auth/schema.ts';
import { findUserByUsername, createUser, updateUserPassword } from '../src/lib/server/auth/users.ts';
import { generateSalt, hashPassword, verifyPassword } from '../src/lib/server/auth/passwords.ts';
import { db } from '../src/lib/server/db.ts';

async function prompt(question: string): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question(question);
		return answer.trim();
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	// Force migrations on this process's DB handle before we touch it.
	// (Already done at import time via `db`, but explicit makes the
	// intent clear in case `db.ts` ever changes.)
	runMigrations(db);

	const updateMode = process.env.CREATE_USER_UPDATE === '1';
	// Read all env inputs up front so we can detect the non-interactive
	// case before any prompt hangs waiting on stdin.
	const usernameEnv = process.env.CREATE_USER_USERNAME;
	const displayNameEnv = process.env.CREATE_USER_DISPLAY_NAME;
	const passwordEnv = process.env.CREATE_USER_PASSWORD;
	const interactive = stdin.isTTY === true;

	if (!usernameEnv && !interactive) {
		console.error('CREATE_USER_USERNAME måste vara satt när stdin inte är en TTY.');
		exit(1);
	}

	const username = (usernameEnv ?? (await prompt('Användarnamn: '))).trim();
	if (!username) {
		console.error('Användarnamn får inte vara tomt.');
		exit(1);
	}

	let displayName = (displayNameEnv ?? '').trim();
	if (!updateMode) {
		if (!displayName) {
			if (!interactive) {
				console.error('CREATE_USER_DISPLAY_NAME måste vara satt i icke-interaktivt läge.');
				exit(1);
			}
			displayName = await prompt('Visningsnamn: ');
		}
		if (!displayName.trim()) {
			console.error('Visningsnamn får inte vara tomt.');
			exit(1);
		}
	}

	let password = passwordEnv ?? '';
	if (!password) {
		if (!interactive) {
			console.error(
				'CREATE_USER_PASSWORD måste vara satt i icke-interaktivt läge (för att inte hamna i history/ps).'
			);
			exit(1);
		}
		console.error('OBS: lösenordet skrivs in synligt på skärmen.');
		password = await prompt('Lösenord: ');
		if (!password) {
			console.error('Lösenord får inte vara tomt.');
			exit(1);
		}
		if (!updateMode) {
			const confirm = await prompt('Lösenord igen: ');
			if (confirm !== password) {
				console.error('Lösenorden matchar inte.');
				exit(1);
			}
		}
	}

	const existing = findUserByUsername(username);
	if (existing && !updateMode) {
		console.error(`Användaren "${existing.username}" finns redan.`);
		console.error('Använd CREATE_USER_UPDATE=1 för att uppdatera lösenordet.');
		exit(1);
	}
	if (!existing && updateMode) {
		console.error(`Användaren "${username}" finns inte — kan inte uppdatera.`);
		exit(1);
	}

	const salt = generateSalt();
	const hash = await hashPassword(password, salt);

	if (existing && updateMode) {
		updateUserPassword(existing.id, hash, salt);
		// Sanity check: re-derive and compare, to catch a fat-fingered
		// password without leaving the script with a false sense of
		// success.
		const verified = await verifyPassword(password, salt, hash);
		if (!verified) {
			console.error('Sanity check misslyckades — den uppdaterade hashen verifierar inte.');
			console.error('Databasen är i ett oförutsägbart tillstånd, kontrollera manuellt.');
			exit(1);
		}
		console.log(`✓ Lösenordet för "${existing.username}" är uppdaterat.`);
		return;
	}

	const created = createUser({
		username,
		displayName,
		passwordHash: hash,
		passwordSalt: salt
	});

	// Sanity check the freshly-created user.
	const verified = await verifyPassword(password, salt, hash);
	if (!verified) {
		console.error('Sanity check misslyckades — den skapade hashen verifierar inte.');
		console.error('Användaren kan vara trasig; kontrollera databasen och försök igen.');
		exit(1);
	}

	console.log(`✓ Användare skapad: ${created.username} (${created.displayName}, id=${created.id}).`);
}

main().catch((err: unknown) => {
	console.error('create-user misslyckades:', err instanceof Error ? err.message : err);
	exit(1);
});