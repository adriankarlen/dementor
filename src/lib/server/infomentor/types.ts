// Public types for the InfoMentor client surface. The cookie jar's
// own internals stay in `cookieJar.ts`; this file is just the shape
// the rest of the app sees.
import type { CookieJar } from './cookieJar.ts';

export interface InfoMentorSession {
	username: string;
	cookieJar: CookieJar;
	loggedInAt: Date;
	lastUsedAt: Date;
}
