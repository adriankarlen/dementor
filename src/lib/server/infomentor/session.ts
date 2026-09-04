// Session lifecycle for the dashboard. The "session" here is
// fundamentally just a random opaque token that the browser holds as
// an HttpOnly cookie; the server-side state is the InfoMentor cookie
// jar indexed by that token. There is no separate dashboard user
// account — the InfoMentor login IS the auth, and the session map
// just lets us remember which InfoMentor session belongs to which
// browser without round-tripping to a DB.
//
// Scope: a single `adapter-node` process. The map dies on server
// restart, which means everyone has to log in again — fine for a
// personal tool, since InfoMentor's own session would have triggered
// a re-prompt soon anyway.
import type { InfoMentorSession } from './types.ts';

const map = new Map<string, InfoMentorSession>();

export function attachSession(token: string, infoMentor: InfoMentorSession): void {
	map.set(token, infoMentor);
}

export function getSession(token: string): InfoMentorSession | undefined {
	return map.get(token);
}

/**
 * Touch the last-used timestamp on the entry. Reserved for future
 * idle-timeout semantics; the lazy reaper isn't wired up because
 * we've chosen "session lives until logout or restart" — but the hook
 * is here so callers (e.g. the hooks handler) can record activity
 * without needing to be changed later if we add a TTL.
 */
export function touchSession(token: string): void {
	const entry = map.get(token);
	if (entry) entry.lastUsedAt = new Date();
}

export function dropSession(token: string): void {
	map.delete(token);
}

export function mapSize(): number {
	return map.size;
}
