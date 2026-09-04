// Expose the logged-in user to every page via PageData so the layout
// can render a header (display name + logout) without each page
// re-loading it. The hook has already populated `locals.user`, so this
// is just a pass-through.
import type { LayoutServerLoad } from './$types.ts';

export const load: LayoutServerLoad = ({ locals }) => {
	return { user: locals.user };
};
