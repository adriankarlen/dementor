// Shared auth types. `passwordHash`/`passwordSalt` deliberately don't
// live here — they're write-only columns (server hashes once at user
// creation, never reads them back as User); they're typed only at the
// migration boundary. Anything reaching for the actual credentials is
// almost certainly a bug.

export interface User {
	id: number;
	username: string;
	displayName: string;
	createdAt: string;
}

export interface SessionInfo {
	token: string;
	expiresAt: Date;
}
