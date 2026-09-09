// Fixed, non-personal artwork. Never render upstream HTML as an image.
const artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
<rect width="320" height="320" fill="#e5e5e5"/>
<circle cx="160" cy="140" r="38" fill="#333"/>
<path d="M151 120l28 20-28 20z" fill="#fff"/>
<text x="160" y="214" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#444">Förhandsvisning saknas</text>
</svg>`;

export function videoThumbnailPlaceholder(): Response {
	return new Response(artwork, {
		headers: {
			'Content-Type': 'image/svg+xml; charset=utf-8',
			'Cache-Control': 'private, max-age=300',
			'X-Content-Type-Options': 'nosniff',
			'X-Thumbnail-Placeholder': '1'
		}
	});
}
