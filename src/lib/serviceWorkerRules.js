// What the service worker does with each request. Pure, so it can be tested under Node;
// the worker itself only wires these decisions to the Cache API.

// Third-party assets the app shell needs to look right offline. Cached as they are
// fetched and refreshed in the background.
export const RUNTIME_CACHE_HOSTS = new Set([
	'cdn.jsdelivr.net',
	'fonts.googleapis.com',
	'fonts.gstatic.com'
]);

/**
 * @param {object} request
 * @param {string} request.url
 * @param {string} request.method
 * @param {string} request.mode        Request.mode, 'navigate' for a page load
 * @param {string} request.origin      the worker's own origin
 * @param {Set<string>} request.precached  pathnames precached at install
 * @param {string} [request.basePath]  deployment base, empty for a custom domain
 * @returns {'ignore' | 'precached' | 'runtime' | 'navigate'}
 */
export function classifyRequest({ url, method, mode, origin, precached, basePath = '' }) {
	if (method !== 'GET') return 'ignore';
	let target;
	try {
		target = new URL(url);
	} catch (error) {
		return 'ignore';
	}
	if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'ignore';
	if (target.pathname.startsWith('/api/')) return 'ignore';

	if (target.origin !== origin) {
		// Never the notes server or the account site. Those responses are the user's data
		// and session, and a stale copy of either would be worse than no copy.
		return RUNTIME_CACHE_HOSTS.has(target.hostname) ? 'runtime' : 'ignore';
	}
	// HTML must reach the current release online, even when '/' is in the precache.
	if (mode === 'navigate') return 'navigate';
	if (precached.has(target.pathname) || target.pathname.startsWith(`${basePath}/_app/immutable/`))
		return 'precached';
	return 'ignore';
}
