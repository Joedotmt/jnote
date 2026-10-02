/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
//
// App-shell caching only. Everything the app needs to draw itself is precached per
// build; the notes server and the account site are never touched, so notes and the
// session always come live. Offline, a page load gets the cached shell and the app
// shows its own offline state.
import { base, build, files, prerendered, version } from '$service-worker';
import { classifyRequest } from '$lib/serviceWorkerRules.js';

const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const SHELL_CACHE = `jnote-shell-${version}`;
const RUNTIME_CACHE = `jnote-runtime-${version}`;
const ASSETS = [...build, ...files, ...prerendered];
const PRECACHED = new Set(ASSETS.map((path) => new URL(path, worker.location.origin).pathname));
const SHELL_URL = `${base}/`;

worker.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) =>
				cache.addAll(
					ASSETS.map(
						(path) => new Request(new URL(path, worker.location.origin), { cache: 'reload' })
					)
				)
			)
			// A cached old page must not keep the new worker waiting indefinitely.
			.then(() => worker.skipWaiting())
	);
});

worker.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => {
				// Keep the previous release's immutable chunks for tabs already using it.
				// Cache names are returned in creation order. Never remove unrelated caches.
				const previousShell = keys
					.filter((key) => key.startsWith('jnote-shell-') && key !== SHELL_CACHE)
					.at(-1);
				return Promise.all(
					keys
						.filter(
							(key) =>
								(key.startsWith('jnote-shell-') || key.startsWith('jnote-runtime-')) &&
								key !== SHELL_CACHE &&
								key !== RUNTIME_CACHE &&
								key !== previousShell
						)
						.map((key) => caches.delete(key))
				);
			})
			.then(() => worker.clients.claim())
	);
});

worker.addEventListener('fetch', (event) => {
	const kind = classifyRequest({
		url: event.request.url,
		method: event.request.method,
		mode: event.request.mode,
		origin: worker.location.origin,
		precached: PRECACHED,
		basePath: base
	});
	if (kind === 'ignore') return;
	event.respondWith(respond(event.request, kind));
});

async function respond(request, kind) {
	if (kind === 'precached') {
		// Hashed build output never changes under one version, so the cache is the truth.
		const cache = await caches.open(SHELL_CACHE);
		return (
			(await cache.match(request, { ignoreSearch: true })) ||
			(await caches.match(request, { ignoreSearch: true })) ||
			fetch(request)
		);
	}

	if (kind === 'navigate') {
		try {
			return await fetch(request, { cache: 'no-cache' });
		} catch (error) {
			const cache = await caches.open(SHELL_CACHE);
			const shell = (await cache.match(SHELL_URL)) || (await cache.match(`${base}/index.html`));
			if (shell) return shell;
			throw error;
		}
	}

	// runtime: serve what we have, refresh it behind the scenes.
	const cache = await caches.open(RUNTIME_CACHE);
	const cached = await cache.match(request);
	const refresh = fetch(request)
		.then((response) => {
			if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
			return response;
		})
		.catch(() => undefined);
	return cached || (await refresh) || Response.error();
}
