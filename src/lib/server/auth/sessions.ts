// Session lifecycle: create a fresh opaque token, look it up to
// authenticate a request, delete it on logout or when expired.
//
// Tokens are 32 random bytes hex-encoded — 256 bits of entropy, the
// only thing the cookie carries, so the cookie itself doesn't need to
// be signed (a stolen cookie IS the credential, no forgery vector).
// That's the simpler-than-JWT scheme the implementation plan called
// for: validity is a DB lookup keyed on the token.
//
// TTL is 30 days, refreshed by re-login. We don't bother cleaning up
// expired rows from the DB — `lookupSession` treats expiry as "not
// logged in" and deletes the row lazily on hit, so the only cost of
// leaving them is a few stale index entries.
import { randomBytes } from 'node:crypto';

import { db } from '../db.ts';
import { findUserById } from './users.ts';
import type { User } from './types.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionRow {
	token: string;
	user_id: number;
	expires_at: string;
	created_at: string;
}

interface JoinedRow extends SessionRow {
	user_id_u: number;
	user_username: string;
	user_display_name: string;
	user_created_at: string;
}

const insertSession = db.prepare(
	'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
);
const findSessionWithUser = db.prepare(`
	SELECT
		s.token         AS token,
		s.user_id       AS user_id,
		s.expires_at    AS expires_at,
		s.created_at    AS created_at,
		u.id            AS user_id_u,
		u.username      AS user_username,
		u.display_name  AS user_display_name,
		u.created_at    AS user_created_at
	FROM sessions s
	JOIN users u ON u.id = s.user_id
	WHERE s.token = ?
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

export interface CreatedSession {
	token: string;
	expiresAt: Date;
}

export function createSession(userId: number): CreatedSession {
	const token = randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	insertSession.run(token, userId, expiresAt.toISOString());
	return { token, expiresAt };
}

export interface ResolvedSession {
	user: User;
	expiresAt: Date;
}

export function lookupSession(token: string): ResolvedSession | undefined {
	// SAFETY: SELECT aliases match JoinedRow keys 1:1; missing row
	// is represented by `undefined` per node:sqlite's StatementSync.get.
	const row = findSessionWithUser.get(token) as JoinedRow | undefined;
	if (!row) return undefined;
	const expiresAt = new Date(row.expires_at);
	if (expiresAt.getTime() <= Date.now()) {
		// Lazy cleanup — the row is dead, drop it now rather than
		// waiting for some sweeper that would otherwise be needed.
		deleteSession.run(token);
		return undefined;
	}
	const user = findUserById(row.user_id_u);
	if (!user) {
		// FK ON DELETE CASCADE should make this unreachable, but if
		// it's ever reachable we'd rather treat the session as invalid
		// than crash. Defensive.
		deleteSession.run(token);
		return undefined;
	}
	return { user, expiresAt };
}

export function dropSession(token: string): void {
	deleteSession.run(token);
}

export function sessionTtlMs(): number {
	return SESSION_TTL_MS;
}
