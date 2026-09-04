// Typed errors for the InfoMentor client. The login dance throws
// `InfoMentorLoginError` on a bad password / changed flow / etc.
// Once authenticated, `InfoMentorSessionExpiredError` is thrown by
// any API call whose response indicates InfoMentor's own session
// cookie has died — the frontend catches it and shows a re-auth
// prompt without dropping the dashboard session.

export class InfoMentorLoginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InfoMentorLoginError';
	}
}

export class InfoMentorSessionExpiredError extends Error {
	constructor() {
		super('InfoMentor session has expired');
		this.name = 'InfoMentorSessionExpiredError';
	}
}
