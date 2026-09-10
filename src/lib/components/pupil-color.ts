// Deterministic pupil → pill color mapping, shared by every place
// that tags an entry with a pupil name (currently `/larLogg` and
// `/manadsbrev`, via `learnlog-entry-card.svelte`).
//
// Assignment is by the pupil's position among all *currently known*
// pupils (sorted by switch_id), not a hash of switch_id itself — with
// the household's pupil count staying well under PALETTE.length, this
// guarantees no two known pupils ever land on the same color, which a
// hash could accidentally do. Order is stable across renders as long
// as the same set of pupils is passed in; adding/removing a pupil on
// `/barn` can shift later pupils' colors, which is an acceptable
// trade-off for a personal single-household tool.
const PALETTE = [
	'bg-amber-200',
	'bg-sky-200',
	'bg-pink-200',
	'bg-lime-200',
	'bg-violet-200',
	'bg-orange-200'
];

/** Used for the combined "Alla" pill — deliberately not in PALETTE
 *  above, so it never gets confused with one specific pupil's color. */
export const ALL_PUPILS_PILL_CLASS = 'bg-slate-300';

export interface PupilLike {
	switchId: number;
}

/** Build a `switchId → tailwind bg class` resolver once per render of
 *  the pupils list, so callers doing this per-pill don't re-sort. */
export function createPupilColorClass(pupils: PupilLike[]): (switchId: number) => string {
	const order = [...pupils].map((p) => p.switchId).sort((a, b) => a - b);
	return (switchId: number): string => {
		const index = order.indexOf(switchId);
		return PALETTE[(index === -1 ? 0 : index) % PALETTE.length];
	};
}
