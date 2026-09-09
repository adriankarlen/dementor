import type { LearnlogEntry } from './server/infomentor/api.ts';

export interface CachedLearnlogEntry {
	pupilSwitchId: number;
	entryId: number;
	pupilName: string | null;
	json: LearnlogEntry;
	syncedAt: string;
}

export interface LearnlogCursor {
	entryId: number;
	pupilSwitchId: number;
}

export interface LearnlogPage {
	entries: CachedLearnlogEntry[];
	nextCursor: string | null;
	cachedMediaFileIds: number[];
}

export const LEARNLOG_PAGE_SIZE = 4;

export function parseLearnlogCursor(value: string | null): LearnlogCursor | null {
	if (value === null) return null;
	if (!/^\d+:\d+$/.test(value)) throw new Error('invalid cursor');
	const [entryId, pupilSwitchId] = value.split(':').map(Number);
	if (![entryId, pupilSwitchId].every((id) => Number.isSafeInteger(id) && id > 0)) {
		throw new Error('invalid cursor');
	}
	return { entryId, pupilSwitchId };
}
