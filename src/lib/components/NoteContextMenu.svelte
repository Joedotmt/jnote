<script>
  import { tick } from 'svelte';

  let { app } = $props();
  let menuElement;
  let left = $state(0);
  let top = $state(0);
  const actionCount = $derived(
    app.contextMenu.type === 'note'
      ? app.getActionNoteIds(app.contextMenu.noteId).length
      : 0
  );
  const folderNoteCount = $derived(
    app.contextMenu.type === 'folder'
      ? app.notes.filter((note) => note.folder === app.contextMenu.folder).length
      : 0
  );

  $effect(() => {
    const { open, x, y, type, surface, noteId, folder } = app.contextMenu;
    if (!open) return;
    // Target fields are intentionally read so switching menu kinds at the same
    // coordinates still remeasures the newly rendered actions.
    void type;
    void surface;
    void noteId;
    void folder;

    left = x;
    top = y;
    tick().then(() => {
      if (!menuElement || !app.contextMenu.open) return;
      const padding = 8;
      const rect = menuElement.getBoundingClientRect();
      left = Math.max(padding, Math.min(x, window.innerWidth - rect.width - padding));
      top = Math.max(padding, Math.min(y, window.innerHeight - rect.height - padding));
      const firstItem = menuElement.querySelector('button:not(:disabled)');
      (firstItem || menuElement).focus({ preventScroll: true });
    });
  });

  function enabledItems() {
    return menuElement ? [...menuElement.querySelectorAll('button:not(:disabled)')] : [];
  }

  async function restoreContextFocus(context) {
    await tick();
    if (context.type === 'note' && window.innerWidth <= 768 && app.detailOpen) {
      document.getElementById('close-detail-btn')?.focus({ preventScroll: true });
      return;
    }
    if (context.type === 'note') {
      const row = [...document.querySelectorAll('#notes-list [data-note-id]')]
        .find((element) => element.dataset.noteId === context.noteId);
      (row || document.getElementById('notes-list'))?.focus({ preventScroll: true });
      return;
    }
    if (context.type === 'folder') {
      if (window.innerWidth <= 768 && !app.foldersOpen) {
        document.getElementById('hamburger-btn')?.focus({ preventScroll: true });
        return;
      }
      const folderRow = [...document.querySelectorAll('#folder-list [data-folder]')]
        .find((element) => element.dataset.folder === context.folder);
      (folderRow || document.querySelector('#folder-list [data-folder]'))
        ?.focus({ preventScroll: true });
      return;
    }
    if (context.type === 'blank' && context.surface === 'folders') {
      document.getElementById('btn-create-folder')?.focus({ preventScroll: true });
      return;
    }
    document.getElementById('notes-list')?.focus({ preventScroll: true });
  }

  async function closeAndRestoreFocus() {
    const context = { ...app.contextMenu };
    app.closeContextMenu();
    await restoreContextFocus(context);
  }

  function handleMenuKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    const items = enabledItems();
    if (!items.length) {
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const currentIndex = Math.max(0, items.indexOf(document.activeElement));
    let targetIndex = null;
    if (event.key === 'Tab') {
      targetIndex = event.shiftKey
        ? (currentIndex - 1 + items.length) % items.length
        : (currentIndex + 1) % items.length;
    } else if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % items.length;
    else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = items.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    items[targetIndex]?.focus();
  }

  async function perform(action) {
    const context = { ...app.contextMenu };
    const noteId = app.contextMenu.noteId;
    if (context.type === 'note' && !noteId) return;

    if (context.type === 'note' && action === 'commit') {
      app.closeContextMenu();
      app.commitFromContextMenu(noteId);
      await restoreContextFocus(context);
    } else if (context.type === 'note' && action === 'rename') {
      app.closeContextMenu();
      app.beginRenameSelectedNote();
    } else if (context.type === 'note' && action === 'move') {
      app.openFolderModal(noteId);
    } else if (context.type === 'note' && action === 'delete') {
      app.closeContextMenu();
      app.deleteNote(noteId);
      await restoreContextFocus(context);
    } else if (context.type === 'folder' && action === 'new-folder') {
      app.closeContextMenu();
      app.beginCreateFolder();
    } else if (context.type === 'folder' && action === 'rename-folder') {
      app.beginRenameFolder(context.folder);
    } else if (context.type === 'folder' && action === 'delete-folder') {
      app.closeContextMenu();
      const deleted = app.deleteFolder(context.folder);
      await restoreContextFocus({
        ...context,
        folder: deleted ? app.currentFolder : context.folder
      });
    } else if (
      context.type === 'blank'
      && context.surface === 'notes'
      && action === 'new-note'
    ) {
      app.closeContextMenu();
      app.createNewNote(context.folder || app.currentFolder);
      await tick();
      document.getElementById('edit-title')?.focus({ preventScroll: true });
    } else if (
      context.type === 'blank'
      && context.surface === 'folders'
      && action === 'new-folder'
    ) {
      app.closeContextMenu();
      app.beginCreateFolder();
    }
  }
</script>

<div
  bind:this={menuElement}
  class="note-context-menu"
  id="note-context-menu"
  role="menu"
  aria-label={app.contextMenu.type === 'folder'
    ? `Actions for ${app.contextMenu.folder}`
    : app.contextMenu.type === 'note'
      ? 'Note actions'
      : app.contextMenu.surface === 'folders' ? 'New folder' : 'New note'}
  tabindex="-1"
  style:left={`${left}px`}
  style:top={`${top}px`}
  onkeydown={handleMenuKeydown}
>
  {#if app.contextMenu.type === 'note'}
    <button
      type="button"
      role="menuitem"
      data-action="commit"
      disabled={actionCount !== 1 || !app.canCommit(app.contextMenu.noteId)}
      onclick={() => perform('commit')}
    >
      <i aria-hidden="true">cloud_upload</i>
      <span>Commit</span>
    </button>
    <button
      type="button"
      role="menuitem"
      data-action="rename"
      disabled={!app.canRenameNote(app.contextMenu.noteId)}
      onclick={() => perform('rename')}
    >
      <i aria-hidden="true">drive_file_rename_outline</i>
      <span>Rename</span>
    </button>
    <button type="button" role="menuitem" data-action="move" onclick={() => perform('move')}>
      <i aria-hidden="true">drive_file_move</i>
      <span>{actionCount > 1 ? `Move ${actionCount} Notes` : 'Move'}</span>
    </button>
    <button type="button" role="menuitem" data-action="delete" class="danger" onclick={() => perform('delete')}>
      <i aria-hidden="true">delete</i>
      <span>{actionCount > 1 ? `Delete ${actionCount} Notes` : 'Delete'}</span>
    </button>
  {:else if app.contextMenu.type === 'folder'}
    {#if app.contextMenu.folder === 'Notes'}
      <button type="button" role="menuitem" data-action="new-folder" onclick={() => perform('new-folder')}>
        <i aria-hidden="true">create_new_folder</i>
        <span>New Folder</span>
      </button>
    {/if}
    <button
      type="button"
      role="menuitem"
      data-action="rename-folder"
      disabled={!app.canManageFolder(app.contextMenu.folder)}
      title={app.contextMenu.folder === 'Notes' ? 'The default Notes folder cannot be renamed' : undefined}
      onclick={() => perform('rename-folder')}
    >
      <i aria-hidden="true">drive_file_rename_outline</i>
      <span>Rename Folder</span>
    </button>
    <button
      type="button"
      role="menuitem"
      data-action="delete-folder"
      class="danger"
      disabled={!app.canManageFolder(app.contextMenu.folder)}
      title={app.contextMenu.folder === 'Notes' ? 'The default Notes folder cannot be deleted' : undefined}
      onclick={() => perform('delete-folder')}
    >
      <i aria-hidden="true">delete</i>
      <span>{app.contextMenu.folder !== 'Notes' && folderNoteCount
        ? `Delete Folder and ${folderNoteCount} ${folderNoteCount === 1 ? 'Note' : 'Notes'}`
        : 'Delete Folder'}</span>
    </button>
  {:else}
    {#if app.contextMenu.surface === 'folders'}
      <button type="button" role="menuitem" data-action="new-folder" onclick={() => perform('new-folder')}>
        <i aria-hidden="true">create_new_folder</i>
        <span>New Folder</span>
      </button>
    {:else}
      <button type="button" role="menuitem" data-action="new-note" onclick={() => perform('new-note')}>
        <i aria-hidden="true">note_add</i>
        <span>New Note</span>
      </button>
    {/if}
  {/if}
</div>
