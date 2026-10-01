// Synthetic cache measurement, not a browser/startup performance claim.
import { performance } from 'node:perf_hooks';
import { IDBFactory } from 'fake-indexeddb';
import { openLocalDb } from '../src/lib/localDb.js';
import {
	createVault,
	createNoteKey,
	rememberVault,
	unlockRemembered,
	unlockVault
} from '../src/lib/vault.js';
import { context, encryptObject, newId } from '../src/lib/crypto.js';
globalThis.$state = (v) => v;
globalThis.$derived = Object.assign((v) => v, { by: (f) => f() });
const { JNoteState } = await import('../src/lib/jnote.svelte.js');
for (const count of [100, 1000]) {
	const scope = { owner: 'benchmark', epoch: newId() },
		db = await openLocalDb(scope.owner, scope.epoch, new IDBFactory());
	const start = performance.now();
	const { key, header } = await createVault('generated-test-passphrase', scope);
	const setupMs = performance.now() - start;
	const fixture = [];
	for (let i = 0; i < count; i++) {
		const id = newId(),
			revision = newId(),
			pair = await createNoteKey(key, scope, id);
		fixture.push({
			note: {
				id,
				revision,
				summaryRevision: revision,
				generation: 1,
				summary: await encryptObject(
					{ title: `Generated note ${i}` },
					pair.key,
					context('summary', scope, id, revision)
				)
			},
			grant: { id, wrapper: pair.wrapper },
			body: {
				id: revision,
				logicalId: id,
				revision,
				generation: 1,
				ciphertext: await encryptObject(
					{ title: `Generated note ${i}`, content: 'Generated body '.repeat(200) },
					pair.key,
					context('history', scope, id, revision)
				)
			}
		});
	}
	await db.transaction(['notes', 'grants', 'contents'], 'readwrite', async (s) => {
		for (const f of fixture) {
			await s.notes.put(f.note);
			await s.grants.put(f.grant);
			await s.contents.put(f.body);
		}
	});
	await db.put('protected', await rememberVault(key, scope));
	const state = new JNoteState();
	state.scope = scope;
	state.db = db;
	const warmStart = performance.now();
	state.encryptionState = {
		key: await unlockRemembered(await db.get('protected', 'device'), scope)
	};
	await state.loadNotes({ bodies: false });
	const summaryMs = performance.now() - warmStart;
	const bodyStart = performance.now();
	await state.hydrateCurrentBodies();
	const bodiesMs = performance.now() - bodyStart;
	const unlockStart = performance.now();
	await unlockVault('generated-test-passphrase', header, scope);
	const passphraseMs = performance.now() - unlockStart;
	console.log(
		JSON.stringify({
			notes: count,
			setupMs: Math.round(setupMs),
			rememberedSummariesMs: Math.round(summaryMs),
			cachedBodyHydrationMs: Math.round(bodiesMs),
			passphraseUnlockMs: Math.round(passphraseMs),
			environment: 'Node/WebCrypto/fake-indexeddb; generated 3KB bodies; no browser, network or DOM'
		})
	);
	db.close();
}
