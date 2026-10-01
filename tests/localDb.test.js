import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { openLocalDb, retireLegacyStores } from '../src/lib/localDb.js';
import { generateKey, context, encryptObject, decryptObject, newId } from '../src/lib/crypto.js';
import { rememberVault, unlockRemembered } from '../src/lib/vault.js';
test('atomic local commits preserve every operation, remove matching drafts and survive restart', async () => {
	const factory = new IDBFactory();
	let db = await openLocalDb('a', 'epoch', factory);
	await db.saveDraft({ id: 'note', sequence: 2, ciphertext: 'newer-encrypted-draft' });
	await db.commit({
		note: { id: 'note', revision: 'r1' },
		content: { id: 'r1', ciphertext: 'encrypted' },
		operation: { id: 'op1' },
		draftSequence: 1
	});
	assert.equal((await db.get('drafts', 'note')).sequence, 2);
	await db.commit({
		note: { id: 'note', revision: 'r2' },
		content: { id: 'r2', ciphertext: 'encrypted' },
		operation: { id: 'op2' },
		draftSequence: 2
	});
	assert.equal(await db.get('drafts', 'note'), undefined);
	db.close();
	db = await openLocalDb('a', 'epoch', factory);
	assert.deepEqual(
		(await db.all('outbox')).map((o) => [o.id, o.order]),
		[
			['op1', 1],
			['op2', 2]
		]
	);
	assert.equal((await db.all('contents')).length, 2);
	assert.equal((await openLocalDb('b', 'epoch', factory)).all('notes') instanceof Promise, true);
	assert.deepEqual(await (await openLocalDb('a', 'different', factory)).all('outbox'), []);
	assert.deepEqual(await (await openLocalDb('b', 'epoch', factory)).all('notes'), []);
});
test('failed transactions roll back note/history/outbox and checkpoint together', async () => {
	const db = await openLocalDb('a', 'epoch', new IDBFactory());
	await assert.rejects(() =>
		db.transaction(['notes', 'contents', 'outbox'], 'readwrite', async (s) => {
			await s.notes.put({ id: 'n' });
			await s.contents.put({ id: 'r' });
			throw new Error('quota simulation');
		})
	);
	assert.deepEqual(await db.all('notes'), []);
	assert.deepEqual(await db.all('contents'), []);
	await assert.rejects(() =>
		db.applyChanges({
			changes: [
				{ type: 'note', objectId: 'n', value: { revision: 'r' } },
				{ type: 'note', value: {} }
			],
			cursor: 99
		})
	);
	assert.deepEqual(await db.all('notes'), []);
	assert.equal(await db.get('meta', 'cursor'), undefined);
});
test('stale draft completions cannot overwrite newer encryption', async () => {
	const db = await openLocalDb('a', 'epoch', new IDBFactory());
	await db.saveDraft({ id: 'n', sequence: 20, ciphertext: 'new' });
	await db.saveDraft({ id: 'n', sequence: 19, ciphertext: 'old' });
	assert.equal((await db.get('drafts', 'n')).ciphertext, 'new');
});
test('database leases admit only one tab, allow renewal, and recover expiry', async () => {
	const factory = new IDBFactory();
	const a = await openLocalDb('a', 'epoch', factory),
		b = await openLocalDb('a', 'epoch', factory);
	const results = await Promise.all([
		a.acquireLease('tab-a', 100, 1000),
		b.acquireLease('tab-b', 100, 1000)
	]);
	assert.equal(results.filter(Boolean).length, 1);
	const winner = results[0] ? 'tab-a' : 'tab-b';
	assert.equal(await a.acquireLease(winner, 100, 1050), true);
	assert.equal(await b.acquireLease('later', 100, 1200), true);
});
test('persisted values contain ciphertext and protected structured-cloned device keys', async () => {
	const db = await openLocalDb('a', 'epoch', new IDBFactory());
	const key = await generateKey();
	const ciphertext = await encryptObject(
		{ title: 'Secret title', body: 'Secret body' },
		key,
		context('draft', db.scope, 'n')
	);
	await db.saveDraft({ id: 'n', sequence: 1, ciphertext });
	assert.equal(JSON.stringify(await db.all('drafts')).includes('Secret'), false);
	await db.put('protected', await rememberVault(key, db.scope));
	const remembered = await db.get('protected', 'device');
	assert.equal(remembered.deviceKey.extractable, false);
	const unlocked = await unlockRemembered(remembered, db.scope);
	assert.equal(
		(await decryptObject(ciphertext, unlocked, context('draft', db.scope, 'n'))).body,
		'Secret body'
	);
});
test('retirement removes only known legacy entries and preserves CSS and other accounts', () => {
	const data = new Map([
		['jnote.customCss.v1', 'css'],
		['unrelated', 'keep'],
		['jnote.localNotes.v1.a', 'old'],
		['jnote.localNotes.v1.b', 'other']
	]);
	retireLegacyStores({ removeItem: (k) => data.delete(k) }, 'a');
	assert.equal(data.has('jnote.localNotes.v1.a'), false);
	assert.equal(data.get('jnote.customCss.v1'), 'css');
	assert.equal(data.get('jnote.localNotes.v1.b'), 'other');
});
test('a late page from another tab cannot move the checkpoint or heads backward', async () => {
	const db = await openLocalDb('a', 'epoch', new IDBFactory());
	await db.applyChanges({
		changes: [{ type: 'note', objectId: 'n', value: { revision: 'latest' } }],
		cursor: 20
	});
	await db.applyChanges({
		changes: [{ type: 'note', objectId: 'n', value: { revision: 'stale' } }],
		cursor: 10
	});
	assert.equal((await db.get('meta', 'cursor')).value, 20);
	assert.equal((await db.get('notes', 'n')).revision, 'latest');
});
