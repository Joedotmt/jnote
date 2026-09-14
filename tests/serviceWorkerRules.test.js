import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRequest } from '../src/lib/serviceWorkerRules.js';

const origin = 'https://notes.joe.mt';
const precached = new Set(['/', '/_app/immutable/entry/app.abc123.js', '/icons/icon-192.png']);
const classify = (url, extra = {}) => classifyRequest({
  url, method: 'GET', mode: 'no-cors', origin, precached, ...extra
});

test('the notes server and the account site are never intercepted', () => {
  assert.equal(classify('https://joemt.fly.dev/api/collections/jnote/records'), 'ignore');
  assert.equal(classify('https://accounts.joe.mt/client.js'), 'ignore');
  assert.equal(classify('https://accounts.joe.mt/bridge/', { mode: 'navigate' }), 'ignore');
});

test('only GET is ever served from a cache', () => {
  assert.equal(classify(`${origin}/`, { method: 'POST', mode: 'navigate' }), 'ignore');
  assert.equal(classify('https://cdn.jsdelivr.net/npm/beercss@3.9.7/dist/cdn/beer.min.css', { method: 'HEAD' }), 'ignore');
});

test('build output precached at install comes from the cache', () => {
  assert.equal(classify(`${origin}/_app/immutable/entry/app.abc123.js`), 'precached');
  assert.equal(classify(`${origin}/icons/icon-192.png`), 'precached');
  // A query string does not make it a different file.
  assert.equal(classify(`${origin}/`, { mode: 'navigate' }), 'precached');
});

test('a page load that is not precached falls back to the shell', () => {
  assert.equal(classify(`${origin}/some/deep/link/`, { mode: 'navigate' }), 'navigate');
});

test('other same-origin requests are left alone', () => {
  assert.equal(classify(`${origin}/not-in-the-build.js`), 'ignore');
});

test('the shell CDN assets are cached as they are fetched', () => {
  assert.equal(classify('https://cdn.jsdelivr.net/npm/beercss@3.9.7/dist/cdn/beer.min.css'), 'runtime');
  assert.equal(classify('https://fonts.googleapis.com/css2?family=Google+Sans'), 'runtime');
  assert.equal(classify('https://fonts.gstatic.com/s/googlesans/v1/x.woff2'), 'runtime');
});

test('anything else cross-origin, or not http, is ignored', () => {
  assert.equal(classify('https://example.com/whatever.js'), 'ignore');
  assert.equal(classify('data:text/plain,hello'), 'ignore');
  assert.equal(classify('not a url'), 'ignore');
});
