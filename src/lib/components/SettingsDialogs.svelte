<script>
  import { tick } from 'svelte';

  let { app } = $props();

  let settingsDialog = $state();
  let customCssDialog = $state();
  let changeKeyDialog = $state();
  let customCssInput = $state();
  let currentKeyInput = $state();
  let newKeyInput = $state();
  let confirmKeyInput = $state();

  let cssDraft = $state('');
  let currentKey = $state('');
  let newKey = $state('');
  let confirmKey = $state('');

  $effect(() => {
    if (!settingsDialog) return;
    if (app.settingsOpen && !settingsDialog.open) settingsDialog.showModal();
    else if (!app.settingsOpen && settingsDialog.open) settingsDialog.close();
  });

  $effect(() => {
    if (!customCssDialog) return;
    if (app.customCssOpen && !customCssDialog.open) {
      cssDraft = app.customCss;
      customCssDialog.showModal();
      tick().then(() => customCssInput?.focus());
    } else if (!app.customCssOpen && customCssDialog.open) {
      customCssDialog.close();
    }
  });

  $effect(() => {
    if (!changeKeyDialog) return;
    if (app.changeKeyOpen && !changeKeyDialog.open) {
      currentKey = '';
      newKey = '';
      confirmKey = '';
      changeKeyDialog.showModal();
      tick().then(() => currentKeyInput?.focus());
    } else if (!app.changeKeyOpen && changeKeyDialog.open) {
      changeKeyDialog.close();
    }
  });

  function closeOnBackdrop(event, close) {
    const dialog = event.currentTarget;
    if (!dialog.open) return;
    const rect = dialog.getBoundingClientRect();
    const clickedInside = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
    if (!clickedInside) close();
  }

  function saveCss() {
    app.saveCustomCss(cssDraft);
    app.customCssOpen = false;
  }

  function clearCss() {
    cssDraft = '';
    app.saveCustomCss('');
  }

  function clearKeyError() {
    app.changeKeyError = '';
  }

  async function submitKeyChange(event) {
    event.preventDefault();
    const result = await app.submitKeyChange(currentKey, newKey, confirmKey);

    if (result.focus === 'current') currentKeyInput?.focus();
    else if (result.focus === 'new') {
      newKeyInput?.focus();
      newKeyInput?.select();
    } else if (result.focus === 'confirm') {
      confirmKeyInput?.focus();
      confirmKeyInput?.select();
    }

    if (result.ok) {
      currentKey = '';
      newKey = '';
      confirmKey = '';
      window.setTimeout(() => {
        app.closeChangeKey();
        alert('Your decryption key was changed and existing notes were re-encrypted.');
      }, 250);
    }
  }

  function cancelChangeKey(event) {
    if (app.changeKeyBusy || app.isKeyMigrationRunning) {
      event.preventDefault();
      return;
    }
    app.changeKeyOpen = false;
  }
</script>

<dialog
  bind:this={settingsDialog}
  class="settings-dialog"
  id="settings-dialog"
  aria-labelledby="settings-dialog-title"
  onclose={() => (app.settingsOpen = false)}
  oncancel={() => (app.settingsOpen = false)}
  onclick={(event) => closeOnBackdrop(event, () => (app.settingsOpen = false))}
>
  <div class="settings-dialog-content">
    <div class="settings-dialog-header">
      <h2 id="settings-dialog-title">Settings</h2>
      <button
        class="icon-dialog-btn"
        type="button"
        aria-label="Close settings"
        title="Close"
        onclick={() => (app.settingsOpen = false)}
      >
        <i aria-hidden="true">close</i>
      </button>
    </div>
    <button class="settings-row-button" id="open-custom-css-dialog" type="button" onclick={() => app.openCustomCss()}>
      <i aria-hidden="true">code</i>
      <span>Custom CSS</span>
    </button>
    <button
      class="settings-row-button"
      id="download-all-data"
      type="button"
      disabled={app.exportBusy}
      onclick={() => app.downloadAllDataNotes()}
    >
      <i aria-hidden="true">file_download</i>
      <span>{app.exportBusy ? 'Preparing download...' : 'Download all data/notes'}</span>
    </button>
    <button class="settings-row-button" id="open-change-key-dialog" type="button" onclick={() => app.openChangeKey()}>
      <i aria-hidden="true">key</i>
      <span>Change decryption key</span>
    </button>
    <button class="settings-row-button" id="forget-remembered-device" type="button" onclick={() => app.forgetThisDevice()}>
      <i aria-hidden="true">lock</i>
      <span>Forget remembered device</span>
    </button>
  </div>
</dialog>

<dialog
  bind:this={customCssDialog}
  class="settings-dialog custom-css-dialog"
  id="custom-css-dialog"
  aria-labelledby="custom-css-dialog-title"
  onclose={() => (app.customCssOpen = false)}
  oncancel={() => (app.customCssOpen = false)}
  onclick={(event) => closeOnBackdrop(event, () => (app.customCssOpen = false))}
>
  <div class="settings-dialog-content">
    <div class="settings-dialog-header">
      <h2 id="custom-css-dialog-title">Custom CSS</h2>
      <button
        class="icon-dialog-btn"
        type="button"
        aria-label="Close custom CSS"
        title="Close"
        onclick={() => (app.customCssOpen = false)}
      >
        <i aria-hidden="true">close</i>
      </button>
    </div>
    <textarea
      bind:this={customCssInput}
      bind:value={cssDraft}
      id="custom-css-input"
      spellcheck="false"
      placeholder={'body { }'}
    ></textarea>
    <div class="settings-dialog-actions">
      <button class="btn-secondary" id="clear-custom-css" type="button" onclick={clearCss}>Clear</button>
      <button class="btn-primary" id="save-custom-css" type="button" onclick={saveCss}>Save</button>
    </div>
  </div>
</dialog>

<dialog
  bind:this={changeKeyDialog}
  class="settings-dialog change-key-dialog"
  id="change-key-dialog"
  aria-labelledby="change-key-dialog-title"
  onclose={() => {
    if (!app.changeKeyBusy && !app.isKeyMigrationRunning) app.changeKeyOpen = false;
  }}
  oncancel={cancelChangeKey}
  onclick={(event) => closeOnBackdrop(event, () => app.closeChangeKey())}
>
  <form class="settings-dialog-content" id="change-key-form" autocomplete="off" onsubmit={submitKeyChange}>
    <div class="settings-dialog-header">
      <h2 id="change-key-dialog-title">Change decryption key</h2>
      <button
        class="icon-dialog-btn"
        id="close-change-key-dialog"
        type="button"
        aria-label="Close change key"
        title="Close"
        disabled={app.changeKeyBusy}
        onclick={() => app.closeChangeKey()}
      >
        <i aria-hidden="true">close</i>
      </button>
    </div>
    <p class="settings-dialog-copy">
      Re-encrypt every note with a new key. Keep this app open until the process finishes.
    </p>
    <p class="settings-dialog-warning">Do not close or refresh the app while notes are being re-encrypted.</p>
    <div class="field border label settings-field">
      <input
        bind:this={currentKeyInput}
        bind:value={currentKey}
        type="password"
        id="current-decryption-key"
        autocomplete="off"
        disabled={app.changeKeyBusy}
        required
        oninput={clearKeyError}
      />
      <label for="current-decryption-key">Current key</label>
    </div>
    <div class="field border label settings-field">
      <input
        bind:this={newKeyInput}
        bind:value={newKey}
        type="password"
        id="new-decryption-key"
        autocomplete="off"
        disabled={app.changeKeyBusy}
        required
        oninput={clearKeyError}
      />
      <label for="new-decryption-key">New key</label>
    </div>
    <div class="field border label settings-field">
      <input
        bind:this={confirmKeyInput}
        bind:value={confirmKey}
        type="password"
        id="confirm-new-decryption-key"
        autocomplete="off"
        disabled={app.changeKeyBusy}
        required
        oninput={clearKeyError}
      />
      <label for="confirm-new-decryption-key">Confirm new key</label>
    </div>

    {#if app.changeKeyStatus}
      <p class="settings-dialog-status" id="change-key-status" role="status" aria-live="polite">
        {app.changeKeyStatus}
      </p>
    {/if}
    {#if app.changeKeyError}
      <p class="settings-dialog-error" id="change-key-error" role="alert">{app.changeKeyError}</p>
    {/if}

    <div class="settings-dialog-actions">
      <button
        class="btn-secondary"
        id="cancel-change-key"
        type="button"
        disabled={app.changeKeyBusy}
        onclick={() => app.closeChangeKey()}
      >
        Cancel
      </button>
      <button class="btn-primary" id="submit-change-key" type="submit" disabled={app.changeKeyBusy}>
        {app.changeKeyBusy ? 'Changing key...' : 'Change key'}
      </button>
    </div>
  </form>
</dialog>
