<script>
  import { tick } from 'svelte';
  import InlineNameInput from './InlineNameInput.svelte';

  let { app } = $props();
  let containerElement;

  function handleSidebarKeydown(event) {
    if (event.key === 'Escape') {
      closeDrawerFromKeyboard(event);
      return;
    }
    if (event.key !== 'Tab' || !app.isMobileViewport || !app.foldersOpen) return;
    const focusable = [...containerElement.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [role="button"][tabindex="0"]'
    )];
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

  async function selectFolder(folder) {
    const mobile = window.innerWidth <= 768;
    app.selectFolder(folder);
    if (mobile) {
      await tick();
      document.getElementById('notes-list')?.focus();
    }
  }

  async function activate(event, folder) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      app.openFolderContextMenu(event, folder);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      await selectFolder(folder);
    } else if (event.key === 'Escape') {
      await closeDrawerFromKeyboard(event);
    }
  }

  async function closeDrawerFromKeyboard(event) {
    if (event.key !== 'Escape' || window.innerWidth > 768 || !app.foldersOpen) return;
    event.preventDefault();
    event.stopPropagation();
    app.closeFolders();
    await tick();
    document.getElementById('hamburger-btn')?.focus();
  }

  function beginCreateFolder() {
    app.beginCreateFolder();
  }

  async function restoreFolderFocus(folder = null) {
    await tick();
    const folderRow = folder
      ? [...document.querySelectorAll('#folder-list [data-folder]')]
          .find((element) => element.dataset.folder === folder)
      : null;
    (folderRow || document.getElementById('btn-create-folder'))?.focus();
  }

  function finishCreateFolder(value, reason) {
    const folder = app.commitCreateFolder(value, { select: false });
    if (reason === 'enter') restoreFolderFocus(folder);
  }

  function cancelCreateFolder(reason) {
    app.cancelCreateFolder();
    if (reason === 'escape') restoreFolderFocus();
  }

  async function finishRenameFolder(folder, value, reason) {
    const renamed = await app.commitFolderRename(value);
    if (reason === 'enter') {
      const focusFolder = renamed ? app.resolveFolderName(value) : folder;
      await restoreFolderFocus(focusFolder);
    }
  }

  function cancelRenameFolder(folder, reason) {
    app.cancelFolderRename();
    if (reason === 'escape') restoreFolderFocus(folder);
  }

  async function dropNotes(event, folder) {
    const moving = app.dropNotesOnFolder(event, folder);
    await tick();
    const folderRow = [...document.querySelectorAll('#folder-list [data-folder]')]
      .find((element) => element.dataset.folder === folder);
    folderRow?.focus({ preventScroll: true });
    await moving;
  }

  function openFolderBackgroundContextMenu(event) {
    if (event.target.closest?.('.folder-item')) return;
    app.openBlankContextMenu(event, 'folders');
  }
</script>

<div
  bind:this={containerElement}
  id="folders-container"
  class="folders-container"
  class:open={app.foldersOpen}
  inert={app.isMobileViewport && !app.foldersOpen ? true : undefined}
  aria-hidden={app.isMobileViewport && !app.foldersOpen ? 'true' : undefined}
  role="navigation"
  aria-label="Folders"
  onkeydown={handleSidebarKeydown}
>
  <div class="sidebar-header">Folders</div>
  <div
    class="sidebar folders-panel"
    id="folders-panel"
    role="group"
    aria-label="Folder list"
    oncontextmenu={openFolderBackgroundContextMenu}
  >
    <ul class="folder-list" id="folder-list">
      {#each app.folders as folder (folder)}
        {#if folder === app.renamingFolder}
          <li
            class="folder-item focused renaming"
            class:active={folder === app.currentFolder}
            data-folder={folder}
            role="presentation"
          >
            <InlineNameInput
              initialValue={app.folderRenameDraftValue}
              ariaLabel="Rename folder"
              className="folder-rename-input"
              onvaluechange={(value) => app.setFolderRenameDraft(value)}
              onconfirm={(value, reason) => finishRenameFolder(folder, value, reason)}
              oncancel={(reason) => cancelRenameFolder(folder, reason)}
            />
          </li>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <li
            class="folder-item"
            class:active={folder === app.currentFolder}
            class:drag-over={folder === app.dragOverFolder}
            class:context-open={app.contextMenu.open
              && app.contextMenu.type === 'folder'
              && app.contextMenu.folder === folder}
            data-folder={folder}
            role="button"
            tabindex="0"
            aria-current={folder === app.currentFolder ? 'page' : undefined}
            aria-haspopup="menu"
            aria-expanded={app.contextMenu.open
              && app.contextMenu.type === 'folder'
              && app.contextMenu.folder === folder}
            onclick={() => selectFolder(folder)}
            onkeydown={(event) => activate(event, folder)}
            oncontextmenu={(event) => app.openFolderContextMenu(event, folder)}
            ondragenter={(event) => app.dragNotesOverFolder(event, folder)}
            ondragover={(event) => app.dragNotesOverFolder(event, folder)}
            ondragleave={(event) => app.leaveFolderDropTarget(event, folder)}
            ondrop={(event) => dropNotes(event, folder)}
          >
            {folder}
          </li>
        {/if}
      {/each}
      {#if app.creatingFolder}
        <li class="folder-item folder-item-creating">
          <InlineNameInput
            initialValue={app.newFolderDraftValue}
            ariaLabel="New folder name"
            className="folder-rename-input"
            onvaluechange={(value) => app.setNewFolderDraft(value)}
            onconfirm={finishCreateFolder}
            oncancel={cancelCreateFolder}
          />
        </li>
      {/if}
    </ul>
  </div>
  <button
    class="btn-secondary ripple"
    id="btn-create-folder"
    type="button"
    disabled={app.creatingFolder || Boolean(app.renamingFolder) || app.folderActionBusy}
    onclick={beginCreateFolder}
    onkeydown={closeDrawerFromKeyboard}
  >
    New Folder
  </button>
</div>
