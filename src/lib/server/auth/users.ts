// User CRUD: create + lookup. Per AGENTS.md this is a tiny DB, so we
// keep it inline rather than abstracting it. The only non-obvious bit
// is `username COLLATE NOCASE` in the lookup query — the UNIQUE
// constraint on the column carries that collation too, so two accounts
// can't be created with different cases of the same name. We still
// normalise the value we store to make the on-disk representation
// predictable.
import { db } from '../db.ts';
import type { User } from './types.ts';

interface UserRow {
	id: number;
	username: string;
	display_name: string;
	created_at: string;
}

interface CredentialsRow extends UserRow {
	password_hash: string;
	password_salt: string;
}

function rowToUser(row: UserRow): User {
	return {
		id: row.id,
		username: row.username,
		displayName: row.display_name,
		createdAt: row.created_at
	};
}

const findByIdStmt = db.prepare(
	'SELECT id, username, display_name, created_at FROM users WHERE id = ?'
);
const findByUsernameStmt = db.prepare(
	'SELECT id, username, display_name, created_at FROM users WHERE username = ? COLLATE NOCASE'
);
const findCredentialsByUsernameStmt = db.prepare(
	'SELECT id, username, display_name, password_hash, password_salt, created_at FROM users WHERE username = ? COLLATE NOCASE'
);
const insertStmt = db.prepare(
	'INSERT INTO users (username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)'
);
const updatePasswordStmt = db.prepare(
	'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?'
);

export function findUserById(id: number): User | undefined {
	// SAFETY: SELECT column list matches UserRow keys 1:1; missing row
	// is represented by `undefined` per node:sqlite's StatementSync.get.
	const row = findByIdStmt.get(id) as UserRow | undefined;
	return row ? rowToUser(row) : undefined;
}

export function findUserByUsername(username: string): User | undefined {
	// SAFETY: same SELECT-to-UserRow mapping as findUserById.
	const row = findByUsernameStmt.get(username) as UserRow | undefined;
	return row ? rowToUser(row) : undefined;
}

export function findCredentialsByUsername(username: string): CredentialsRow | undefined {
	// SAFETY: SELECT column list matches CredentialsRow keys 1:1; same
	// get()-returns-undefined-on-miss contract as above.
	return findCredentialsByUsernameStmt.get(username) as CredentialsRow | undefined;
}

export function updateUserPassword(
	userId: number,
	passwordHash: string,
	passwordSalt: string
): void {
	updatePasswordStmt.run(passwordHash, passwordSalt, userId);
}

export interface CreateUserInput {
	username: string;
	displayName: string;
	passwordHash: string;
	passwordSalt: string;
}

export function createUser(input: CreateUserInput): User {
	const result = insertStmt.run(
		input.username,
		input.displayName,
		input.passwordHash,
		input.passwordSalt
	);
	const id = Number(result.lastInsertRowid);
	const created = findUserById(id);
	if (!created) throw new Error('user row missing immediately after insert');
	return created;
}

export type { CredentialsRow };
