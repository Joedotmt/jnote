import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.$state = (value) => value;
globalThis.$derived = Object.assign((value) => value, {
  by: (derive) => derive()
});

const { JNoteState } = await import('../src/lib/jnote.svelte.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('a folder move made during note creation is carried to the follow-up push', () => {
  const state = new JNoteState();
  const localNoteId = 'local-1';
  const originalPush = {
    id: 'create-1',
    action: 'create',
    noteId: localNoteId,
    title: 'Title',
    content: 'Body',
    folder: 'Notes'
  };
  const movedPush = {
    ...originalPush,
    folder: 'Archive'
  };

  state.notes = [{
    id: localNoteId,
    title: 'Title',
    content: 'Body',
    folder: 'Archive',
    isLocalOnly: true
  }];
  state.localNotes = { [localNoteId]: { ...state.notes[0] } };
  state.pendingPushes = { [localNoteId]: movedPush };
  state.folderModal = { open: true, mode: 'move', noteId: localNoteId };
  state.contextMenu = { open: true, noteId: localNoteId, x: 10, y: 10 };
  state.persistPendingPushes = () => {};
  state.persistDrafts = () => {};
  state.persistLocalNotes = () => {};
  let scheduledNoteId = null;
  state.flushNotePush = (noteId) => {
    scheduledNoteId = noteId;
  };

  state.applyCreatePushResult(
    localNoteId,
    originalPush,
    { id: 'cloud-1', updated: '2026-09-08T00:00:00.000Z' },
    { id: 'version-1' },
    movedPush
  );

  assert.equal(state.pendingPushes['cloud-1'].action, 'update');
  assert.equal(state.pendingPushes['cloud-1'].folder, 'Archive');
  assert.equal(state.pendingPushes['cloud-1'].syncContent, false);
  assert.equal(state.pendingPushes['cloud-1'].syncFolder, true);
  assert.equal(scheduledNoteId, 'cloud-1');
  assert.equal(state.folderModal.noteId, 'cloud-1');
  assert.equal(state.contextMenu.open, false);
  assert.equal(state.contextMenu.noteId, null);
});

test('a reconciled follow-up push encrypts and updates the moved folder', async () => {
  const state = new JNoteState();
  const calls = [];
  state.notes = [{ id: 'cloud-1', title: 'Title', content: 'Body', folder: 'Archive' }];
  state.pendingPushes = {
    'cloud-1': {
      id: 'update-1',
      action: 'update',
      noteId: 'cloud-1',
      title: 'Title',
      content: 'Body',
      folder: 'Archive',
      syncContent: false,
      syncFolder: true
    }
  };
  state.persistPendingPushes = () => {};
  state.encryptString = async (value) => `encrypted:${value}`;
  state.encryptNoteContentPayload = async (title, content) => ({ title, content });
  state.client = {
    collection(name) {
      return {
        async update(id, payload) {
          calls.push({ operation: 'update', name, id, payload });
          return { id, updated: '2026-09-08T00:01:00.000Z' };
        },
        async create(payload) {
          calls.push({ operation: 'create', name, payload });
          return { id: 'version-2' };
        }
      };
    }
  };

  await state.flushNotePush('cloud-1');

  assert.deepEqual(calls[0], {
    operation: 'update',
    name: 'jnote',
    id: 'cloud-1',
    payload: {
      folder: 'encrypted:Archive'
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(state.pendingPushes['cloud-1'], undefined);
  assert.equal(state.notes[0].folder, 'Archive');
});

test('a newer move is sequenced behind an in-flight content push', async () => {
  const state = new JNoteState();
  state.notes = [{ id: 'cloud-1', title: 'Title', content: 'Body', folder: 'Notes' }];
  state.pendingPushes = {
    'cloud-1': {
      id: 'update-1',
      action: 'update',
      noteId: 'cloud-1',
      title: 'Title',
      content: 'Body',
      folder: 'Notes',
      syncContent: true,
      syncFolder: false
    }
  };
  state.activePushIds.set('cloud-1', 'update-1');
  state.persistPendingPushes = () => {};
  state.flushNotePush = () => {};

  await state.moveNoteToFolder('cloud-1', 'Archive');

  assert.notEqual(state.pendingPushes['cloud-1'].id, 'update-1');
  assert.equal(state.pendingPushes['cloud-1'].folder, 'Archive');
  assert.equal(state.pendingPushes['cloud-1'].syncContent, true);
  assert.equal(state.pendingPushes['cloud-1'].syncFolder, true);
  assert.equal(state.pendingPushes['cloud-1'].contentCoveredBy, 'update-1');
  assert.equal(state.notes[0].folder, 'Archive');
});

test('a successful in-flight commit lets its dependent move skip duplicate history', async () => {
  const state = new JNoteState();
  const firstUpdateStarted = deferred();
  const releaseFirstUpdate = deferred();
  const calls = [];
  state.notes = [{ id: 'cloud-1', title: 'Title', content: 'Body', folder: 'Notes' }];
  state.pendingPushes = {
    'cloud-1': {
      id: 'update-1',
      action: 'update',
      noteId: 'cloud-1',
      title: 'Title',
      content: 'Body',
      folder: 'Notes',
      syncContent: true,
      syncFolder: false
    }
  };
  state.persistPendingPushes = () => {};
  state.encryptString = async (value) => `encrypted:${value}`;
  state.encryptNoteContentPayload = async (title, content) => ({ title, content });
  state.client = {
    collection(name) {
      return {
        async update(id, payload) {
          calls.push({ operation: 'update', name, id, payload });
          if (calls.filter((call) => call.operation === 'update').length === 1) {
            firstUpdateStarted.resolve();
            await releaseFirstUpdate.promise;
          }
          return { id, updated: '2026-09-08T00:01:00.000Z' };
        },
        async create(payload) {
          calls.push({ operation: 'create', name, payload });
          return { id: 'version-2' };
        }
      };
    }
  };

  const flushing = state.flushNotePush('cloud-1');
  await firstUpdateStarted.promise;
  await state.moveNoteToFolder('cloud-1', 'Archive');
  releaseFirstUpdate.resolve();
  await flushing;

  const historyCreates = calls.filter((call) => call.name === 'jnote_content');
  const noteUpdates = calls.filter((call) => call.name === 'jnote');
  assert.equal(historyCreates.length, 1);
  assert.equal(noteUpdates.length, 2);
  assert.deepEqual(noteUpdates[1].payload, { folder: 'encrypted:Archive' });
  assert.equal(state.pendingPushes['cloud-1'], undefined);
});

test('a new commit preserves a queued folder update', () => {
  const state = new JNoteState();
  state.notes = [{ id: 'cloud-1', title: 'Title', content: 'Body', folder: 'Archive' }];
  state.pendingPushes = {
    'cloud-1': {
      id: 'move-1',
      action: 'update',
      noteId: 'cloud-1',
      title: 'Title',
      content: 'Body',
      folder: 'Archive',
      syncContent: false,
      syncFolder: true,
      contentCoveredBy: 'older-update'
    }
  };
  state.persistPendingPushes = () => {};
  state.flushNotePush = () => {};

  state.queuePush('cloud-1', 'Changed title', 'Changed body');

  assert.equal(state.pendingPushes['cloud-1'].title, 'Changed title');
  assert.equal(state.pendingPushes['cloud-1'].content, 'Changed body');
  assert.equal(state.pendingPushes['cloud-1'].folder, 'Archive');
  assert.equal(state.pendingPushes['cloud-1'].syncContent, true);
  assert.equal(state.pendingPushes['cloud-1'].syncFolder, true);
  assert.equal(state.pendingPushes['cloud-1'].contentCoveredBy, undefined);
});

test('a persisted folder-only push does not shadow newer remote content', () => {
  const state = new JNoteState();
  const note = {
    id: 'cloud-1',
    title: 'Fresh remote title',
    content: 'Fresh remote body',
    folder: 'Archive',
    hasContent: true
  };
  state.notes = [note];
  state.pendingPushes = {
    'cloud-1': {
      id: 'move-1',
      action: 'update',
      noteId: 'cloud-1',
      title: 'Stale title',
      content: 'Stale body',
      folder: 'Archive',
      syncContent: false,
      syncFolder: true
    }
  };

  assert.equal(state.getDisplayTitle(note), 'Fresh remote title');
  assert.deepEqual(state.getCommittedNote(note), note);
  assert.equal(state.getEditorValue(note).content, 'Fresh remote body');
});

test('key migration waits for a direct cloud folder move', async () => {
  const state = new JNoteState();
  state.encryptionState = {};
  state.activeDirectMoves.add('move-1');

  await assert.rejects(
    () => state.changeDecryptionKey('current', 'new'),
    /current cloud write/
  );
  assert.equal(state.isKeyMigrationRunning, false);
  assert.match(state.beforeUnloadMessage(), /folder move/);
});
