import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { openLocalDb } from '../src/lib/localDb.js';
import { generateKey, newId, encryptObject, context } from '../src/lib/crypto.js';
import { flushOutbox } from '../src/lib/sync.js';
async function fixture() {
	return { db: await openLocalDb('a', 'epoch', new IDBFactory()), key: await generateKey() };
}
async function append(db, key, objectId, payload) {
	const id = newId();
	await db.commit({
		operation: {
			id,
			objectId,
			endpoint: 'commit',
			ciphertext: await encryptObject(
				{ ...payload, operationId: id },
				key,
				context('outbox', db.scope, id)
			)
		}
	});
	return id;
}
test('offline commits are preserved and upload in order with server ID reconciliation', async () => {
	const { db, key } = await fixture();
	await db.put('notes', { id: 'n', revision: 'r2' });
	await append(db, key, 'n', { revision: 'r1', baseRevision: '' });
	await append(db, key, 'n', { revision: 'r2', baseRevision: 'r1' });
	const calls = [];
	await flushOutbox(db, key, {
		send: async (path, p) => {
			calls.push(p);
			return { serverId: 'pb-id', revision: p.revision };
		}
	});
	assert.deepEqual(
		calls.map((p) => p.baseRevision),
		['', 'r1']
	);
	assert.equal((await db.get('notes', 'n')).serverId, 'pb-id');
	assert.deepEqual(await db.all('outbox'), []);
});
test('timeout retries the exact operation and conflict blocks its dependents only', async () => {
	const { db, key } = await fixture();
	const id = await append(db, key, 'a', { revision: 'r1' });
	await append(db, key, 'a', { revision: 'r2' });
	await append(db, key, 'b', { revision: 'other' });
	await assert.rejects(() =>
		flushOutbox(db, key, {
			send: async () => {
				throw new Error('lost response');
			}
		})
	);
	assert.equal((await db.all('outbox')).length, 3);
	const calls = [];
	await flushOutbox(db, key, {
		send: async (path, p) => {
			calls.push(p);
			if (p.operationId === id) throw Object.assign(new Error('conflict'), { status: 409 });
			return {};
		}
	});
	assert.equal(calls.length, 2);
	assert.equal((await db.get('outbox', id)).conflict, true);
	assert.equal((await db.all('outbox')).length, 2);
});
