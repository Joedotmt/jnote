import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { classifyRequest } from '../src/lib/serviceWorkerRules.js';

const source = (
	await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8')
).replace(/^import .*;$/gm, '');
const origin = 'https://notes.joe.mt';

function fixture(base = '') {
	const handlers = new Map();
	const stores = new Map();
	const calls = [];
	let offline = false;
	let installFails = false;
	const path = (request) =>
		new URL(typeof request === 'string' ? request : request.url, origin).pathname;
	const cache = (name) => {
		if (!stores.has(name)) stores.set(name, new Map());
		const entries = stores.get(name);
		return {
			async addAll(assets) {
				calls.push('precache');
				if (installFails) throw new Error('Precache failed');
				for (const asset of assets) {
					assert.equal(asset.cache, 'reload');
					entries.set(path(asset), `current ${path(asset)}`);
				}
			},
			async match(request) {
				const body = entries.get(path(request));
				return body === undefined ? undefined : new Response(body);
			},
			async put(request, response) {
				entries.set(path(request), await response.text());
			}
		};
	};
	const caches = {
		async open(name) {
			return cache(name);
		},
		async keys() {
			return [...stores.keys()];
		},
		async delete(name) {
			return stores.delete(name);
		},
		async match(request) {
			for (const name of stores.keys()) {
				const response = await cache(name).match(request);
				if (response) return response;
			}
		}
	};
	vm.runInNewContext(source, {
		base,
		build: [`${base}/_app/immutable/current.js`],
		files: [],
		prerendered: [`${base}/`],
		version: 'current',
		classifyRequest,
		caches,
		URL,
		Request,
		Response,
		self: {
			location: { origin },
			addEventListener(type, callback) {
				handlers.set(type, callback);
			},
			async skipWaiting() {
				calls.push('skipWaiting');
			},
			clients: {
				async claim() {
					calls.push('claim');
				}
			}
		},
		async fetch(request, options) {
			calls.push(['fetch', path(request), options?.cache]);
			if (offline) throw new Error('Offline');
			return new Response(`network ${path(request)}`);
		}
	});
	return {
		stores,
		calls,
		setOffline(value) {
			offline = value;
		},
		failInstall() {
			installFails = true;
		},
		async dispatch(type, request) {
			let response;
			handlers.get(type)({
				request,
				waitUntil(promise) {
					response = promise;
				},
				respondWith(promise) {
					response = promise;
				}
			});
			return response;
		}
	};
}

const navigation = (path = '/') => ({ url: origin + path, method: 'GET', mode: 'navigate' });

test('the replacement worker activates only after its complete shell is cached', async () => {
	const app = fixture();
	await app.dispatch('install');
	assert.deepEqual(app.calls, ['precache', 'skipWaiting']);
	const broken = fixture();
	broken.failInstall();
	await assert.rejects(broken.dispatch('install'), /Precache failed/);
	assert.deepEqual(broken.calls, ['precache']);
});

test('a stale cached home page cannot hide the online release', async () => {
	const app = fixture();
	app.stores.set('jnote-shell-old', new Map([['/', 'outdated app']]));
	await app.dispatch('install');
	assert.equal(await (await app.dispatch('fetch', navigation())).text(), 'network /');
	assert.deepEqual(app.calls.at(-1), ['fetch', '/', 'no-cache']);
});

test('offline navigation uses the current shell at custom-domain and repository roots', async () => {
	for (const base of ['', '/jnote']) {
		const app = fixture(base);
		app.stores.set('jnote-shell-old', new Map([[`${base}/`, 'outdated app']]));
		await app.dispatch('install');
		app.setOffline(true);
		assert.equal(
			await (await app.dispatch('fetch', navigation(`${base}/deep/link/`))).text(),
			`current ${base}/`
		);
	}
});

test('activation preserves unrelated caches and the previous release needed by open tabs', async () => {
	const app = fixture();
	app.stores.set('another-app', new Map([['/other', 'unrelated']]));
	app.stores.set('jnote-shell-ancient', new Map());
	app.stores.set('jnote-runtime-old', new Map());
	app.stores.set(
		'jnote-shell-previous',
		new Map([['/_app/immutable/previous.js', 'previous chunk']])
	);
	await app.dispatch('install');
	await app.dispatch('activate');
	assert.deepEqual(
		[...app.stores.keys()],
		['another-app', 'jnote-shell-previous', 'jnote-shell-current']
	);
	assert.equal(app.calls.at(-1), 'claim');
	const request = { url: origin + '/_app/immutable/previous.js', method: 'GET', mode: 'cors' };
	assert.equal(await (await app.dispatch('fetch', request)).text(), 'previous chunk');
});

test('the worker never handles account or PocketBase traffic', async () => {
	const app = fixture();
	for (const url of [
		'https://accounts.joe.mt/bridge/',
		'https://joemt.fly.dev/api/jnote/v2/bootstrap'
	]) {
		assert.equal(await app.dispatch('fetch', { url, method: 'GET', mode: 'navigate' }), undefined);
	}
	assert.deepEqual(app.calls, []);
});
