<script>
  import NoteEditor from './NoteEditor.svelte';

  let { app } = $props();
</script>

<div id="detail-container" class="detail-container" class:open={app.detailOpen}>
  <button
    class="close-detail-btn"
    id="close-detail-btn"
    type="button"
    title="Close"
    aria-label="Close note"
    onclick={() => app.closeDetail()}
  >
    <svg height="24" viewBox="0 0 24 24" width="24" fill="currentColor" aria-hidden="true">
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
  </button>

  <div id="note-detail">
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
        <NoteEditor app={app} note={app.currentNote} />
      {/key}
    {/if}
  </div>
</div>
