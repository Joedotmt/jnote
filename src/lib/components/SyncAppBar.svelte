<script>
  let { app } = $props();
</script>

<div
  class="sync-app-bar"
  class:is-idle={app.syncStatus.idle}
  class:has-error={app.syncStatus.error}
  id="sync-app-bar"
>
  <div class="sync-status-group" role="status" aria-live="polite">
    <div class="sync-spinner" aria-hidden="true"></div>
    <i class="sync-check" aria-hidden="true">check</i>
    {#key app.syncStatus.text}
      <span class="sync-text-in" id="sync-status-text">{app.syncStatus.text}</span>
    {/key}
  </div>
  <button
    class="app-bar-icon-btn"
    id="settings-btn"
    type="button"
    aria-label="Open settings"
    title="Settings"
    onclick={() => app.openSettings()}
  >
    <i aria-hidden="true">settings</i>
  </button>
</div>
