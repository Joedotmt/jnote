export function handle({ event, resolve }) {
	// The service worker precaches the module graph. Chrome discards HTML module
	// preloads when the later import is served from that cache, producing duplicate
	// requests and "cross-world service worker resource mismatch" warnings.
	return resolve(event, { preload: ({ type }) => type !== 'js' });
}
