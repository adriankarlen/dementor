// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { User } from '$lib/server/auth/types.ts';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			// Populated by src/hooks.server.ts. Null when the request is
			// unauthenticated (e.g. the login page itself).
			user: User | null;
		}
		interface PageData {
			user: User | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
