<script>
  import { onMount, tick } from 'svelte';
  import { jnote as app } from '$lib/jnote.svelte.js';
  import { bindAppViewportSize, isEditableElement } from '$lib/viewport.js';
  import EncryptionGate from '$lib/components/EncryptionGate.svelte';
  import FolderModal from '$lib/components/FolderModal.svelte';
  import FolderSidebar from '$lib/components/FolderSidebar.svelte';
  import NoteContextMenu from '$lib/components/NoteContextMenu.svelte';
  import NoteDetailPane from '$lib/components/NoteDetailPane.svelte';
  import NoteListPane from '$lib/components/NoteListPane.svelte';
  import SettingsDialogs from '$lib/components/SettingsDialogs.svelte';
  import SyncAppBar from '$lib/components/SyncAppBar.svelte';

  async function toggleFolderDrawer(event) {
    event.stopPropagation();
    app.closeContextMenu();
    app.toggleFolders();
    if (app.foldersOpen && window.innerWidth <= 768) {
      await tick();
      document.querySelector('#folder-list [data-folder]')?.focus();
    }
  }

  async function closeMobilePanelsAndRestoreFocus() {
    const foldersWereOpen = app.foldersOpen;
    const noteId = app.currentNoteId;
    app.closeMobilePanels();
    await tick();
    if (foldersWereOpen) {
      document.getElementById('hamburger-btn')?.focus();
      return;
    }
    const row = [...document.querySelectorAll('#notes-list [data-note-id]')]
      .find((element) => element.dataset.noteId === noteId);
    (row || document.getElementById('notes-list'))?.focus();
  }

  onMount(() => {
    const unbindViewport = bindAppViewportSize();
    app.handleResize();
    let accountCheckInProgress = false;
    let accountCheckRetryTimer;
    let mounted = true;

    const checkAccountSession = async () => {
      if (!mounted || !app.accountReady || accountCheckInProgress) return;
      accountCheckInProgress = true;
      try {
        const result = await app.refreshAccountSession();
        if (!mounted) return;
        if (result === 'changed') window.location.reload();
        else if (result === 'deferred') {
          accountCheckRetryTimer = window.setTimeout(checkAccountSession, 2000);
        }
      } finally {
        accountCheckInProgress = false;
      }
    };
    const handleFocus = () => checkAccountSession();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkAccountSession();
    };

    const handleKeydown = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const editableTarget = isEditableElement(event.target);
      const dialogOpen = app.folderModal.open
        || app.settingsOpen
        || app.customCssOpen
        || app.changeKeyOpen
        || app.unlockMode !== 'ready';
      const saveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
      if (saveShortcut) {
        event.preventDefault();
        if (
          (!editableTarget || event.target?.closest?.('#note-detail'))
          && !dialogOpen
          && !app.isKeyMigrationRunning
          && !app.changeKeyBusy
        ) {
          app.commitCurrentNote();
        }
        return;
      }
      if (editableTarget) return;

      if (event.key === 'Escape') {
        if (
          app.detailOpen
          && window.innerWidth <= 768
          && event.target?.closest?.('#detail-container')
        ) {
          event.preventDefault();
          closeMobilePanelsAndRestoreFocus();
          return;
        }
        if (app.renamingNoteId) app.cancelRename();
        else app.closeContextMenu();
        return;
      }
      if (dialogOpen) return;
      const noteListFocused = Boolean(event.target?.closest?.('#notes-list'));

      if (event.key === 'F2' && noteListFocused) {
        event.preventDefault();
        app.beginRenameSelectedNote();
        return;
      }
      if (event.key === 'Delete' && noteListFocused && app.getSelectedNoteIds().length) {
        event.preventDefault();
        const deleted = app.deleteSelectedNotes();
        if (deleted) tick().then(() => document.getElementById('notes-list')?.focus());
        return;
      }
    };

    const handleWindowClick = () => app.closeContextMenu();
    const handleWindowScroll = () => app.closeContextMenu();
    const handleResize = () => app.handleResize();
    const handleBeforeUnload = (event) => {
      const message = app.beforeUnloadMessage();
      if (!message) return;
      event.preventDefault();
      event.returnValue = message;
    };

    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('scroll', handleWindowScroll, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    app.initialize();

    return () => {
      mounted = false;
      window.clearTimeout(accountCheckRetryTimer);
      unbindViewport();
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('scroll', handleWindowScroll, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      app.destroy();
    };
  });
</script>

<svelte:head>
  <title>JNote</title>
</svelte:head>

<div class="overlay" id="overlay"></div>

<div class="app-container">
  <button
    class="hamburger-btn"
    id="hamburger-btn"
    type="button"
    aria-label={app.foldersOpen ? 'Close folders' : 'Open folders'}
    aria-expanded={app.foldersOpen}
    aria-controls="folders-container"
    title="Folders"
    onclick={toggleFolderDrawer}
  >
    <svg height="24" viewBox="0 0 24 24" width="24" fill="currentColor" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
    </svg>
  </button>

  <FolderSidebar {app} />
  <NoteListPane {app} />
  <NoteDetailPane {app} />
</div>

<SyncAppBar {app} />
<SettingsDialogs {app} />

{#if app.foldersOpen || app.detailOpen}
  <div
    class="mobile-overlay show"
    id="mobile-overlay"
    role="presentation"
    onclick={closeMobilePanelsAndRestoreFocus}
  ></div>
{:else}
  <div class="mobile-overlay" id="mobile-overlay"></div>
{/if}

{#if app.folderModal.open}
  <FolderModal {app} />
{/if}

{#if app.contextMenu.open}
  <NoteContextMenu {app} />
{/if}

{#if app.unlockMode !== 'ready'}
  <EncryptionGate {app} />
{/if}
