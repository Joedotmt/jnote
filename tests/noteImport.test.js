import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { normalizeNoteImport } from '../src/lib/noteImport.js';
import { openLocalDb } from '../src/lib/localDb.js';
import { generateKey, context, decryptObject } from '../src/lib/crypto.js';

globalThis.$state = (value) => value;
globalThis.$derived = Object.assign((value) => value, { by: (derive) => derive() });
const { JNoteState } = await import('../src/lib/jnote.svelte.js');

function legacyBackup() {
	return {
		format: 'jnote.plaintext-export',
		formatVersion: 1,
		notes: [
			{
				id: 'old-note',
				title: 'Current',
				folder: 'Work',
				deleted: false,
				versions: [
					{
						id: 'old-version',
						title: 'Original',
						content: 'first body',
						created: '2025-01-01T10:00:00Z'
					},
					{
						id: 'new-version',
						title: 'Current',
						content: 'second body',
						created: '2025-01-02T10:00:00Z'
					}
				]
			},
			{
				id: 'deleted',
				title: 'Archived',
				folder: 'Old',
				deleted: true,
				versions: [{ title: 'Archived', content: 'keep this history' }]
			}
		],
		localChanges: {
			pendingPushes: [
				{ noteId: 'old-note', action: 'update', title: '', content: '', folder: 'Moved' }
			],
			drafts: [
				{ noteId: 'old-note', title: 'Draft', content: 'unsaved text', folder: 'Moved' },
				{ noteId: 'local-only', title: 'Offline', content: 'only on device', folder: 'Notes' }
			]
		},
		settings: { customCss: 'do not apply this' }
	};
}

test('pre-overhaul exports recover folders, all histories, unsaved text and local-only notes', () => {
	const plan = normalizeNoteImport(legacyBackup());
	assert.equal(plan.activeCount, 2);
	assert.equal(plan.deletedCount, 1);
	assert.equal(plan.versionCount, 5);
	assert.equal(plan.notes[0].folder, 'Moved');
	assert.deepEqual(
		plan.notes[0].versions.map((v) => v.content),
		['first body', 'second body', 'unsaved text']
	);
	assert.equal(plan.notes[1].deleted, true);
	assert.equal(plan.notes[2].versions[0].content, 'only on device');
});

test('v2 backups select the explicit head, keep empty text and recover orphan drafts', () => {
	const plan = normalizeNoteImport({
		format: 'jnote.plaintext-export',
		formatVersion: 2,
		notes: [
			{
				id: 'note',
				revision: 'current',
				title: '',
				versions: [
					{ revision: 'current', title: '', content: '', created: null },
					{ revision: 'old', title: 'Old', content: 'earlier', created: null }
				]
			}
		],
		drafts: { orphan: { title: 'Only draft', content: 'draft text', folder: 'Drafts' } }
	});
	assert.equal(plan.notes[0].versions.at(-1).content, '');
	assert.equal(plan.notes[0].versions.at(-1).title, '');
	assert.equal(plan.notes[1].folder, 'Drafts');
	const olderV2 = normalizeNoteImport({
		format: 'jnote.plaintext-export',
		formatVersion: 2,
		notes: [
			{
				id: 'n',
				title: 'Same',
				versions: [
					{ title: 'Same', content: 'latest', created: '2025-02-02T10:00:00Z' },
					{ title: 'Same', content: 'older', created: '2025-02-01T10:00:00Z' }
				]
			}
		]
	});
	assert.equal(olderV2.notes[0].versions.at(-1).content, 'latest');
});

test('pending legacy commits and deletions are recovered without duplicating the current body', () => {
	const data = legacyBackup();
	data.localChanges.drafts = [];
	data.localChanges.pendingPushes = [
		{
			noteId: 'old-note',
			action: 'update',
			title: 'Queued',
			content: 'queued text',
			folder: 'Work'
		},
		{ noteId: 'deleted', action: 'delete', title: '', content: '', folder: 'Notes' }
	];
	const plan = normalizeNoteImport(data);
	assert.equal(plan.notes[0].versions.at(-1).content, 'queued text');
	assert.equal(plan.notes[1].versions.length, 1);
	assert.equal(plan.notes[1].deleted, true);
});

test('invalid, unsupported, duplicate or oversized backups are rejected before saving', () => {
	for (const data of [
		null,
		[],
		{ format: 'other', formatVersion: 1, notes: [] },
		{ format: 'jnote.plaintext-export', formatVersion: 3, notes: [] }
	])
		assert.throws(() => normalizeNoteImport(data), /JSON backup/);
	const data = legacyBackup();
	data.notes[1].versions[0].content = { ciphertext: 'not plaintext' };
	assert.throws(() => normalizeNoteImport(data), /missing its note text/);
	data.notes[1] = data.notes[0];
	assert.throws(() => normalizeNoteImport(data), /duplicate identity/);
	data.notes = [data.notes[0]];
	data.notes[0].versions[0].title = 'a'.repeat(25000);
	assert.throws(() => normalizeNoteImport(data), /too large/);
});

async function stateForImport() {
	const state = new JNoteState();
	state.scope = { owner: 'import-owner', epoch: 'epoch' };
	state.db = await openLocalDb(state.scope.owner, state.scope.epoch, new IDBFactory());
	state.encryptionState = { key: await generateKey() };
	state.flushPendingPushes = () => {};
	return state;
}

test('import adds encrypted copies with ordered history chains and preserves existing notes and drafts', async () => {
	const state = await stateForImport();
	const existing = state.createNewNote();
	await state.commitNote(existing.id, 'Existing', 'existing body');
	state.saveDraft(existing.id, 'Existing draft', 'keep draft');
	await state.localWork;
	const previousHead = await state.db.get('notes', existing.id);
	const previousDraft = await state.db.get('drafts', existing.id);
	state.customCss = 'keep my CSS';
	assert.equal(await state.importNotes(legacyBackup()), true);
	assert.deepEqual(await state.db.get('notes', existing.id), previousHead);
	assert.deepEqual(await state.db.get('drafts', existing.id), previousDraft);
	assert.equal(state.customCss, 'keep my CSS');
	assert.equal(state.notes.length, 3);
	assert.equal(state.notes.find((n) => n.title === 'Draft').folder, 'Moved');
	assert.equal(state.notes.find((n) => n.title === 'Draft').content, 'unsaved text');
	const stored = await state.db.all('notes');
	assert.equal(stored.filter((n) => n.deleted).length, 1);
	assert.equal(
		stored.some((n) => ['old-note', 'deleted', 'local-only'].includes(n.id)),
		false
	);
	const outbox = (await state.db.all('outbox')).sort((a, b) => a.order - b.order);
	const payloads = await Promise.all(
		outbox.map((o) =>
			decryptObject(o.ciphertext, state.encryptionState.key, context('outbox', state.scope, o.id))
		)
	);
	const imported = state.notes.find((n) => n.title === 'Draft');
	const chain = payloads.filter((p) => p.logicalId === imported.id);
	assert.deepEqual(
		chain.map((p) => p.action),
		['create', 'update', 'update']
	);
	assert.equal(chain[1].baseRevision, chain[0].revision);
	assert.equal(chain[2].baseRevision, chain[1].revision);
	assert.equal((await state.db.all('contents')).length, 6);
	assert.equal(JSON.stringify(await state.db.all('contents')).includes('unsaved text'), false);
	assert.equal(JSON.stringify(await state.db.all('objects')).includes('Moved'), false);
	const exported = await state.buildPlaintextExport();
	assert.equal(
		exported.notes.find((n) => n.id === imported.id).versions.find((v) => v.title === 'Original')
			.created,
		'2025-01-01T10:00:00Z'
	);
	assert.equal(exported.notes.find((n) => n.id === imported.id).revision, imported.revision);
	state.notes = [];
	await state.loadNotes();
	assert.equal(state.notes.find((n) => n.id === imported.id).content, 'unsaved text');
	state.db.close();
});

test('a failed import transaction rolls back every new note, history and upload request', async () => {
	const state = await stateForImport();
	const existing = state.createNewNote();
	await state.commitNote(existing.id, 'Keep', 'untouched');
	const before = {};
	for (const name of ['notes', 'contents', 'grants', 'objects', 'outbox', 'meta'])
		before[name] = await state.db.all(name);
	const transaction = state.db.transaction.bind(state.db);
	state.db.transaction = (names, mode, work) =>
		transaction(names, mode, async (stores) => {
			if (names.includes('contents') && names.includes('objects') && mode === 'readwrite') {
				const put = stores.contents.put;
				let writes = 0;
				stores.contents.put = async (value) => {
					if (++writes === 2) throw new Error('QuotaExceededError');
					return put(value);
				};
			}
			return work(stores);
		});
	assert.equal(await state.importNotes(legacyBackup()), false);
	assert.match(state.importError, /No notes were added/);
	for (const name of Object.keys(before)) assert.deepEqual(await state.db.all(name), before[name]);
	assert.equal(state.notes.length, 1);
	assert.equal(state.notes[0].id, existing.id);
	state.db.close();
});
