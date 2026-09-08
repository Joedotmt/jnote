<script>
  import { tick } from 'svelte';

  let { app } = $props();
  let menuElement;
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    const { open, x, y } = app.contextMenu;
    if (!open) return;

    left = x;
    top = y;
    tick().then(() => {
      if (!menuElement || !app.contextMenu.open) return;
      const padding = 8;
      const rect = menuElement.getBoundingClientRect();
      left = Math.max(padding, Math.min(x, window.innerWidth - rect.width - padding));
      top = Math.max(padding, Math.min(y, window.innerHeight - rect.height - padding));
    });
  });

  function perform(action) {
    const noteId = app.contextMenu.noteId;
    if (!noteId) return;
    app.closeContextMenu();

    if (action === 'commit') app.commitFromContextMenu(noteId);
    else if (action === 'move') app.openFolderModal(noteId);
    else if (action === 'delete') app.deleteNote(noteId);
  }
</script>

<div
  bind:this={menuElement}
  class="note-context-menu"
  id="note-context-menu"
  role="menu"
  tabindex="-1"
  style:left={`${left}px`}
  style:top={`${top}px`}
>
  <button
    type="button"
    role="menuitem"
    data-action="commit"
    disabled={!app.canCommit(app.contextMenu.noteId)}
    onclick={() => perform('commit')}
  >
    <i aria-hidden="true">cloud_upload</i>
    <span>Commit</span>
  </button>
  <button type="button" role="menuitem" data-action="move" onclick={() => perform('move')}>
    <i aria-hidden="true">drive_file_move</i>
    <span>Move</span>
  </button>
  <button type="button" role="menuitem" data-action="delete" class="danger" onclick={() => perform('delete')}>
    <i aria-hidden="true">delete</i>
    <span>Delete</span>
  </button>
</div>
