<script>
  let { app } = $props();

  function activate(event, folder) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      app.selectFolder(folder);
    }
  }
</script>

<div id="folders-container" class="folders-container" class:open={app.foldersOpen}>
  <div class="sidebar-header">Folders</div>
  <div class="sidebar folders-panel" id="folders-panel">
    <ul class="folder-list" id="folder-list">
      {#each app.folders as folder (folder)}
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <li
          class="folder-item"
          class:active={folder === app.currentFolder}
          data-folder={folder}
          role="button"
          tabindex="0"
          onclick={() => app.selectFolder(folder)}
          onkeydown={(event) => activate(event, folder)}
        >
          {folder}
        </li>
      {/each}
    </ul>
  </div>
</div>
