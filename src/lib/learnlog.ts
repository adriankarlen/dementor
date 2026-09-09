import type { LearnlogEntry, LearnlogMedia } from './server/infomentor/api.ts';

/** Adapt attachments to the file cache without changing InfoMentor's download URLs. */
export function learnlogFiles(entry: LearnlogEntry): LearnlogMedia[] {
	return [
		...entry.media,
		...(entry.attachments ?? []).map((attachment) => ({
			fileId: attachment.fileId,
			fileType: attachment.fileType,
			fileExtension: attachment.extension,
			thumbnailUrl: '',
			fileUrl: attachment.downloadUrl
		}))
	];
}

/** Monthly letters may be named in the post title or only in an attached filename. */
export function isManadsbrev(entry: LearnlogEntry): boolean {
	const monthlyLetter = /m[åa]nadsbrev/i;
	return [entry.title, ...(entry.attachments ?? []).map((attachment) => attachment.fileName)].some(
		(name) => monthlyLetter.test(name.normalize('NFC'))
	);
}

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
