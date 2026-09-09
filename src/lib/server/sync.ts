// Section sync writes a rebuildable SQLite cache. All remote pupil switches
// and their dependent reads must share the per-session queue.
import type { CookieJar } from './infomentor/cookieJar.ts';
import {
	calendarWindowForToday,
	discoverPupils,
	getCalendarAppData,
	getCalendarEntries,
	getDocuments,
	getNews,
	switchPupil
} from './infomentor/api.ts';
import { InfoMentorSessionExpiredError } from './infomentor/errors.ts';
import {
	listPupils,
	replaceDocuments,
	replaceNewsEntries,
	setCachedCalendarEntryTypes,
	upsertCalendarEntries,
	upsertPupil
} from './cache.ts';
import { withInfoMentorSession } from './infomentor/queue.ts';
import { syncLearnlogMetadata, type LearnlogSyncSummary } from './learnlog-sync.ts';

export async function syncLearnlog(
	jar: CookieJar,
	pupilSwitchIds?: number[],
	onProgress?: (summary: LearnlogSyncSummary) => void,
	isActive?: () => boolean
): Promise<LearnlogSyncSummary> {
	const ids = await resolvePupilIds(jar, pupilSwitchIds);
	return syncLearnlogMetadata(jar, ids, onProgress, isActive);
}

export async function syncCalendar(
	jar: CookieJar,
	pupilSwitchIds?: number[]
): Promise<{ pupils: number; entries: number }> {
	const ids = await resolvePupilIds(jar, pupilSwitchIds);
	const { startDate, endDate } = calendarWindowForToday();
	let total = 0;
	for (const id of ids) {
		await withInfoMentorSession(jar, async () => {
			await switchPupil(jar, id);
			const entries = await getCalendarEntries(jar, startDate, endDate);
			upsertCalendarEntries(id, entries);
			total += entries.length;
		});
	}
	return { pupils: ids.length, entries: total };
}

export async function syncNews(jar: CookieJar): Promise<{ items: number }> {
	return withInfoMentorSession(jar, async () => {
		const result = await getNews(jar);
		replaceNewsEntries(result.items ?? []);
		return { items: result.items?.length ?? 0 };
	});
}

export async function syncDocuments(jar: CookieJar): Promise<{ items: number }> {
	return withInfoMentorSession(jar, async () => {
		const result = await getDocuments(jar, 1, 50);
		replaceDocuments(result.items ?? []);
		return { items: result.items?.length ?? 0 };
	});
}

export async function refreshPupils(
	jar: CookieJar
): Promise<{ switchId: number; displayName: string | null }[]> {
	return withInfoMentorSession(jar, async () => {
		const discovered = await discoverPupils(jar);
		for (const pupil of discovered) upsertPupil(pupil.switchId, pupil.displayName);
		return discovered;
	});
}

async function resolvePupilIds(jar: CookieJar, override: number[] | undefined): Promise<number[]> {
	if (override) return [...new Set(override)];
	const cached = listPupils().map((pupil) => pupil.switchId);
	if (cached.length > 0) return cached;
	return (await refreshPupils(jar)).map((pupil) => pupil.switchId);
}

export async function refreshCalendarEntryTypes(jar: CookieJar): Promise<void> {
	await withInfoMentorSession(jar, async () => {
		try {
			const appData = await getCalendarAppData(jar);
			setCachedCalendarEntryTypes(appData.calendarEntryTypes ?? []);
		} catch (err) {
			if (err instanceof InfoMentorSessionExpiredError) throw err;
			setCachedCalendarEntryTypes([]);
		}
	});
}

export async function syncAll(jar: CookieJar) {
	await refreshPupils(jar);
	await refreshCalendarEntryTypes(jar);
	const pupils = listPupils().map((pupil) => pupil.switchId);
	const learnlog = await syncLearnlog(jar, pupils);
	const calendar = await syncCalendar(jar, pupils);
	const news = await syncNews(jar);
	const documents = await syncDocuments(jar);
	return { pupils: pupils.length, learnlog, calendar, news, documents };
}
