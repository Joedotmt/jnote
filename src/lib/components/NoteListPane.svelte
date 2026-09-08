<script>
  let { app } = $props();

  function activate(event, noteId) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      app.selectNote(noteId);
    }
  }
</script>

<div class="nlppppp">
  <div class="notes-header" id="current-folder-title">{app.currentFolder}</div>
  <ul class="folder-list" id="notes-list" style="margin-bottom: 50px">
    {#if app.visibleNotes.length === 0}
      <li class="empty-state">No notes</li>
    {:else}
      {#each app.visibleNotes as note (note.id)}
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <li
          class="folder-item"
          class:active={note.id === app.currentNoteId}
          class:context-open={app.contextMenu.open && app.contextMenu.noteId === note.id}
          data-note-id={note.id}
          role="button"
          tabindex="0"
          onclick={() => app.selectNote(note.id)}
          onkeydown={(event) => activate(event, note.id)}
          oncontextmenu={(event) => app.openContextMenu(event, note.id)}
        >
          <span class="note-list-title">{app.getDisplayTitle(note) || '[untitled]'}</span>
          {#if app.hasDraft(note.id)}
            <span class="unsaved-dot" title="Unsaved local changes"></span>
          {/if}
        </li>
      {/each}
    {/if}
  </ul>
  <button
    class="btn-primary ripple"
    id="btn-create-note"
    type="button"
    onclick={() => app.createNewNote(app.currentFolder)}
  >
    New Note
  </button>
</div>
