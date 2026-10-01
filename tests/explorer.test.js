import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.$state = (value) => value;
globalThis.$derived = Object.assign((value) => value, {
	by: (derive) => derive()
});

const { JNoteState, buildFolderList } = await import('../src/lib/jnote.svelte.js');

function makeState(notes = []) {
	const state = new JNoteState();
	state.notes = notes.map((note) => ({
		title: '',
		content: '',
		folder: 'Notes',
		hasContent: true,
		...note
	}));
	state.persistDrafts = () => {};
	state.persistLocalNotes = () => {};
	state.persistPendingPushes = () => {};
	state.flushPendingPushes = () => {};
	state.persistFolder = () => {};
	state.removeFolderObject = () => {};
	return state;
}

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test('note selection supports replace, range, and toggle semantics', async () => {
	const state = makeState([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);

	await state.selectNote('a');
	assert.deepEqual(state.getSelectedNoteIds(), ['a']);

	await state.selectNote('c', { extend: true });
	assert.deepEqual(state.getSelectedNoteIds(), ['a', 'b', 'c']);
	assert.equal(state.currentNoteId, 'c');

	await state.selectNote('b', { toggle: true });
	assert.deepEqual(state.getSelectedNoteIds(), ['a', 'c']);
	assert.equal(state.currentNoteId, 'c');

	await state.selectNote('d', { toggle: true });
	assert.deepEqual(state.getSelectedNoteIds(), ['a', 'c', 'd']);
	assert.equal(state.currentNoteId, 'd');

	await state.selectNote('c');
	assert.deepEqual(state.getSelectedNoteIds(), ['c']);
	assert.equal(state.currentNoteId, 'c');
});

test('blank-space clearing and folder changes close the selected note', async () => {
	const state = makeState([
		{ id: 'a', folder: 'Notes' },
		{ id: 'b', folder: 'Archive' }
	]);

	await state.selectNote('a');
	state.clearNoteSelection({ closeDetail: false });
	assert.deepEqual(state.getSelectedNoteIds(), []);
	assert.equal(state.currentNoteId, null);
	assert.equal(state.noteLoadState, 'idle');

	await state.selectNote('a');
	state.selectFolder('Archive');
	assert.equal(state.currentFolder, 'Archive');
	assert.deepEqual(state.getSelectedNoteIds(), []);
	assert.equal(state.currentNoteId, null);
});

test('inline rename stays in the visible list on a mobile viewport', async () => {
	const originalWindow = globalThis.window;
	globalThis.window = { innerWidth: 500 };
	try {
		const state = makeState([{ id: 'a', title: 'Title' }]);
		state.replaceNoteSelection(['a'], 'a', 'a');
		state.currentNoteId = 'a';
		state.detailOpen = true;

		assert.equal(await state.beginRenameSelectedNote(), true);
		assert.equal(state.detailOpen, false);
		assert.equal(state.renamingNoteId, 'a');
	} finally {
		globalThis.window = originalWindow;
	}
});

test('creating a drag destination from the sidebar can preserve the source selection', async () => {
	const state = makeState([{ id: 'a', title: 'Selected' }]);
	await state.selectNote('a');

	state.createClientFolder('Destination', { select: false });

	assert.equal(state.currentFolder, 'Notes');
	assert.deepEqual(state.getSelectedNoteIds(), ['a']);
	assert.equal(state.currentNoteId, 'a');
	assert.equal(state.clientOnlyFolders.has('Destination'), true);
});

test('a completed async move does not clear a newer selection', async () => {
	const state = makeState([
		{ id: 'a', folder: 'Notes' },
		{ id: 'b', folder: 'Notes' },
		{ id: 'c', folder: 'Notes' }
	]);
	const releaseMove = deferred();
	state.moveNoteToFolder = async (noteId, folder) => {
		await releaseMove.promise;
		const note = state.notes.find((candidate) => candidate.id === noteId);
		note.folder = folder;
		return true;
	};
	await state.selectNote('a');
	await state.selectNote('b', { toggle: true });

	const moving = state.moveNotesToFolder(['a', 'b'], 'Archive');
	assert.deepEqual(state.getSelectedNoteIds(), ['a', 'b']);
	await state.selectNote('c');
	releaseMove.resolve();
	await moving;

	assert.deepEqual(state.getSelectedNoteIds(), ['c']);
	assert.equal(state.currentNoteId, 'c');
});

test('a failed move keeps the original selection available for retry', async () => {
	const state = makeState([{ id: 'a', folder: 'Notes' }]);
	state.moveNoteToFolder = async () => false;
	await state.selectNote('a');

	assert.equal(await state.moveNotesToFolder(['a'], 'Archive'), false);
	assert.deepEqual(state.getSelectedNoteIds(), ['a']);
	assert.equal(state.currentNoteId, 'a');
});

test('blank-space context actions clear the open selection and capture the current folder', async () => {
	const state = makeState([{ id: 'a', folder: 'Archive' }]);
	state.currentFolder = 'Archive';
	await state.selectNote('a');
	let prevented = false;
	let stopped = false;

	state.openBlankContextMenu({
		clientX: 120,
		clientY: 240,
		preventDefault() {
			prevented = true;
		},
		stopPropagation() {
			stopped = true;
		}
	});

	assert.equal(prevented, true);
	assert.equal(stopped, true);
	assert.deepEqual(state.getSelectedNoteIds(), []);
	assert.equal(state.currentNoteId, null);
	assert.deepEqual(state.contextMenu, {
		open: true,
		type: 'blank',
		surface: 'notes',
		noteId: null,
		folder: 'Archive',
		x: 120,
		y: 240
	});
});

test('folder-background context actions preserve note selection and target folder creation', async () => {
	const state = makeState([{ id: 'a', folder: 'Notes' }]);
	await state.selectNote('a');

	state.openBlankContextMenu(
		{
			clientX: 32,
			clientY: 64,
			preventDefault() {},
			stopPropagation() {}
		},
		'folders'
	);

	assert.deepEqual(state.getSelectedNoteIds(), ['a']);
	assert.equal(state.currentNoteId, 'a');
	assert.equal(state.contextMenu.type, 'blank');
	assert.equal(state.contextMenu.surface, 'folders');
});

test('opening a folder context menu preserves the note selection', async () => {
	const state = makeState([
		{ id: 'a', folder: 'Notes' },
		{ id: 'b', folder: 'Archive' }
	]);
	await state.selectNote('a');

	assert.equal(
		state.openFolderContextMenu(
			{
				clientX: 0,
				clientY: 0,
				currentTarget: {
					getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 44 })
				},
				preventDefault() {},
				stopPropagation() {}
			},
			'Archive'
		),
		true
	);

	assert.deepEqual(state.getSelectedNoteIds(), ['a']);
	assert.equal(state.currentNoteId, 'a');
	assert.equal(state.contextMenu.type, 'folder');
	assert.equal(state.contextMenu.folder, 'Archive');
	assert.deepEqual({ x: state.contextMenu.x, y: state.contextMenu.y }, { x: 48, y: 66 });
});

test('folder rename and delete wait for direct note moves to finish', async () => {
	const state = makeState([{ id: 'a', folder: 'Archive' }]);
	state.activeDirectMoves.add('move-in-flight');

	assert.equal(state.canManageFolder('Archive'), false);
	assert.equal(state.beginRenameFolder('Archive'), false);
	assert.equal(await state.deleteFolder('Archive', () => true), false);
	assert.equal(state.notes[0].folder, 'Archive');
});

test('inline note rename waits for that note’s direct move to finish', async () => {
	const state = makeState([{ id: 'a', folder: 'Notes' }]);
	await state.selectNote('a');
	state.activeDirectMoveNoteIds.add('a');

	assert.equal(state.canRenameNote('a'), false);
	assert.equal(await state.beginRenameSelectedNote(), false);
	assert.equal(state.renamingNoteId, null);
});

const { IDBFactory } = await import('fake-indexeddb');
const { openLocalDb } = await import('../src/lib/localDb.js');
const { generateKey, newId, context, decryptObject } = await import('../src/lib/crypto.js');
async function durableState(factory = new IDBFactory(), scope = { owner: 'a', epoch: 'epoch' }) {
	const state = new JNoteState();
	state.scope = scope;
	state.db = await openLocalDb(scope.owner, scope.epoch, factory);
	state.encryptionState = { key: await generateKey() };
	state.flushPendingPushes = () => {};
	return state;
}
test('explicit commits keep all local histories and ordered outbox; logical identity survives reconciliation', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	state.saveDraft(note.id, 'First', 'one');
	assert.equal(await state.commitNote(note.id, 'First', 'one'), true);
	state.saveDraft(note.id, 'Second', 'two');
	assert.equal(await state.commitNote(note.id, 'Second', 'two'), true);
	const operations = (await state.db.all('outbox'))
		.filter((o) => o.endpoint === 'commit')
		.sort((a, b) => a.order - b.order);
	assert.equal(operations.length, 2);
	const payloads = await Promise.all(
		operations.map((o) =>
			decryptObject(o.ciphertext, state.encryptionState.key, context('outbox', state.scope, o.id))
		)
	);
	assert.equal(payloads[0].action, 'create');
	assert.equal(payloads[1].action, 'update');
	assert.equal(payloads[1].baseRevision, payloads[0].revision);
	assert.equal((await state.db.all('contents')).length, 2);
	assert.equal((await state.db.all('drafts')).length, 0);
	assert.equal(state.currentNoteId, note.id);
	assert.equal(JSON.stringify(await state.db.all('contents')).includes('First'), false);
});
test('failed local commit retains draft, baseline, and reports persistence error', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	state.saveDraft(note.id, 'Draft', 'body');
	await state.localWork;
	state.db.commit = async () => {
		throw new Error('QuotaExceededError');
	};
	assert.equal(await state.commitNote(note.id, 'Draft', 'body'), false);
	assert.equal(state.drafts[note.id].content, 'body');
	assert.equal(note.revision, '');
	assert.match(state.persistenceError, /could not be saved/);
});
test('organization is encrypted, folders persist and folder moves do not create content history', async () => {
	const state = await durableState();
	state.createClientFolder('Private folder');
	await state.localWork;
	const note = state.createNewNote();
	await state.commitNote(note.id, 'Title', 'Body');
	assert.equal(await state.moveNoteToFolder(note.id, 'Private folder'), true);
	assert.equal((await state.db.all('contents')).length, 1);
	assert.equal(JSON.stringify(await state.db.all('objects')).includes('Private folder'), false);
	await state.loadNotes();
	assert.equal(state.notes[0].folder, 'Private folder');
	assert.equal(
		state.folders.includes('Private folder') || state.clientOnlyFolders.has('Private folder'),
		true
	);
});
test('restart renders encrypted drafts and current bodies without opening notes, and search includes all bodies', async () => {
	const state = await durableState();
	const first = state.createNewNote();
	await state.commitNote(first.id, 'Alpha', 'find-me body');
	const second = state.createNewNote();
	state.saveDraft(second.id, 'Uncommitted', 'other draft');
	await state.localWork;
	state.notes = [];
	state.drafts = {};
	await state.loadNotes();
	assert.equal(state.notes.length, 2);
	assert.equal(state.notes.find((n) => n.id === first.id).hasContent, true);
	state.searchQuery = 'find-me';
	assert.deepEqual(state.getVisibleNoteIds(), [first.id]);
	assert.equal(state.drafts[second.id].content, 'other draft');
});
test('soft deletion keeps committed history and queues a revision-checked deletion', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	await state.commitNote(note.id, 'Title', 'Body');
	assert.equal(await state.deleteNote(note.id, () => true), true);
	assert.equal((await state.db.get('notes', note.id)).deleted, true);
	assert.equal((await state.db.all('contents')).length, 1);
	assert.equal(state.notes.length, 0);
	await state.loadNotes();
	assert.equal(state.notes.length, 0);
});

test('remembered offline startup opens cached summaries and bodies without account or PBKDF2 checks', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	await state.commitNote(note.id, 'Cached', 'Offline body');
	const { rewrapVault, rememberVault } = await import('../src/lib/vault.js');
	await state.db.put('meta', {
		id: 'vault',
		value: await rewrapVault(state.encryptionState.key, 'passphrase', state.scope)
	});
	await state.db.put('protected', await rememberVault(state.encryptionState.key, state.scope));
	const previous = Object.fromEntries(
		['window', 'document', 'localStorage', 'indexedDB', 'navigator'].map((k) => [
			k,
			Object.getOwnPropertyDescriptor(globalThis, k)
		])
	);
	const storage = new Map([['jnote.account.v2', JSON.stringify(state.scope)]]);
	// This fixture has its own factory; use its open request by capturing the namespace.
	const reopened = state.db;
	const persistentFactory = {
		open() {
			const req = {};
			queueMicrotask(() => {
				req.result = reopened.db;
				req.onsuccess();
			});
			return req;
		}
	};
	try {
		Object.defineProperty(globalThis, 'indexedDB', {
			configurable: true,
			value: persistentFactory
		});
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { onLine: false }
		});
		globalThis.window = {
			location: { href: 'http://localhost:5173/', origin: 'http://localhost:5173' },
			__joeAccountsReady: Promise.resolve(false),
			JNOTE_CONFIG: { accountsOrigins: ['http://localhost:5173'] },
			setInterval: () => 0
		};
		globalThis.document = { getElementById: () => ({ textContent: '' }) };
		globalThis.localStorage = {
			getItem: (k) => storage.get(k) || null,
			setItem: (k, v) => storage.set(k, v),
			removeItem: (k) => storage.delete(k)
		};
		const resumed = new JNoteState();
		await resumed.initialize();
		for (let i = 0; i < 30 && (!resumed.accountReady || resumed.notes[0]?.hasContent !== true); i++)
			await new Promise((r) => setTimeout(r, 1));
		assert.equal(resumed.unlockMode, 'ready');
		assert.equal(resumed.cloudState, 'offline');
		assert.equal(resumed.notes[0].content, 'Offline body');
		await resumed.lock();
		assert.equal(resumed.notes.length, 0);
		assert.equal(resumed.encryptionState, null);
		assert.equal((await resumed.db.all('outbox')).length, 1);
		resumed.initialized = false;
	} finally {
		for (const [k, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, k, descriptor);
			else delete globalThis[k];
		}
	}
});

test('conflict copy preserves every dependent offline content commit', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	await state.commitNote(note.id, 'First', 'one');
	await state.commitNote(note.id, 'Second', 'two');
	const operations = (await state.db.all('outbox'))
		.filter((o) => o.endpoint === 'commit')
		.sort((a, b) => a.order - b.order);
	const conflict = { ...operations[0], conflict: true };
	await state.db.put('outbox', conflict);
	const remoteRevision = newId(),
		pair = await state.keyFor(note.id);
	const { encryptObject } = await import('../src/lib/crypto.js');
	const remote = {
		logicalId: note.id,
		revision: remoteRevision,
		summaryRevision: remoteRevision,
		generation: 1,
		summary: await encryptObject(
			{ title: 'Cloud' },
			pair.key,
			context('summary', state.scope, note.id, remoteRevision)
		),
		deleted: false
	};
	state.api = {
		changes: async () => ({
			changes: [{ type: 'note', objectId: note.id, value: remote }],
			cursor: 1,
			more: false
		}),
		content: async () => ({
			items: [
				{
					logicalId: note.id,
					revision: remoteRevision,
					generation: 1,
					ciphertext: await encryptObject(
						{ title: 'Cloud', content: 'remote body' },
						pair.key,
						context('history', state.scope, note.id, remoteRevision)
					)
				}
			]
		})
	};
	await state.resolveConflictCopy(conflict);
	const remaining = (await state.db.all('outbox'))
		.filter((o) => o.endpoint === 'commit')
		.sort((a, b) => a.order - b.order);
	assert.equal(remaining.length, 2);
	assert.equal(remaining[0].objectId, remaining[1].objectId);
	assert.notEqual(remaining[0].objectId, note.id);
	const bodies = (await state.db.all('contents')).filter(
		(b) => b.logicalId === remaining[0].objectId
	);
	assert.equal(bodies.length, 2);
	assert.equal(state.notes.find((n) => n.id === remaining[0].objectId).content, 'two');
});

test('export includes downloaded new-note histories and soft-deleted records', async () => {
	const state = await durableState();
	const note = state.createNewNote();
	await state.commitNote(note.id, 'Version one', 'first body');
	await state.commitNote(note.id, 'Version two', 'second body');
	await state.deleteNote(note.id, () => true);
	const exported = await state.buildPlaintextExport();
	assert.equal(exported.formatVersion, 2);
	assert.equal(exported.historyCoverage, 'downloaded-only');
	assert.equal(exported.notes[0].deleted, true);
	assert.equal(exported.notes[0].title, 'Version two');
	assert.equal(exported.notes[0].versions.length, 2);
});
