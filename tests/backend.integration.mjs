// Real PocketBase/SQLite integration. Always uses a newly allocated disposable directory.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import PocketBase from 'pocketbase';
import { createVault, createNoteKey, rewrapVault } from '../src/lib/vault.js';
import { context, encryptObject, newId } from '../src/lib/crypto.js';
import {
	createPublication,
	publicationLink,
	readPublication,
	republish
} from '../src/lib/publicSharing.js';
import { JNoteApi } from '../src/lib/sync.js';
const binary = process.env.POCKETBASE_BIN;
if (!binary) throw new Error('Set POCKETBASE_BIN to a tested PocketBase 0.28.2 or 0.40.3 binary.');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
assert.match(version, /0\.(?:28\.2|40\.3)$/, 'Run against a tested backend version.');
const dir = await mkdtemp(join(tmpdir(), 'jnote-integration-'));
process.env.JNOTE_HOOKS_DIR = resolve('backend/pb_hooks');
const port = Number(process.env.JNOTE_TEST_PORT || 18098);
const url = `http://127.0.0.1:${port}`;
const args = [
	'--automigrate=false',
	`--dir=${dir}`,
	`--hooksDir=${resolve('backend/pb_hooks')}`,
	`--migrationsDir=${resolve('backend/pb_migrations')}`
];
const credentials = ['tests@example.invalid', 'disposable-test-admin-pass-12345'];
assert.equal(
	spawnSync(binary, ['superuser', 'upsert', ...credentials, ...args], { encoding: 'utf8' }).status,
	0
);
const server = spawn(binary, ['serve', ...args, `--http=127.0.0.1:${port}`], {
	stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
server.stdout.on('data', (b) => (logs += b));
server.stderr.on('data', (b) => (logs += b));
async function expectStatus(work, status) {
	await assert.rejects(work, (e) => {
		assert.equal(e.status, status, JSON.stringify(e.response));
		return true;
	});
}
try {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			if ((await fetch(url + '/api/health')).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	const admin = new PocketBase(url);
	await admin.collection('_superusers').authWithPassword(...credentials);
	const clients = [];
	for (const name of ['owner', 'other']) {
		const email = `${name}@example.invalid`,
			password = 'disposable-owner-pass-12345';
		await admin.collection('users').create({ email, password, passwordConfirm: password });
		const pb = new PocketBase(url);
		await pb.collection('users').authWithPassword(email, password);
		clients.push(pb);
	}
	const [pb, other] = clients;
	const api = new JNoteApi(pb),
		otherApi = new JNoteApi(other);
	const b = await api.bootstrap();
	assert.equal(b.vault, null);
	assert.equal(b.protocol, 2);
	const scope = { owner: pb.authStore.record.id, epoch: b.epoch };
	// Missing control metadata must be reported as unavailable, and recovered only
	// from a confirmed epoch/receipt when every encrypted collection is empty.
	const initialControl = (await admin.collection('jnote_control').getFullList())[0];
	const usersBeforeRecovery = await admin.collection('users').getFullList({ sort: 'id' });
	await admin.collection('jnote_control').delete(initialControl.id);
	await expectStatus(() => api.bootstrap(), 503);
	const completedAt = new Date().toISOString();
	const approvedOwners = clients
		.map((c) => c.authStore.record.id)
		.sort()
		.join(',');
	const maintenance = (command, values = []) =>
		spawnSync(binary, [command, ...values, ...args], {
			encoding: 'utf8',
			env: { ...process.env, JNOTE_INSTANCE: 'disposable' }
		});
	assert.notEqual(maintenance('jnote-check').status, 0);
	assert.notEqual(
		maintenance('jnote-restore-control', ['wrong', b.epoch, completedAt, approvedOwners]).status,
		0
	);
	const recoveryArgs = ['disposable', b.epoch, completedAt, approvedOwners];
	const temporaryObject = await admin.collection('jnote_private_objects').create({
		owner: scope.owner,
		epoch: b.epoch,
		objectId: newId(),
		objectType: 'setting',
		revision: newId()
	});
	assert.notEqual(maintenance('jnote-restore-control', recoveryArgs).status, 0);
	assert.equal((await admin.collection('jnote_control').getFullList()).length, 0);
	await admin.collection('jnote_private_objects').delete(temporaryObject.id);
	const restored = maintenance('jnote-restore-control', recoveryArgs);
	assert.equal(restored.status, 0, restored.stdout + restored.stderr);
	assert.equal((await api.bootstrap()).epoch, b.epoch);
	assert.deepEqual(
		await admin.collection('users').getFullList({ sort: 'id' }),
		usersBeforeRecovery
	);
	assert.equal(maintenance('jnote-check').status, 0);
	const otherVault = await createVault('other-passphrase', {
		owner: other.authStore.record.id,
		epoch: b.epoch
	});
	await otherApi.send('vault', {
		epoch: b.epoch,
		operationId: newId(),
		baseRevision: '',
		header: otherVault.header
	});
	const v = await createVault('encryption-passphrase', scope);
	const vaultRequest = { epoch: b.epoch, operationId: newId(), baseRevision: '', header: v.header };
	const receipt = await api.send('vault', vaultRequest);
	assert.equal(receipt.revision, v.header.revision);
	assert.deepEqual(await api.send('vault', vaultRequest), receipt);
	assert.equal((await api.bootstrap()).vault.format, 2);
	assert.equal(maintenance('jnote-restore-control', recoveryArgs).status, 0);
	assert.equal(
		(await api.bootstrap()).vault.format,
		2,
		'A recovery rerun preserves existing vault data.'
	);
	await expectStatus(
		() => api.send('vault', { ...vaultRequest, header: { ...v.header, revision: newId() } }),
		409
	);
	const noteId = newId(),
		pair = await createNoteKey(v.key, scope, noteId),
		revision = newId();
	const commit = {
		epoch: b.epoch,
		operationId: newId(),
		logicalId: noteId,
		action: 'create',
		baseRevision: '',
		revision,
		generation: 1,
		wrapper: pair.wrapper,
		summary: await encryptObject(
			{ title: 'Private title' },
			pair.key,
			context('summary', scope, noteId, revision)
		),
		ciphertext: await encryptObject(
			{ title: 'Private title', content: 'Private body' },
			pair.key,
			context('history', scope, noteId, revision)
		)
	};
	const created = await api.send('commit', commit);
	assert.ok(created.serverId);
	assert.deepEqual(await api.send('commit', commit), created);
	assert.equal((await admin.collection('jnote_content').getFullList()).length, 1);
	await expectStatus(
		() =>
			api.send('commit', {
				...commit,
				operationId: newId(),
				action: 'update',
				baseRevision: newId(),
				revision: newId()
			}),
		409
	);
	await expectStatus(
		() => api.send('commit', { ...commit, operationId: newId(), owner: other.authStore.record.id }),
		403
	);
	await expectStatus(
		() => api.send('commit', { ...commit, operationId: newId(), epoch: 'stale' }),
		409
	);
	await expectStatus(() => pb.send('/api/jnote/v2/bootstrap', { query: { protocol: 1 } }), 426);
	await expectStatus(() => pb.collection('jnote').update(created.serverId, { deleted: true }), 403);
	await expectStatus(() => pb.collection('jnote_content').create({ owner: scope.owner }), 403);
	await expectStatus(() => otherApi.content(b.epoch, noteId, revision), 404);
	assert.equal((await otherApi.changes(b.epoch, 0)).changes.length, 0);
	const changes = await api.changes(b.epoch, 0);
	assert.equal(changes.changes.length, 1);
	assert.equal(changes.changes[0].value.logicalId, noteId);
	assert.equal((await api.content(b.epoch, noteId, revision)).items[0].ciphertext.v, 2);
	// Invalid history write rolls back all head/change/grant/receipt writes.
	const before = (await api.bootstrap()).checkpoint;
	const collisionId = newId(),
		collisionPair = await createNoteKey(v.key, scope, collisionId);
	await expectStatus(
		() =>
			api.send('commit', {
				...commit,
				operationId: newId(),
				logicalId: collisionId,
				wrapper: collisionPair.wrapper
			}),
		400
	);
	assert.equal((await admin.collection('jnote_key_grants').getFullList()).length, 1);
	assert.equal((await admin.collection('jnote_operations').getFullList()).length, 3);
	await expectStatus(
		() =>
			api.send('commit', {
				...commit,
				operationId: newId(),
				logicalId: newId(),
				wrapper: { ...pair.wrapper, keyId: newId() }
			}),
		400
	);
	assert.equal((await api.bootstrap()).checkpoint, before);
	assert.equal((await admin.collection('jnote').getFullList()).length, 1);
	const newHeader = await rewrapVault(v.key, 'changed-passphrase', scope);
	await api.send('vault', {
		epoch: b.epoch,
		operationId: newId(),
		baseRevision: v.header.revision,
		header: newHeader
	});
	assert.deepEqual(
		(await api.content(b.epoch, noteId, revision)).items[0].ciphertext,
		commit.ciphertext
	);
	const objectId = newId(),
		objectRevision = newId();
	await api.send('object', {
		epoch: b.epoch,
		operationId: newId(),
		objectId,
		objectType: 'folder',
		baseRevision: '',
		revision: objectRevision,
		ciphertext: await encryptObject(
			{ name: 'Secret empty folder' },
			v.key,
			context('personal:folder', scope, objectId, objectRevision)
		)
	});
	assert.equal((await admin.collection('jnote_content').getFullList()).length, 1);
	const publication = await createPublication(
		'Published',
		'Public body',
		v.key,
		scope,
		noteId,
		revision
	);
	const publish = {
		epoch: b.epoch,
		operationId: newId(),
		shareId: publication.shareId,
		action: 'publish',
		baseRevision: '',
		publication
	};
	await api.send('share', publish);
	const anon = await fetch(`${url}/api/jnote/v2/public/${publication.shareId}`);
	assert.equal(anon.status, 200);
	const publicBody = await anon.json();
	assert.deepEqual(Object.keys(publicBody).sort(), ['ciphertext', 'revision']);
	assert.match(anon.headers.get('cache-control'), /no-store/);
	const link = await publicationLink(publication, v.key, scope, '', 'https://example.invalid');
	const decoded = await readPublication(publication.shareId, link.split('#')[1], async () => ({
		ok: true,
		json: async () => publicBody
	}));
	assert.equal(decoded.content, 'Public body');
	assert.equal((await fetch(`${url}/api/collections/jnote_public_shares/records`)).status, 403);
	await expectStatus(
		() =>
			otherApi.send('share', {
				...publish,
				operationId: newId(),
				baseRevision: publication.revision,
				action: 'disable',
				revision: newId()
			}),
		404
	);
	const refreshed = await republish(
		publication,
		'Republished',
		'Fresh snapshot',
		v.key,
		scope,
		revision
	);
	await api.send('share', {
		...publish,
		operationId: newId(),
		baseRevision: publication.revision,
		publication: refreshed
	});
	const freshResponse = await fetch(`${url}/api/jnote/v2/public/${publication.shareId}`);
	assert.equal((await freshResponse.json()).revision, refreshed.revision);
	const expires = await createPublication(
		'Expiry',
		'Expired later',
		v.key,
		scope,
		noteId,
		revision,
		new Date(Date.now() + 60000).toISOString()
	);
	await api.send('share', {
		...publish,
		operationId: newId(),
		shareId: expires.shareId,
		publication: expires
	});
	const expiresRecord = (await admin.collection('jnote_public_shares').getFullList()).find(
		(s) => s.shareId === expires.shareId
	);
	await admin
		.collection('jnote_public_shares')
		.update(expiresRecord.id, { expires: '2000-01-01T00:00:00.000Z' });
	assert.equal((await fetch(`${url}/api/jnote/v2/public/${expires.shareId}`)).status, 404);
	const second = await createPublication(
		'Published',
		'Independent',
		v.key,
		scope,
		noteId,
		revision
	);
	await api.send('share', {
		...publish,
		operationId: newId(),
		shareId: second.shareId,
		publication: second
	});
	await api.send('share', {
		epoch: b.epoch,
		operationId: newId(),
		shareId: publication.shareId,
		action: 'disable',
		baseRevision: refreshed.revision,
		revision: newId()
	});
	assert.equal((await fetch(`${url}/api/jnote/v2/public/${publication.shareId}`)).status, 404);
	assert.equal((await fetch(`${url}/api/jnote/v2/public/${second.shareId}`)).status, 200);
	await api.send('commit', {
		epoch: b.epoch,
		operationId: newId(),
		logicalId: noteId,
		action: 'delete',
		baseRevision: revision,
		revision: newId()
	});
	assert.equal((await fetch(`${url}/api/jnote/v2/public/${second.shareId}`)).status, 404);
	assert.equal((await admin.collection('jnote_content').getFullList()).length, 1);
	assert.equal((await admin.collection('jnote').getOne(created.serverId)).deleted, true);
	const publicStatuses = await Promise.all(
		Array.from({ length: 65 }, () =>
			fetch(`${url}/api/jnote/v2/public/${publication.shareId}`).then((r) => r.status)
		)
	);
	assert.ok(publicStatuses.includes(429), 'Anonymous lookups must be rate limited.');
	console.log(
		'Backend integration passed: vault, atomic commits, receipts, conflict/epoch/owner guards, locked generic writes, change feed, wrappers, public isolation and transactional revocation.'
	);
} catch (error) {
	console.error(logs);
	throw error;
} finally {
	server.kill('SIGTERM');
	if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
	await rm(dir, { recursive: true, force: true });
}
