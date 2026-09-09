import type { PageServerLoad } from './$types';
import { listLearnlogPage, listPupils } from '$lib/server/cache';

// Initial HTML contains four cached cards. No InfoMentor calls here.
export const load: PageServerLoad = () => ({
	pupils: listPupils(),
	initialPage: listLearnlogPage()
});
