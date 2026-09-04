// Pass the InfoMentor session (if any) through to every page via
// PageData so the layout can render the header without each page
// re-loading it. The hook has already populated `locals.infoMentor`,
// so this is just a pass-through.
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return { infoMentor: locals.infoMentor };
};
