// Small helpers for parsing rows out of `node:sqlite`'s loose row
// type (`Record<string, SQLOutputValue>`) into the precise shapes the
// cache layer wants. Centralised here so the call sites don't repeat
// the schema declaration per query and so the `as` casts the anti-slop
// linter needs justification for live in one place.
//
// The pattern: each table has a row schema (arktype), and the parser
// validates each row against it. If validation fails we throw — the
// SQL and schema are owned by the same code, so a mismatch is a
// programming error, not bad data.
import { type, type Type } from 'arktype';
import type { SQLOutputValue } from 'node:sqlite';

export type SqliteRow = Record<string, SQLOutputValue>;

/** Unwrap an arktype parse result. Throws a descriptive error on failure. */
function unwrap<T>(result: T | type.errors, label: string): T {
	if (result instanceof type.errors) {
		throw new Error(`invalid ${label}: ${result.summary}`);
	}
	return result;
}

// ---- Row schemas ----
//
// One per table; mirrors the SELECT lists in cache.ts. arktype's
// structural types make the SELECT / schema pair self-documenting:
// a missing column or a wrong type surfaces as a parse error on the
// first read after a schema change, not as a silent null somewhere.

const PupilRowSchema = type({
	switch_id: 'number',
	display_name: 'string | null',
	last_seen_at: 'string'
});

const LearnlogRowSchema = type({
	pupil_switch_id: 'number',
	entry_id: 'number',
	json: 'string',
	synced_at: 'string',
	pupil_name: 'string | null'
});

const CalendarRowSchema = type({
	pupil_switch_id: 'number',
	entry_id: 'number',
	json: 'string',
	synced_at: 'string',
	pupil_name: 'string | null'
});

const NewsRowSchema = type({
	entry_id: 'number',
	json: 'string',
	synced_at: 'string'
});

const DocumentRowSchema = type({
	entry_id: 'number',
	json: 'string',
	synced_at: 'string'
});

const MaxIdRowSchema = type({
	max_id: 'number | null'
});

// ---- Public parsers ----

export interface ParsedPupil {
	switchId: number;
	displayName: string | null;
	lastSeenAt: string;
}

export function parsePupilRow(raw: SqliteRow): ParsedPupil {
	const r = unwrap(PupilRowSchema(raw), 'pupil row');
	return {
		switchId: r.switch_id,
		displayName: r.display_name,
		lastSeenAt: r.last_seen_at
	};
}

export interface ParsedLearnlog {
	pupilSwitchId: number;
	entryId: number;
	json: string;
	syncedAt: string;
	pupilName: string | null;
}

export function parseLearnlogRow(raw: SqliteRow): ParsedLearnlog {
	const r = unwrap(LearnlogRowSchema(raw), 'learnlog row');
	return {
		pupilSwitchId: r.pupil_switch_id,
		entryId: r.entry_id,
		json: r.json,
		syncedAt: r.synced_at,
		pupilName: r.pupil_name
	};
}

export interface ParsedCalendar {
	pupilSwitchId: number;
	entryId: number;
	json: string;
	syncedAt: string;
	pupilName: string | null;
}

export function parseCalendarRow(raw: SqliteRow): ParsedCalendar {
	const r = unwrap(CalendarRowSchema(raw), 'calendar row');
	return {
		pupilSwitchId: r.pupil_switch_id,
		entryId: r.entry_id,
		json: r.json,
		syncedAt: r.synced_at,
		pupilName: r.pupil_name
	};
}

export interface ParsedNews {
	entryId: number;
	json: string;
	syncedAt: string;
}

export function parseNewsRow(raw: SqliteRow): ParsedNews {
	const r = unwrap(NewsRowSchema(raw), 'news row');
	return {
		entryId: r.entry_id,
		json: r.json,
		syncedAt: r.synced_at
	};
}

export interface ParsedDocument {
	entryId: number;
	json: string;
	syncedAt: string;
}

export function parseDocumentRow(raw: SqliteRow): ParsedDocument {
	const r = unwrap(DocumentRowSchema(raw), 'document row');
	return {
		entryId: r.entry_id,
		json: r.json,
		syncedAt: r.synced_at
	};
}

/** Parse a `SELECT MAX(...)` row. Returns null if `max_id` is null. */
export function parseMaxIdRow(raw: SqliteRow): number | null {
	const r = unwrap(MaxIdRowSchema(raw), 'max-id row');
	return r.max_id;
}

// Re-export Type for callers that need to declare a schema locally.
export type { Type };
