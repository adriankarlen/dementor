// Password hashing using Node's built-in scrypt — no extra dependency,
// meets AGENTS.md's "build on node:crypto" preference for crypto code.
//
// Format: a per-user random salt (hex) is generated at user-creation
// time and stored alongside the hash; the hash itself is also stored as
// hex. Verification re-derives the hash with the same salt and
// compares with timingSafeEqual. We don't use a self-contained encoded
// string (e.g. `$scrypt$...$`) because there's no need: salt and hash
// live in their own columns, and we never serialise the credential.
//
// Node's scrypt derives a key with the params N, r, p (cost). We use
// the defaults (N=16384, r=8, p=1, keylen=64). maxmem is left at
// Node's default — that's 32 MiB, comfortably above scrypt's ~16 MiB
// peak for the cost we picked.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const KEY_BYTES = 64;

export interface PasswordRecord {
	hash: string; // hex
	salt: string; // hex
}

export function generateSalt(): string {
	return randomBytes(16).toString('hex');
}

export async function hashPassword(password: string, salt: string): Promise<string> {
	// SAFETY: promisified scrypt returns Buffer (Node's
	// NonSharedBuffer) per the callback's declared type.
	const buf = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
	return buf.toString('hex');
}

export async function verifyPassword(
	password: string,
	salt: string,
	expectedHash: string
): Promise<boolean> {
	const computed = await hashPassword(password, salt);
	// Both strings are hex (so byte length matches KEY_BYTES × 2), so
	// timingSafeEqual on the decoded buffers is meaningful. If they
	// differ in length (shouldn't happen for stored rows) bail out
	// without comparing to avoid an exception.
	const a = Buffer.from(computed, 'hex');
	const b = Buffer.from(expectedHash, 'hex');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
