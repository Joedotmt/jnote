import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import PocketBase from 'pocketbase';
import { newId } from '../src/lib/crypto.js';
const binary = process.env.POCKETBASE_BIN;
if (!binary) throw new Error('Set POCKETBASE_BIN.');
const dir = await mkdtemp(join(tmpdir(), 'jnote-cutover-'));
process.env.JNOTE_HOOKS_DIR = resolve('backend/pb_hooks');
const args = [
	'--automigrate=false',
	`--dir=${dir}`,
	`--hooksDir=${resolve('backend/pb_hooks')}`,
	`--migrationsDir=${resolve('backend/pb_migrations')}`
];
const credentials = ['admin@example.invalid', 'disposable-cutover-test-pass-123'];
spawnSync(binary, ['superuser', 'upsert', ...credentials, ...args]);
let server;
async function start() {
	server = spawn(binary, ['serve', ...args, '--http=127.0.0.1:18099'], { stdio: 'ignore' });
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch('http://127.0.0.1:18099/api/health')).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('Test server failed to start.');
}
async function stop() {
	server.kill();
	if (server.exitCode === null) await new Promise((r) => server.once('exit', r));
	server = null;
}
try {
	await start();
	const pb = new PocketBase('http://127.0.0.1:18099');
	await pb.collection('_superusers').authWithPassword(...credentials);
	const owner = await pb.collection('users').create({
		email: 'owner@example.invalid',
		password: 'disposable-owner-pass-123',
		passwordConfirm: 'disposable-owner-pass-123'
	});
	const otherOwner = await pb.collection('users').create({
		email: 'second-owner@example.invalid',
		password: 'disposable-owner-pass-123',
		passwordConfirm: 'disposable-owner-pass-123'
	});
	await pb.collection('users').create({
		email: 'unrelated-account@example.invalid',
		password: 'disposable-owner-pass-123',
		passwordConfirm: 'disposable-owner-pass-123'
	});
	const usersBefore = await pb.collection('users').getFullList({ sort: 'id' });
	// Replace only test JNote collections with the old schema. Preserve unrelated data.
	for (const name of [
		'jnote_public_shares',
		'jnote_changes',
		'jnote_operations',
		'jnote_private_objects',
		'jnote_key_grants',
		'jnote_content',
		'jnote',
		'jnote_vaults',
		'jnote_control'
	])
		await pb.collections.delete(name);
	await pb.collections.create({
		name: 'jnote',
		type: 'base',
		fields: [
			{ name: 'user', type: 'text' },
			{ name: 'title', type: 'text' },
			{ name: 'deleted', type: 'bool' }
		],
		createRule: '',
		updateRule: ''
	});
	await pb.collections.create({
		name: 'jnote_content',
		type: 'base',
		fields: [
			{
				name: 'note',
				type: 'relation',
				collectionId: (await pb.collections.getOne('jnote')).id,
				maxSelect: 1
			},
			{ name: 'content', type: 'text' }
		]
	});
	await pb.collections.create({
		name: 'unrelated_records',
		type: 'base',
		fields: [{ name: 'value', type: 'text' }]
	});
	await pb.collection('unrelated_records').create({ value: 'preserve' });
	const note = await pb
		.collection('jnote')
		.create({ user: owner.id, title: 'Legacy ciphertext', deleted: true });
	await pb.collection('jnote_content').create({ note: note.id, content: 'Old history' });
	const secondNote = await pb
		.collection('jnote')
		.create({ user: otherOwner.id, title: 'Second owner ciphertext' });
	await pb
		.collection('jnote_content')
		.create({ note: secondNote.id, content: 'Second owner history' });
	const legacyUser = new PocketBase('http://127.0.0.1:18099');
	await legacyUser
		.collection('users')
		.authWithPassword('owner@example.invalid', 'disposable-owner-pass-123');
	await assert.rejects(
		() => legacyUser.collection('jnote').create({ user: owner.id, title: 'Resurrection' }),
		(e) => e.status === 403
	);
	const epoch = newId();
	const command = (instance, id) =>
		spawnSync(binary, ['jnote-cutover', instance, id, epoch, ...args], {
			encoding: 'utf8',
			env: { ...process.env, JNOTE_INSTANCE: 'test-instance' }
		});
	const approvedOwners = [owner.id, otherOwner.id].sort().join(',');
	assert.notEqual(command('wrong-instance', approvedOwners).status, 0);
	assert.notEqual(command('test-instance', 'wrong-owner').status, 0);
	const schemaBefore = await pb.collections.getOne('jnote');
	assert.notEqual(
		command('test-instance', owner.id).status,
		0,
		'An unapproved owner blocks reset before closing rules.'
	);
	assert.deepEqual(await pb.collections.getOne('jnote'), schemaBefore);
	const referencing = await pb.collections.create({
		name: 'unrelated_reference',
		type: 'base',
		fields: [{ name: 'note', type: 'relation', collectionId: schemaBefore.id, maxSelect: 1 }]
	});
	assert.notEqual(
		command('test-instance', approvedOwners).status,
		0,
		'Unrelated relations block schema deletion.'
	);
	assert.deepEqual(await pb.collections.getOne('jnote'), schemaBefore);
	await pb.collections.delete(referencing.id);
	const reset = command('test-instance', approvedOwners);
	assert.equal(reset.status, 0, reset.stdout + reset.stderr);
	await legacyUser.collection('users').authRefresh();
	await stop();
	await start();
	await pb.collection('_superusers').authWithPassword(...credentials);
	assert.equal((await pb.collection('jnote').getFullList()).length, 0);
	assert.equal((await pb.collection('jnote_content').getFullList()).length, 0);
	assert.deepEqual(await pb.collection('users').getFullList({ sort: 'id' }), usersBefore);
	assert.equal((await pb.collection('unrelated_records').getFullList())[0].value, 'preserve');
	const control = (await pb.collection('jnote_control').getFullList())[0];
	assert.equal(control.epoch, epoch);
	assert.ok(control.resetReceipt);
	// Ordinary redeployment/rerun must retain new v2 records.
	await pb.collection('jnote').create({
		owner: owner.id,
		epoch,
		logicalId: newId(),
		revision: newId(),
		generation: 1,
		summary: { v: 2 }
	});
	await stop();
	assert.equal(command('test-instance', approvedOwners).status, 0);
	await start();
	await pb.collection('_superusers').authWithPassword(...credentials);
	assert.equal((await pb.collection('jnote').getFullList()).length, 1);
	const user = new PocketBase('http://127.0.0.1:18099');
	await user
		.collection('users')
		.authWithPassword('owner@example.invalid', 'disposable-owner-pass-123');
	await assert.rejects(
		() => user.collection('jnote').create({ title: 'Resurrect legacy' }),
		(e) => e.status === 403
	);
	console.log(
		'Cutover integration passed: wrong instance/owner rejected; allowlisted history/notes reset; user/unrelated data preserved; epoch/receipt recorded; rerun preserves new data; legacy writes closed.'
	);
} finally {
	if (server) await stop();
	await rm(dir, { recursive: true, force: true });
}
