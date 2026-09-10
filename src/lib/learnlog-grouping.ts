import { isManadsbrev, type CachedLearnlogEntry } from './learnlog.ts';

export interface GroupedLearnlogEntry {
	entry: CachedLearnlogEntry;
	sourceCount: number;
}

function normalizeLabel(value: string): string {
	return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv');
}

function activityKey(entry: CachedLearnlogEntry): string | null {
	const title = normalizeLabel(entry.json.title);
	// Monthly letters keep their separate, cross-pupil deduplication rules.
	if (!title || isManadsbrev(entry.json)) return null;
	// lastModifiedOn is Swedish display text, not a machine-readable timestamp.
	// Unknown formats stay separate rather than guessing which day they belong to.
	const date = normalizeLabel(entry.json.lastModifiedOn).match(
		/^den (\d{1,2} (?:januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december) \d{4}) klockan \d{1,2}:\d{2}$/
	)?.[1];
	if (!date) return null;
	return JSON.stringify([entry.pupilSwitchId, normalizeLabel(entry.json.groupName), date, title]);
}

function bodyKey(html: string): string {
	// The editor can leave an empty paragraph behind. Strip only layout tags to
	// detect this; an embedded image, link or other content must not be discarded.
	const content = html
		.replace(/<\/?(?:p|div|span|br)\b[^>]*>/gi, '')
		.replace(/&nbsp;|&#160;|&#xa0;/gi, '')
		.trim();
	return content ? html.normalize('NFC').trim() : '';
}

/**
 * Presentation-only grouping, in feed order (newest first). Call with all loaded
 * pages together so an activity can span a pagination boundary. Cached records,
 * IDs and download URLs stay untouched. Conflicting bodies leave the whole
 * candidate group separate: we cannot know which text an uncaptioned photo uses.
 */
export function groupLearnlogEntries(entries: CachedLearnlogEntry[]): GroupedLearnlogEntry[] {
	const buckets = new Map<string, CachedLearnlogEntry[]>();
	const rows = new Map<CachedLearnlogEntry, GroupedLearnlogEntry>();
	for (const entry of entries) {
		rows.set(entry, { entry, sourceCount: 1 });
		const key = activityKey(entry);
		if (key === null) continue;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(entry);
		else buckets.set(key, [entry]);
	}

	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		const bodies = new Map<string, string>();
		for (const entry of bucket) {
			const key = bodyKey(entry.json.text);
			if (key) bodies.set(key, entry.json.text);
		}
		if (bodies.size > 1) continue;

		const canonical = bucket[0];
		const media = bucket.flatMap((entry) => entry.json.media);
		const attachments = bucket.flatMap((entry) => entry.json.attachments ?? []);
		const merged: CachedLearnlogEntry = {
			...canonical,
			json: {
				...canonical.json,
				text: bodies.values().next().value ?? canonical.json.text,
				media: [...new Map(media.map((file) => [file.fileId, file])).values()],
				attachments: [...new Map(attachments.map((file) => [file.fileId, file])).values()]
			}
		};
		for (const entry of bucket) rows.delete(entry);
		rows.set(canonical, { entry: merged, sourceCount: bucket.length });
	}

	return entries.flatMap((entry) => {
		const row = rows.get(entry);
		return row ? [row] : [];
	});
}
