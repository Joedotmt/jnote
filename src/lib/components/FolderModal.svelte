<script>
  import { onMount, tick, untrack } from 'svelte';

  let { app } = $props();
  let modalElement;
  let previousFocus;

  const initialFolder = untrack(() => {
    if (app.folderModal.mode !== 'move') return '';
    const noteIds = app.folderModal.noteIds?.length
      ? app.folderModal.noteIds
      : [app.folderModal.noteId].filter(Boolean);
    const folders = new Set(
      noteIds
        .map((noteId) => app.notes.find((candidate) => candidate.id === noteId)?.folder)
        .filter(Boolean)
    );
    return folders.size === 1 ? [...folders][0] : '';
  });
  let selectedFolder = $state(initialFolder);
  let customFolder = $state('');
  const returnFocusNoteId = untrack(() => (
    app.folderModal.returnFocusNoteId || app.folderModal.noteId
  ));

  onMount(async () => {
    previousFocus = document.activeElement;
    await tick();
    const selectedOption = modalElement?.querySelector('.folder-option.selected');
    (selectedOption || modalElement?.querySelector('button, input'))?.focus();
  });

  function chooseFolder(folder) {
    selectedFolder = folder;
    customFolder = '';
  }

  async function confirmSelection() {
    const targetFolder = customFolder.trim() || selectedFolder;
    const mode = app.folderModal.mode;
    const noteIds = app.folderModal.noteIds?.length
      ? [...app.folderModal.noteIds]
      : [app.folderModal.noteId].filter(Boolean);
    if (!targetFolder) return;
    app.closeFolderModal();

    if (mode === 'create') app.createNewNote(targetFolder);
    else if (noteIds.length) {
      const moving = app.moveNotesToFolder(noteIds, targetFolder);
      await restoreFocus();
      await moving;
      if (document.activeElement === document.body) {
        document.getElementById('notes-list')?.focus({ preventScroll: true });
      }
    }
  }

  async function restoreFocus() {
    await tick();
    if (window.innerWidth <= 768 && app.detailOpen) {
      document.getElementById('close-detail-btn')?.focus({ preventScroll: true });
      return;
    }
    if (previousFocus?.isConnected && previousFocus !== document.body) {
      previousFocus.focus();
      return;
    }
    const noteId = app.isNoteSelected(returnFocusNoteId)
      ? returnFocusNoteId
      : app.currentNoteId;
    const row = [...document.querySelectorAll('#notes-list [data-note-id]')]
      .find((element) => element.dataset.noteId === noteId);
    (row || document.getElementById('notes-list'))?.focus();
  }

  async function cancelAndRestoreFocus() {
    app.closeFolderModal();
    await restoreFocus();
  }

  function handleDialogKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelAndRestoreFocus();
      return;
    }
    if (event.key !== 'Tab' || !modalElement) return;
    const focusable = [...modalElement.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div
  bind:this={modalElement}
  class="modal show"
  id="folder-modal"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-labelledby="modal-header"
  onkeydown={handleDialogKeydown}
>
  <div class="modal-content">
    <h2 class="modal-header" id="modal-header">
      {#if app.folderModal.mode === 'create'}
        Create New Note
      {:else if app.folderModal.noteIds?.length > 1}
        Move {app.folderModal.noteIds.length} Notes to Folder
      {:else}
        Move Note to Folder
      {/if}
    </h2>
    <div class="folder-selection" id="folder-selection">
      {#each app.folders as folder (folder)}
        <button
          class="folder-option"
          class:selected={selectedFolder === folder}
          data-folder={folder}
          type="button"
          aria-pressed={selectedFolder === folder}
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
      <button class="btn-secondary" id="folder-modal-cancel" type="button" onclick={cancelAndRestoreFocus}>
        Cancel
      </button>
      <button
        class="btn-primary"
        id="folder-modal-confirm"
        type="button"
        disabled={!selectedFolder && !customFolder.trim()}
        onclick={confirmSelection}
      >
        Confirm
      </button>
    </div>
  </div>
</div>
