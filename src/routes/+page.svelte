<script>
  import { onMount } from 'svelte';
  import { jnote as app } from '$lib/jnote.svelte.js';
  import { bindAppViewportSize } from '$lib/viewport.js';
  import EncryptionGate from '$lib/components/EncryptionGate.svelte';
  import FolderModal from '$lib/components/FolderModal.svelte';
  import FolderSidebar from '$lib/components/FolderSidebar.svelte';
  import NoteContextMenu from '$lib/components/NoteContextMenu.svelte';
  import NoteDetailPane from '$lib/components/NoteDetailPane.svelte';
  import NoteListPane from '$lib/components/NoteListPane.svelte';
  import SettingsDialogs from '$lib/components/SettingsDialogs.svelte';
  import SyncAppBar from '$lib/components/SyncAppBar.svelte';

  onMount(() => {
    const unbindViewport = bindAppViewportSize();

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        app.closeContextMenu();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (app.isKeyMigrationRunning || app.changeKeyBusy) return;
      app.commitCurrentNote();
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
    app.initialize();

    return () => {
      unbindViewport();
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('scroll', handleWindowScroll, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('beforeunload', handleBeforeUnload);
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
    aria-label="Open folders"
    title="Folders"
    onclick={(event) => {
      event.stopPropagation();
      app.closeContextMenu();
      app.toggleFolders();
    }}
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
    onclick={() => app.closeMobilePanels()}
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
