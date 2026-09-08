<script>
  import { untrack } from 'svelte';

  let { app } = $props();

  const initialFolder = untrack(() => {
    const note = app.notes.find((candidate) => candidate.id === app.folderModal.noteId) ?? null;
    return app.folderModal.mode === 'move' ? (note?.folder || '') : '';
  });
  let selectedFolder = $state(initialFolder);
  let customFolder = $state('');

  function chooseFolder(folder) {
    selectedFolder = folder;
    customFolder = '';
  }

  async function confirmSelection() {
    const targetFolder = customFolder.trim() || selectedFolder;
    const mode = app.folderModal.mode;
    const noteId = app.folderModal.noteId;
    app.closeFolderModal();

    if (mode === 'create') app.createNewNote(targetFolder);
    else if (noteId) await app.moveNoteToFolder(noteId, targetFolder);
  }
</script>

<div
  class="modal show"
  id="folder-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="modal-header"
>
  <div class="modal-content">
    <h2 class="modal-header" id="modal-header">
      {app.folderModal.mode === 'create' ? 'Create New Note' : 'Move Note to Folder'}
    </h2>
    <div class="folder-selection" id="folder-selection">
      {#each app.folders as folder (folder)}
        <button
          class="folder-option"
          class:selected={selectedFolder === folder}
          data-folder={folder}
          type="button"
          onclick={() => chooseFolder(folder)}
        >
          {folder}
        </button>
      {/each}
    </div>
    <div class="field border label">
      <input id="custom-folder-name" type="text" bind:value={customFolder} oninput={() => (selectedFolder = '')} />
      <label for="custom-folder-name">Other</label>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="folder-modal-cancel" type="button" onclick={() => app.closeFolderModal()}>
        Cancel
      </button>
      <button class="btn-primary" id="folder-modal-confirm" type="button" onclick={confirmSelection}>
        Confirm
      </button>
    </div>
  </div>
</div>
