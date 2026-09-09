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
  state.flushNotePush = () => {};
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
  const state = makeState([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' }
  ]);

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

test('local-to-cloud reconciliation updates selection, rename, and move targets', () => {
  const state = makeState([{
    id: 'local-1',
    title: 'Title',
    content: 'Body',
    isLocalOnly: true
  }]);
  state.localNotes = { 'local-1': { ...state.notes[0] } };
  state.replaceNoteSelection(['local-1'], 'local-1', 'local-1');
  state.currentNoteId = 'local-1';
  state.renamingNoteId = 'local-1';
  state.renameDraftValue = 'Typing';
  state.folderModal = {
    open: true,
    mode: 'move',
    noteId: 'local-1',
    noteIds: ['local-1']
  };

  state.applyCreatePushResult(
    'local-1',
    {
      id: 'create-1',
      action: 'create',
      noteId: 'local-1',
      title: 'Title',
      content: 'Body',
      folder: 'Notes'
    },
    { id: 'cloud-1', updated: '2026-09-09T00:00:00.000Z' },
    { id: 'version-1' },
    null
  );

  assert.deepEqual(state.getSelectedNoteIds(), ['cloud-1']);
  assert.equal(state.currentNoteId, 'cloud-1');
  assert.equal(state.selectionAnchorId, 'cloud-1');
  assert.equal(state.focusedNoteId, 'cloud-1');
  assert.equal(state.renamingNoteId, 'cloud-1');
  assert.equal(state.renameDraftValue, 'Typing');
  assert.equal(state.folderModal.noteId, 'cloud-1');
  assert.deepEqual(state.folderModal.noteIds, ['cloud-1']);
});

test('bulk delete confirms once, removes the open selection, and retains an empty folder for the session', async () => {
  const state = makeState([
    { id: 'a', title: 'One', folder: 'Archive' },
    { id: 'b', title: 'Two', folder: 'Archive' },
    { id: 'c', title: 'Three', folder: 'Notes' }
  ]);
  state.saveDraft('a', 'One draft', 'Unsaved', 'Archive');
  await state.selectNote('a');
  await state.selectNote('b', { toggle: true });
  let confirmation = '';
  let confirmationCount = 0;

  const deleted = state.deleteNote('b', (message) => {
    confirmation = message;
    confirmationCount += 1;
    return true;
  });

  assert.equal(deleted, true);
  assert.equal(confirmationCount, 1);
  assert.match(confirmation, /Delete 2 selected notes/);
  assert.match(confirmation, /unsaved changes/);
  assert.deepEqual(state.notes.map((note) => note.id), ['c']);
  assert.deepEqual(state.getSelectedNoteIds(), []);
  assert.equal(state.currentNoteId, null);
  assert.equal(state.pendingPushes.a.action, 'delete');
  assert.equal(state.pendingPushes.b.action, 'delete');
  assert.equal(state.clientOnlyFolders.has('Archive'), true);
});

test('inline rename commits a normal history push without consuming an unsaved body draft', async () => {
  const state = makeState([{
    id: 'a',
    title: 'Original',
    content: 'Committed body'
  }]);
  await state.selectNote('a');
  state.saveDraft('a', 'Draft title', 'Unsaved body', 'Notes');

  assert.equal(await state.beginRenameSelectedNote(), true);
  assert.equal(state.renameDraftValue, 'Draft title');
  state.setRenameDraft('Renamed');
  assert.equal(state.commitRename(), true);

  assert.equal(state.notes[0].title, 'Renamed');
  assert.equal(state.pendingPushes.a.action, 'update');
  assert.equal(state.pendingPushes.a.title, 'Renamed');
  assert.equal(state.pendingPushes.a.content, 'Committed body');
  assert.deepEqual(
    { title: state.drafts.a.title, content: state.drafts.a.content },
    { title: 'Renamed', content: 'Unsaved body' }
  );
  assert.equal(state.renamingNoteId, null);
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

test('an empty client folder is session-only and becomes note-backed when used', () => {
  const state = makeState();
  const folder = state.createClientFolder('Projects');

  assert.equal(folder, 'Projects');
  assert.equal(state.currentFolder, 'Projects');
  assert.equal(state.clientOnlyFolders.has('Projects'), true);
  assert.deepEqual(buildFolderList(state.notes, state.clientOnlyFolders), ['Notes', 'Projects']);

  const note = state.createNewNote('Projects');
  assert.equal(note.folder, 'Projects');
  assert.equal(state.clientOnlyFolders.has('Projects'), false);
  assert.deepEqual(buildFolderList(state.notes, state.clientOnlyFolders), ['Notes', 'Projects']);

  const refreshedState = makeState([{ ...note }]);
  assert.deepEqual(buildFolderList(refreshedState.notes, refreshedState.clientOnlyFolders), ['Notes', 'Projects']);
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

test('renaming a local note during creation queues the new name behind the active create', async () => {
  const state = makeState([{
    id: 'local-1',
    title: 'Original',
    content: 'Committed body',
    isLocalOnly: true
  }]);
  state.localNotes = { 'local-1': { ...state.notes[0] } };
  state.pendingPushes = {
    'local-1': {
      id: 'create-1',
      action: 'create',
      noteId: 'local-1',
      title: 'Original',
      content: 'Committed body',
      folder: 'Notes',
      syncContent: true
    }
  };
  state.activePushes.add('local-1');
  await state.selectNote('local-1');
  state.saveDraft('local-1', 'Original', 'Still typing', 'Notes');

  await state.beginRenameSelectedNote();
  const previousPushId = state.pendingPushes['local-1'].id;
  state.commitRename('Renamed while creating');

  assert.notEqual(state.pendingPushes['local-1'].id, previousPushId);
  assert.equal(state.pendingPushes['local-1'].action, 'create');
  assert.equal(state.pendingPushes['local-1'].title, 'Renamed while creating');
  assert.equal(state.pendingPushes['local-1'].content, 'Committed body');
  assert.equal(state.drafts['local-1'].title, 'Renamed while creating');
  assert.equal(state.drafts['local-1'].content, 'Still typing');
});

test('dragging a selected group onto a client folder moves the full selection', async () => {
  const state = makeState([
    { id: 'local-1', title: 'One', isLocalOnly: true },
    { id: 'local-2', title: 'Two', isLocalOnly: true }
  ]);
  state.localNotes = {
    'local-1': { ...state.notes[0] },
    'local-2': { ...state.notes[1] }
  };
  state.clientOnlyFolders.add('Archive');
  await state.selectNote('local-1');
  await state.selectNote('local-2', { toggle: true });

  const transferred = new Map();
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setData(type, value) {
      transferred.set(type, value);
    }
  };
  assert.equal(state.beginNoteDrag({ dataTransfer, preventDefault() {} }, 'local-2'), true);
  assert.deepEqual(state.draggedNoteIds, ['local-1', 'local-2']);
  assert.equal(dataTransfer.effectAllowed, 'move');
  assert.deepEqual(
    JSON.parse(transferred.get('application/x-jnote-note-ids')),
    ['local-1', 'local-2']
  );

  let dragPrevented = false;
  state.dragNotesOverFolder({
    dataTransfer,
    preventDefault() {
      dragPrevented = true;
    }
  }, 'Archive');
  assert.equal(dragPrevented, true);
  assert.equal(state.dragOverFolder, 'Archive');

  await state.dropNotesOnFolder({
    preventDefault() {},
    stopPropagation() {}
  }, 'Archive');
  assert.deepEqual(state.notes.map((note) => note.folder), ['Archive', 'Archive']);
  assert.deepEqual(state.getSelectedNoteIds(), []);
  assert.deepEqual(state.draggedNoteIds, []);
  assert.equal(state.clientOnlyFolders.has('Archive'), false);
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

test('a late move response cannot remove an empty destination after the note was deleted', async () => {
  const state = makeState([{ id: 'a', folder: 'Notes' }]);
  const releaseMove = deferred();
  state.clientOnlyFolders.add('Archive');
  state.encryptString = async (value) => `encrypted:${value}`;
  state.client = {
    collection() {
      return {
        async update() {
          await releaseMove.promise;
          return { updated: '2026-09-09T00:00:00.000Z' };
        }
      };
    }
  };

  const moving = state.moveNoteToFolder('a', 'Archive');
  state.deleteNote('a', () => true);
  releaseMove.resolve();
  await moving;

  assert.equal(state.notes.length, 0);
  assert.equal(state.clientOnlyFolders.has('Archive'), true);
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
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
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

  state.openBlankContextMenu({
    clientX: 32,
    clientY: 64,
    preventDefault() {},
    stopPropagation() {}
  }, 'folders');

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

  assert.equal(state.openFolderContextMenu({
    clientX: 0,
    clientY: 0,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 44 })
    },
    preventDefault() {},
    stopPropagation() {}
  }, 'Archive'), true);

  assert.deepEqual(state.getSelectedNoteIds(), ['a']);
  assert.equal(state.currentNoteId, 'a');
  assert.equal(state.contextMenu.type, 'folder');
  assert.equal(state.contextMenu.folder, 'Archive');
  assert.deepEqual(
    { x: state.contextMenu.x, y: state.contextMenu.y },
    { x: 48, y: 66 }
  );
});

test('renaming a backed folder queues folder-only updates and preserves its open note', async () => {
  const state = makeState([{ id: 'a', title: 'Selected', folder: 'Archive' }]);
  state.currentFolder = 'Archive';
  state.saveDraft('a', 'Selected', 'Draft body', 'Archive');
  await state.selectNote('a');

  assert.equal(state.beginRenameFolder('Archive'), true);
  assert.equal(await state.commitFolderRename('Projects'), true);

  assert.equal(state.notes[0].folder, 'Projects');
  assert.equal(state.currentFolder, 'Projects');
  assert.deepEqual(state.getSelectedNoteIds(), ['a']);
  assert.equal(state.currentNoteId, 'a');
  assert.equal(state.drafts.a.folder, 'Projects');
  assert.equal(state.pendingPushes.a.action, 'update');
  assert.equal(state.pendingPushes.a.syncContent, false);
  assert.equal(state.pendingPushes.a.syncFolder, true);
  assert.equal(state.pendingPushes.a.folder, 'Projects');
  assert.equal(state.clientOnlyFolders.has('Archive'), false);
});

test('folder rename supports casing changes but rejects collisions and the Notes root', async () => {
  const state = makeState([
    { id: 'a', folder: 'Archive' },
    { id: 'b', folder: 'Projects' }
  ]);
  state.currentFolder = 'Archive';

  assert.equal(state.beginRenameFolder('Archive'), true);
  assert.equal(await state.commitFolderRename('archive'), true);
  assert.equal(state.notes[0].folder, 'archive');
  assert.equal(state.currentFolder, 'archive');

  assert.equal(state.beginRenameFolder('archive'), true);
  assert.equal(await state.commitFolderRename('Projects'), false);
  assert.equal(state.notes[0].folder, 'archive');
  assert.equal(state.beginRenameFolder('Notes'), false);
  assert.equal(state.deleteFolder('Notes', () => true), false);
});

test('deleting a different folder preserves the current note selection and soft-deletes its notes', async () => {
  const state = makeState([
    { id: 'a', title: 'Keep', folder: 'Notes' },
    { id: 'b', title: 'Remove', folder: 'Archive' }
  ]);
  await state.selectNote('a');
  let confirmations = 0;

  assert.equal(state.deleteFolder('Archive', (message) => {
    confirmations += 1;
    assert.match(message, /its 1 note/);
    return true;
  }), true);

  assert.equal(confirmations, 1);
  assert.deepEqual(state.notes.map((note) => note.id), ['a']);
  assert.deepEqual(state.getSelectedNoteIds(), ['a']);
  assert.equal(state.currentNoteId, 'a');
  assert.equal(state.pendingPushes.b.action, 'delete');
  assert.equal(state.clientOnlyFolders.has('Archive'), false);
});

test('empty client folders can be renamed and deleted without backend objects', async () => {
  const state = makeState();
  state.createClientFolder('Temporary');

  assert.equal(state.beginRenameFolder('Temporary'), true);
  assert.equal(await state.commitFolderRename('Scratch'), true);
  assert.equal(state.clientOnlyFolders.has('Temporary'), false);
  assert.equal(state.clientOnlyFolders.has('Scratch'), true);
  assert.equal(state.currentFolder, 'Scratch');

  assert.equal(state.deleteFolder('Scratch', () => true), true);
  assert.equal(state.clientOnlyFolders.has('Scratch'), false);
  assert.equal(state.currentFolder, 'Notes');
});

test('folder rename and delete wait for direct note moves to finish', () => {
  const state = makeState([{ id: 'a', folder: 'Archive' }]);
  state.activeDirectMoves.add('move-in-flight');

  assert.equal(state.canManageFolder('Archive'), false);
  assert.equal(state.beginRenameFolder('Archive'), false);
  assert.equal(state.deleteFolder('Archive', () => true), false);
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
