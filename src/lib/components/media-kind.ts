// Shared classification for a LearnlogEntry's media items.
//
// Why this lives next to the components instead of `infomentor/api.ts`:
// the mapping from InfoMentor's `fileType` string ("Image" / "Video" /
// something else for PDFs and unknown attachments) to a UI-side enum
// is purely a rendering concern — it's not part of the API surface,
// and the same logic is used in the Lärlogg tile grid and in the
// lightbox carousel, so duplicating it in two `.svelte` files would
// drift. Centralising here keeps the two views in lock-step.
//
// `fileType` from IM is uppercase-and-PascalCase for the known
// cases ("Image", "Video"); for everything else (PDFs, generic
// files, unknown) it's whatever InfoMentor decides — currently
// observed as `"Document"`, but the fallback here treats anything
// unrecognised as a document (link-out to the file) rather than
// trying to render it as an `<img>` — safer default for "we don't
// know what this is", and it surfaces the previously-invisible PDF
// attachments that were the original bug report.

export type MediaKind = 'image' | 'video' | 'document';

export function mediaKind(fileType: string | null | undefined): MediaKind {
	const t = (fileType ?? '').toLowerCase().trim();
	if (t === 'image') return 'image';
	if (t === 'video') return 'video';
	// "document" covers PDFs and any other generic file attachment
	// InfoMentor might attach to a Lärlogg post. The lightbox
	// deliberately doesn't try to render these inline — PDF previews
	// don't carousel well with photos/videos, and a fresh tab is the
	// better experience (the user can save/print). See
	// `media-lightbox.svelte` for the link-out branch.
	return 'document';
}

export function isVideoKind(kind: MediaKind): boolean {
	return kind === 'video';
}

/**
 * Short uppercase label for the bottom-left badge on a Lärlogg grid
 * tile. Document-kind attachments (PDFs and other file types
 * InfoMentor might attach in the future) get the file's extension
 * uppercased ("PDF", "DOCX", …); videos get "Video"; images get no
 * label — they're obvious. Falls back to "FIL" if the extension is
 * missing, better than an empty pill.
 *
 * Lives here rather than in the larLogg page because the månadsbrev
 * page (which shares the same tile rendering shape) also needs it,
 * and putting a formatting helper in two `.svelte` files invites
 * drift. Same provenance split as `mediaKind` itself.
 */
export function tileKindLabel(m: {
	fileType: string | null | undefined;
	fileExtension: string;
}): string {
	if (mediaKind(m.fileType) === 'document') {
		const ext = m.fileExtension.trim().replace(/^\./, '').toLowerCase();
		return ext.length > 0 ? ext.toUpperCase() : 'FIL';
	}
	return '';
}
