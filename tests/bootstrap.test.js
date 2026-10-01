import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function boot(path, hash) {
	const appended = [];
	let reads = 0;
	const location = { pathname: path, hash, search: '', origin: 'http://localhost:5173' };
	const ctx = {
		location,
		URLSearchParams,
		Date,
		Promise,
		atob,
		window: {},
		history: {
			state: {},
			replaceState(state, _, url) {
				location.hash = url.includes('#') ? '#' + url.split('#')[1] : '';
			}
		},
		document: {
			documentElement: { classList: { add() {} } },
			head: { append: (v) => appended.push(v), appendChild: (v) => appended.push(v) },
			createElement: (tag) => ({ tag }),
			getElementById: () => ({ textContent: '' })
		},
		localStorage: {
			getItem() {
				reads++;
				return 'body { display: none }';
			}
		},
		console
	};
	vm.createContext(ctx);
	scripts.forEach((s) => vm.runInContext(s, ctx));
	return { ctx, appended, reads };
}
test('public direct navigation, trailing slashes and repository fallback consume the key once before scripts', () => {
	for (const path of [
		'/s/' + 'a'.repeat(43),
		'/s/' + 'a'.repeat(43) + '/',
		'/jnote/s/' + 'a'.repeat(43) + '/'
	]) {
		const { ctx, appended, reads } = boot(path, '#' + 'A'.repeat(43));
		assert.equal(ctx.window.__jnotePublic, true);
		assert.equal(ctx.location.hash, '');
		assert.equal(ctx.window.__jnoteTakeShareKey(), 'A'.repeat(43));
		assert.equal(ctx.window.__jnoteTakeShareKey(), '');
		assert.equal(reads, 0);
		assert.equal(
			appended.some((a) => a.tag === 'script'),
			false
		);
		assert.equal(
			appended.some((a) => a.href),
			false
		);
		assert.match(appended.find((a) => a.httpEquiv).content, /script-src 'self'/);
	}
	assert.equal(boot('/s/' + 'a'.repeat(43) + '/', '').ctx.window.__jnoteTakeShareKey(), '');
});
test('public fragments never become account handoffs and malformed keys are removed', () => {
	const { ctx } = boot('/s/' + 'a'.repeat(43), '#joe_session=secret');
	assert.equal(ctx.location.hash, '');
	assert.equal(ctx.window.__jnoteTakeShareKey(), '');
	assert.equal(ctx.window.__jnoteTakeHandoffToken, undefined);
});
test('private handoff is stripped before third-party scripts and offered only once', () => {
	const token =
		'header.' + btoa(JSON.stringify({ type: 'auth', exp: Date.now() / 1000 + 100 })) + '.signature';
	const { ctx, appended, reads } = boot('/', '#joe_session=' + token);
	assert.equal(ctx.location.hash, '');
	assert.equal(ctx.window.__jnoteTakeHandoffToken(), token);
	assert.equal(ctx.window.__jnoteTakeHandoffToken(), '');
	assert.equal(reads, 1);
	assert.ok(appended.some((a) => a.src?.endsWith('/client.js')));
});
test('expired and duplicate handoffs are stripped and refused', () => {
	const expired = 'a.' + btoa(JSON.stringify({ type: 'auth', exp: 1 })) + '.b';
	const { ctx } = boot('/', '#joe_session=' + expired);
	assert.equal(ctx.window.__jnoteTakeHandoffToken(), '');
	assert.equal(ctx.window.__jnoteHandoffProblem(), 'expired');
	const duplicate = boot('/', '#joe_session=a&joe_session=b');
	assert.equal(duplicate.ctx.location.hash, '');
	assert.equal(duplicate.ctx.window.__jnoteHandoffProblem(), 'malformed');
});
