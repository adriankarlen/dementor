// Public surface of the InfoMentor client. Everything outside
// `src/lib/server/infomentor/` should import from here rather than
// from individual files — keeps the module's internal layout free
// to change without rippling out.
export { login, type InfoMentorLoginResult } from './login.ts';
export { attachSession, getSession, touchSession, dropSession, mapSize } from './session.ts';
export { InfoMentorLoginError, InfoMentorSessionExpiredError } from './errors.ts';
export type { InfoMentorSession } from './types.ts';
export { createCookieJar, type CookieJar } from './cookieJar.ts';
export { createSession, type Session } from './httpClient.ts';
