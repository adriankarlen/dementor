// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			// Populated by src/hooks.server.ts from the in-memory
			// InfoMentor session map (see $lib/server/infomentor/session).
			// Null when there's no valid session cookie, or when the
			// session has been dropped (logout, server restart).
			infoMentor: { username: string } | null;
		}
		interface PageData {
			infoMentor: { username: string } | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
