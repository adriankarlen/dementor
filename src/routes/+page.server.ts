// Home redirects to Lärlogg — that's the section the dashboard
// exists to make faster than InfoMentor's own UI, per the project's
// "what we're consuming from it" description in AGENTS.md.
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(303, '/larLogg');
};
