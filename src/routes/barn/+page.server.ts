// Manage pupils: list the cached pupils (from auto-discovery or
// manual entry) and let the user add/remove them by switchId. The
// "add" path is the only reliable way to populate the pupil list
// when InfoMentor renders the switcher via JavaScript instead of
// server-side HTML — see the AGENTS.md note about IM using SPA
// shells for the modern dashboard.
//
// switchId is the number at the end of any
// /Account/PupilSwitcher/SwitchPupil/{id} link on hub.infomentor.se.
// To find it: open the pupil switcher dropdown in InfoMentor's
// dashboard, right-click a child's name → "Inspect" → look for the
// href ending in SwitchPupil/{number}.
import { type } from 'arktype';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { deletePupil, listPupils, upsertPupil } from '$lib/server/cache';

export const load: PageServerLoad = () => {
	return { pupils: listPupils() };
};

// arktype gives us a single boundary that parses `FormData` into a
// typed shape AND rejects malformed input. We intentionally accept
// only digits for switchId (with a min of 1) — the source is a
// hand-typed number from the user, and `>= 1` rejects zero and
// negatives cleanly.
const AddPupilForm = type({
	switchId: 'string >= 1',
	// displayName is optional; `string` (without min) accepts an
	// empty string and we coerce to null below when it's blank.
	displayName: 'string'
});

const RemovePupilForm = type({
	switchId: 'string >= 1'
});

function parsePositiveInt(raw: string): number | null {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

export const actions: Actions = {
	add: async ({ request }) => {
		const form = await request.formData();
		// SAFETY: FormData's `.get()` returns `FormDataEntryValue |
		// null`, which is `File | string | null`. We narrow via the
		// arktype schema below, which only reads string fields and
		// rejects non-strings. If a field is missing/null/empty, we
		// fall back to an empty string so the schema (which requires
		// `>= 1`) rejects it with a clean error.
		const switchIdRaw = form.get('switchId');
		const displayNameRaw = form.get('displayName');
		const switchIdStr = switchIdRaw instanceof File ? '' : (switchIdRaw ?? '');
		const displayNameStr = displayNameRaw instanceof File ? '' : (displayNameRaw ?? '');
		const candidate = {
			switchId: switchIdStr,
			displayName: displayNameStr
		};
		const parsed = AddPupilForm(candidate);
		if (parsed instanceof type.errors) {
			return fail(400, {
				error: 'switchId måste vara ett positivt heltal',
				switchId: switchIdStr,
				displayName: displayNameStr
			});
		}
		const switchId = parsePositiveInt(parsed.switchId);
		if (switchId === null) {
			return fail(400, {
				error: 'switchId måste vara ett positivt heltal',
				switchId: parsed.switchId,
				displayName: parsed.displayName
			});
		}
		const trimmedName = parsed.displayName.trim();
		const displayName = trimmedName.length > 0 ? trimmedName : null;
		upsertPupil(switchId, displayName);
		throw redirect(303, '/barn');
	},
	remove: async ({ request }) => {
		const form = await request.formData();
		const switchIdRaw = form.get('switchId');
		const switchIdStr = switchIdRaw instanceof File ? '' : (switchIdRaw ?? '');
		const candidate = { switchId: switchIdStr };
		const parsed = RemovePupilForm(candidate);
		if (parsed instanceof type.errors) {
			return fail(400, { error: 'switchId saknas eller ogiltigt' });
		}
		const switchId = parsePositiveInt(parsed.switchId);
		if (switchId === null) {
			return fail(400, { error: 'ogiltigt switchId' });
		}
		deletePupil(switchId);
		throw redirect(303, '/barn');
	}
};
