import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLearnlogPage } from '$lib/server/cache';
import { parseLearnlogCursor } from '$lib/learnlog';

export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.infoMentor) error(401, 'no session');
	const cursor = url.searchParams.get('cursor');
	try {
		parseLearnlogCursor(cursor);
	} catch {
		error(400, 'invalid cursor');
	}
	return json(listLearnlogPage(cursor), { headers: { 'Cache-Control': 'private, no-store' } });
};
