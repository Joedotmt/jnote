<script>
  import { onDestroy, tick } from 'svelte';
  import InlineNameInput from './InlineNameInput.svelte';

  let { app } = $props();
  const usesListbox = $derived(!app.renamingNoteId && app.visibleNotes.length > 0);
  let searchInput = $state();

  async function openSearch() {
    app.openSearch();
    await tick();
    searchInput?.focus();
  }

  async function closeSearch() {
    app.closeSearch();
    await tick();
    document.getElementById('open-search-btn')?.focus();
  }

  async function handleSearchKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      // First Escape clears the query, the second closes the field.
      if (app.searchQuery) app.setSearchQuery('');
      else closeSearch();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const firstId = app.getVisibleNoteIds()[0];
      if (!firstId) return;
      event.preventDefault();
      if (event.key === 'Enter') {
        app.selectNote(firstId);
        await focusOpenedNote(firstId);
      } else {
        await focusRow(firstId);
      }
    }
  }
  let dragPreviewElement = null;
  let dragPreviewFrame = null;

  function removeDragPreview() {
    if (dragPreviewFrame !== null) {
      window.cancelAnimationFrame(dragPreviewFrame);
      dragPreviewFrame = null;
    }
    dragPreviewElement?.remove();
    dragPreviewElement = null;
  }

  function setStackedDragPreview(event, originNoteId) {
    const noteIds = app.draggedNoteIds;
    if (noteIds.length <= 1 || !event.dataTransfer?.setDragImage) return;
    removeDragPreview();

    const preview = document.createElement('div');
    preview.className = 'jnote-drag-preview';
    preview.setAttribute('aria-hidden', 'true');
    const layerCount = Math.min(3, noteIds.length);
    for (let layer = layerCount - 1; layer > 0; layer -= 1) {
      const card = document.createElement('div');
      card.className = 'jnote-drag-card jnote-drag-card-back';
      card.style.transform = `translate(${layer * 7}px, ${layer * -6}px) rotate(${layer * 0.8}deg)`;
      preview.append(card);
    }

    const originNote = app.notes.find((note) => note.id === originNoteId);
    const frontCard = document.createElement('div');
    frontCard.className = 'jnote-drag-card jnote-drag-card-front';
    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'description';
    const title = document.createElement('span');
    title.className = 'jnote-drag-title';
    title.textContent = app.getDisplayTitle(originNote) || '[untitled]';
    const count = document.createElement('span');
    count.className = 'jnote-drag-count';
    count.textContent = String(noteIds.length);
    frontCard.append(icon, title, count);
    preview.append(frontCard);
    document.body.append(preview);
    dragPreviewElement = preview;

    try {
      event.dataTransfer.setDragImage(preview, 24, 24);
      dragPreviewFrame = window.requestAnimationFrame(removeDragPreview);
    } catch {
      removeDragPreview();
    }
  }

  function beginDrag(event, noteId) {
    if (!app.beginNoteDrag(event, noteId)) return;
    setStackedDragPreview(event, noteId);
  }

  function endDrag() {
    removeDragPreview();
    app.clearNoteDrag();
  }

  onDestroy(removeDragPreview);

  async function selectFromPointer(event, noteId) {
    const toggle = event.ctrlKey || event.metaKey;
    app.selectNote(noteId, {
      toggle,
      extend: event.shiftKey,
      additive: toggle && event.shiftKey
    });
    if (window.innerWidth <= 768) await focusOpenedNote(noteId);
  }

  async function focusRow(noteId) {
    await tick();
    const row = [...document.querySelectorAll('#notes-list [data-note-id]')]
      .find((element) => element.dataset.noteId === noteId);
    row?.focus({ preventScroll: false });
  }

  async function focusOpenedNote(noteId) {
    await tick();
    if (window.innerWidth <= 768 && app.detailOpen) {
      document.getElementById('close-detail-btn')?.focus({ preventScroll: true });
      return;
    }
    await focusRow(noteId);
  }

  async function confirmRename(noteId, value, reason) {
    app.commitRename(value);
    if (reason === 'enter') await focusRow(noteId);
  }

  async function cancelRename(noteId, reason) {
    app.cancelRename();
    if (reason === 'escape') await focusRow(noteId);
  }

  async function createNote() {
    app.createNewNote(app.currentFolder);
    await tick();
    document.getElementById('edit-title')?.focus({ preventScroll: true });
  }

  async function activate(event, noteId) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      app.openContextMenu(event, noteId);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      app.selectNote(noteId, {
        toggle: event.ctrlKey || event.metaKey,
        extend: event.shiftKey,
        additive: (event.ctrlKey || event.metaKey) && event.shiftKey
      });
      if (window.innerWidth <= 768) await focusOpenedNote(noteId);
      return;
    }

    const visibleIds = app.getVisibleNoteIds();
    const currentIndex = visibleIds.indexOf(noteId);
    let targetIndex = null;
    if (event.key === 'ArrowUp') targetIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'ArrowDown') targetIndex = Math.min(visibleIds.length - 1, currentIndex + 1);
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = visibleIds.length - 1;
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      await app.selectAllVisibleNotes();
      return;
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const targetId = visibleIds[targetIndex];
    if (!targetId) return;
    app.selectNote(targetId, {
      extend: event.shiftKey,
      additive: (event.ctrlKey || event.metaKey) && event.shiftKey
    });
    await focusOpenedNote(targetId);
  }

  function clearFromBlankSpace(event) {
    if (event.target.closest?.('[data-note-id]')) return;
    event.stopPropagation();
    app.clearNoteSelection();
    event.currentTarget.focus({ preventScroll: true });
  }

  function openBlankContextMenu(event) {
    if (event.target.closest?.('[data-note-id]')) return;
    app.openBlankContextMenu(event);
  }

  async function handleListKeydown(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      app.clearNoteSelection();
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      app.openBlankContextMenu(event);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      app.selectAllVisibleNotes();
      await focusOpenedNote(app.focusedNoteId);
      return;
    }
    const visibleIds = app.getVisibleNoteIds();
    const targetId = event.key === 'ArrowUp' || event.key === 'End'
      ? visibleIds.at(-1)
      : event.key === 'ArrowDown' || event.key === 'Home' ? visibleIds[0] : null;
    if (!targetId) return;
    event.preventDefault();
    app.selectNote(targetId);
    await focusOpenedNote(targetId);
  }

</script>

<div
  class="nlppppp"
  inert={app.isMobileViewport && (app.foldersOpen || app.detailOpen) ? true : undefined}
  aria-hidden={app.isMobileViewport && (app.foldersOpen || app.detailOpen) ? 'true' : undefined}
>
  {#if app.searchOpen}
    <div class="notes-header notes-search" id="current-folder-title" role="search">
      <i aria-hidden="true">search</i>
      <input
        bind:this={searchInput}
        bind:value={app.searchQuery}
        class="notes-search-input"
        id="note-search-input"
        type="search"
        placeholder="Search all notes"
        aria-label="Search notes"
        autocomplete="off"
        spellcheck="false"
        onkeydown={handleSearchKeydown}
      />
      <button
        class="icon-dialog-btn notes-search-close"
        id="close-search-btn"
        type="button"
        aria-label="Close search"
        title="Close search"
        onclick={closeSearch}
      >
        <i aria-hidden="true">close</i>
      </button>
    </div>
  {:else}
    <div class="notes-header" id="current-folder-title">
      <span>{app.currentFolder}</span>
      <span class="notes-header-actions">
        {#if app.selectedCount > 1}
          <span class="selection-count">{app.selectedCount} selected</span>
        {/if}
        <button
          class="icon-dialog-btn notes-search-open"
          id="open-search-btn"
          type="button"
          aria-label="Search notes"
          title="Search notes (/)"
          onclick={openSearch}
        >
          <i aria-hidden="true">search</i>
        </button>
      </span>
    </div>
  {/if}
  <ul
    class="folder-list"
    id="notes-list"
    role={usesListbox ? 'listbox' : 'group'}
    aria-multiselectable={usesListbox ? 'true' : undefined}
    tabindex="-1"
    aria-label={app.isSearching ? 'Search results' : `Notes in ${app.currentFolder}`}
    onclick={clearFromBlankSpace}
    oncontextmenu={openBlankContextMenu}
    onkeydown={handleListKeydown}
  >
    {#if app.visibleNotes.length === 0}
      <li class="empty-state" role="status">{app.isSearching ? 'No notes match' : 'No notes'}</li>
    {:else}
      {#each app.visibleNotes as note (note.id)}
        {#if note.id === app.renamingNoteId}
          <li
            class="folder-item note-list-item active selected current focused renaming"
            data-note-id={note.id}
            role="presentation"
          >
            <InlineNameInput
              initialValue={app.renameDraftValue}
              ariaLabel="Rename note"
              className="note-rename-input"
              onvaluechange={(value) => app.setRenameDraft(value)}
              onconfirm={(value, reason) => confirmRename(note.id, value, reason)}
              oncancel={(reason) => cancelRename(note.id, reason)}
            />
          </li>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <li
            class="folder-item note-list-item"
            class:active={note.id === app.currentNoteId}
            class:selected={app.isNoteSelected(note.id)}
            class:current={note.id === app.currentNoteId}
            class:focused={note.id === app.focusedNoteId}
            class:dragging={app.draggedNoteIds.includes(note.id)}
            class:context-open={app.contextMenu.open && app.contextMenu.noteId === note.id}
            data-note-id={note.id}
            draggable="true"
            role={usesListbox ? 'option' : 'button'}
            tabindex={note.id === (app.focusedNoteId || app.currentNoteId || app.visibleNotes[0]?.id) ? 0 : -1}
            aria-selected={usesListbox ? app.isNoteSelected(note.id) : undefined}
            aria-pressed={!usesListbox ? app.isNoteSelected(note.id) : undefined}
            onclick={(event) => selectFromPointer(event, note.id)}
            onfocus={() => app.focusNote(note.id)}
            onkeydown={(event) => activate(event, note.id)}
            oncontextmenu={(event) => app.openContextMenu(event, note.id)}
            ondragstart={(event) => beginDrag(event, note.id)}
            ondragend={endDrag}
          >
            <span class="note-list-title">{app.getDisplayTitle(note) || '[untitled]'}</span>
            {#if app.isSearching}
              <span class="note-list-folder">{note.folder}</span>
            {/if}
            {#if app.hasDraft(note.id)}
              <span class="unsaved-dot" title="Unsaved local changes" aria-hidden="true"></span>
            {/if}
          </li>
        {/if}
      {/each}
    {/if}
  </ul>
  <button
    class="btn-primary ripple"
    id="btn-create-note"
    type="button"
    onclick={createNote}
  >
    New Note
  </button>
</div>
