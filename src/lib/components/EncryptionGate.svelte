<script>
  import { tick } from 'svelte';
  import { accountsOrigin } from '$lib/accounts.js';

  let { app } = $props();
  let passphrase = $state('');
  let passphraseElement = $state();
  let submittedChoice = $state('remember');

  const accountsLabel = new URL(accountsOrigin()).host;
  // app.signInUrl is safe to read at any time; the account client throws on origins it
  // does not serve rather than returning a usable link.
  const signInUrl = $derived(app.signInUrl);

  const isSetup = $derived(app.unlockMode === 'setup');
  const isAuthRequired = $derived(app.unlockMode === 'auth-required');
  const isLoading = $derived(app.unlockMode === 'loading');
  const canSignIn = $derived(isAuthRequired && app.authMode !== 'unsupported');

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
        JNote uses your {accountsLabel} session.
      {:else if isLoading}
        Checking this browser for a saved encryption key…
      {:else if isSetup}
        Choose the key that will encrypt your notes. This key is never sent to the server.
      {:else}
        Enter your decryption key to decrypt your notes.
      {/if}
    </p>
    {#if !isAuthRequired}
      <p class="encryption-warning">If you forget this key, your notes cannot be recovered.</p>
    {/if}

    {#if isAuthRequired}
      <p class="encryption-auth-copy" id="encryption-auth-copy">
        {#if canSignIn}
          You will be taken to {accountsLabel} and brought straight back.
        {:else}
          Add this origin to the account site's allowlist, or open JNote from an origin
          it already serves.
        {/if}
      </p>

      {#if canSignIn}
        <div class="encryption-actions">
          <a class="btn-primary encryption-submit encryption-signin" id="account-sign-in" href={signInUrl}>
            Sign in at {accountsLabel}
          </a>
        </div>
      {/if}

      {#if app.accountError}
        <p class="encryption-error" id="account-error" role="alert">{app.accountError}</p>
      {/if}
    {/if}

    {#if !isAuthRequired}
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
    {/if}
  </form>
</div>
