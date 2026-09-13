<script>
  import { onMount, tick } from 'svelte';

  let { app } = $props();
  let passphrase = $state('');
  let passphraseElement;
  let submittedChoice = $state('remember');
  let signInUrl = $state('https://joe.mt/account/');

  onMount(() => {
    signInUrl = `https://joe.mt/account/?redirect=${encodeURIComponent(window.location.href)}`;
  });

  const isSetup = $derived(app.unlockMode === 'setup');
  const isAuthRequired = $derived(app.unlockMode === 'auth-required');
  const isLoading = $derived(app.unlockMode === 'loading');

  $effect(() => {
    const mode = app.unlockMode;
    if (mode === 'setup' || mode === 'unlock') {
      tick().then(() => passphraseElement?.focus());
    }
  });

  async function submit(event) {
    event.preventDefault();
    const button = event.submitter;
    const rememberDevice = button?.dataset.rememberDevice === 'true';
    submittedChoice = rememberDevice ? 'remember' : 'once';
    if (!passphrase) {
      app.encryptionError = 'Enter a passphrase to unlock your notes.';
      passphraseElement?.focus();
      return;
    }

    const success = await app.submitEncryptionKey(passphrase, rememberDevice);
    if (!success) {
      await tick();
      passphraseElement?.focus();
      passphraseElement?.select();
    }
  }
</script>

<div
  class="encryption-modal show"
  id="encryption-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="encryption-title"
>
  <form class="encryption-modal-content" id="encryption-form" autocomplete="off" onsubmit={submit}>
    <h2 id="encryption-title">
      {#if isAuthRequired}
        Sign in required
      {:else if isLoading}
        Unlocking encrypted notes
      {:else if isSetup}
        Create encryption key
      {:else}
        Unlock encrypted notes
      {/if}
    </h2>

    <p class="encryption-copy">
      {#if isAuthRequired}
        JNote uses your joe.mt account session.
      {:else if isLoading}
        Checking this browser for a saved encryption key…
      {:else if isSetup}
        Choose the key that will encrypt your notes. This key is never sent to the server.
      {:else}
        Enter your decryption key to decrypt your notes.
      {/if}
    </p>
    <p class="encryption-warning">
      {#if isAuthRequired}
        Sign in with the account link below to return to JNote.
      {:else}
        If you forget this key, your notes cannot be recovered.
      {/if}
    </p>

    {#if isAuthRequired}
      <p class="encryption-auth-copy" id="encryption-auth-copy">
        Sign in at <a href={signInUrl}>joe.mt/account</a>, then return to JNote.
      </p>
    {/if}

    <div class="field border label encryption-field">
      <input
        bind:this={passphraseElement}
        bind:value={passphrase}
        type="password"
        id="encryption-passphrase"
        autocomplete={isSetup ? 'new-password' : 'current-password'}
        disabled={isAuthRequired || isLoading || app.unlockBusy}
        required
        oninput={() => (app.encryptionError = '')}
      />
      <label for="encryption-passphrase">{isSetup ? 'New encryption key' : 'Decryption key'}</label>
    </div>

    {#if app.encryptionError}
      <p class="encryption-error" id="encryption-error" role="alert">{app.encryptionError}</p>
    {/if}

    <div class="encryption-actions">
      <button
        class="btn-primary encryption-submit"
        type="submit"
        data-remember-device="true"
        disabled={isAuthRequired || isLoading || app.unlockBusy}
      >
        {app.unlockBusy && submittedChoice === 'remember'
          ? 'Unlocking…'
          : isSetup ? 'Create and Save in Browser' : 'Unlock and Remember'}
      </button>
      <button
        class="btn-secondary encryption-submit"
        type="submit"
        data-remember-device="false"
        disabled={isAuthRequired || isLoading || app.unlockBusy}
      >
        {app.unlockBusy && submittedChoice === 'once'
          ? 'Unlocking…'
          : isSetup ? 'Create and Unlock Once' : 'Unlock Once'}
      </button>
    </div>
  </form>
</div>
