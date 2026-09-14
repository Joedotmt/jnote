<script>
  import { tick } from 'svelte';
  import CloseDetailButton from './CloseDetailButton.svelte';
  import NoteEditor from './NoteEditor.svelte';

  let { app } = $props();
  let detailElement;
  const editorReady = $derived(Boolean(
    app.currentNote
    && app.noteLoadState !== 'loading'
    && app.noteLoadState !== 'error'
  ));

  function trapMobileDetailFocus(event) {
    if (
      event.key !== 'Tab'
      || !app.isMobileViewport
      || !app.detailOpen
      || app.foldersOpen
    ) {
      return;
    }
    const focusable = [...detailElement.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), '
      + '[contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'
    )].filter((element, index, elements) => elements.indexOf(element) === index);
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

  async function closeDetail() {
    const noteId = app.currentNoteId;
    app.closeDetail();
    await tick();
    const row = [...document.querySelectorAll('#notes-list [data-note-id]')]
      .find((element) => element.dataset.noteId === noteId);
    (row || document.getElementById('notes-list'))?.focus({ preventScroll: true });
  }
</script>

<div
  bind:this={detailElement}
  id="detail-container"
  class="detail-container"
  class:open={app.detailOpen}
  inert={app.isMobileViewport && (!app.detailOpen || app.foldersOpen) ? true : undefined}
  aria-hidden={app.isMobileViewport && (!app.detailOpen || app.foldersOpen) ? 'true' : undefined}
  onkeydown={trapMobileDetailFocus}
>
  <div id="note-detail">
    {#if !editorReady}
      <div class="note-detail-toolbar close-only">
        <CloseDetailButton onclose={closeDetail} />
      </div>
    {/if}

    {#if !app.currentNote}
      {#if app.loadState === 'error'}
        <p class="error">Failed to load or decrypt notes</p>
      {:else}
        <p class="empty">Select a note to view</p>
      {/if}
    {:else if app.noteLoadState === 'loading'}
      <p class="empty">Loading note...</p>
    {:else if app.noteLoadState === 'error'}
      <p class="error">{app.noteLoadError || 'Failed to load note'}</p>
    {:else}
      {#key `${app.currentNote.id}:${app.editorRevision}`}
        <NoteEditor app={app} note={app.currentNote} onclose={closeDetail} />
      {/key}
    {/if}
  </div>
</div>
