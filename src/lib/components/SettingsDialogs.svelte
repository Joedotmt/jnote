<script>
	import { tick } from 'svelte';
	import { normalizeNoteImport } from '../noteImport.js';

	let { app } = $props();

	let settingsDialog = $state();
	let customCssDialog = $state();
	let changeKeyDialog = $state();
	let importDialog = $state();
	let importInput = $state();
	let importData = $state.raw(null);
	let importPreview = $state.raw(null);
	let importReading = $state(false);
	let importComplete = $state(false);
	let importReadSequence = 0;
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
			currentKey = '';
			newKey = '';
			confirmKey = '';
		}
	});

	$effect(() => {
		if (!importDialog) return;
		if (app.importOpen && !importDialog.open) importDialog.showModal();
		else if (!app.importOpen && importDialog.open) {
			importDialog.close();
			importReadSequence += 1;
			importData = null;
			importPreview = null;
			importReading = false;
			if (importInput) importInput.value = '';
		}
	});

	function openImport() {
		app.settingsOpen = false;
		app.importError = '';
		app.importStatus = '';
		importComplete = false;
		app.importOpen = true;
	}

	async function readImportFile(event) {
		const file = event.currentTarget.files?.[0];
		const sequence = ++importReadSequence;
		importData = null;
		importPreview = null;
		importComplete = false;
		app.importError = '';
		app.importStatus = '';
		importReading = false;
		if (!file) return;
		importReading = true;
		try {
			const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
			const preview = normalizeNoteImport(data);
			if (sequence !== importReadSequence || !app.importOpen) return;
			importData = data;
			importPreview = preview;
		} catch (error) {
			if (sequence === importReadSequence && app.importOpen)
				app.importError =
					error instanceof SyntaxError
						? 'This file is not valid JSON. Choose your JNote export file.'
						: error.message;
		} finally {
			if (sequence === importReadSequence) importReading = false;
		}
	}

	async function submitImport(event) {
		event.preventDefault();
		if (!importData || importComplete) return;
		importComplete = await app.importNotes(importData);
		if (importComplete) {
			importData = null;
			importPreview = null;
		}
	}

	function closeImport(event) {
		if (app.importBusy) {
			event?.preventDefault();
			return;
		}
		app.importOpen = false;
	}

	function closeOnBackdrop(event, close) {
		const dialog = event.currentTarget;
		if (!dialog.open) return;
		const rect = dialog.getBoundingClientRect();
		const clickedInside =
			event.clientX >= rect.left &&
			event.clientX <= rect.right &&
			event.clientY >= rect.top &&
			event.clientY <= rect.bottom;
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
				alert('Your passphrase was changed. Note and history ciphertext is unchanged.');
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
		<button
			class="settings-row-button"
			id="open-custom-css-dialog"
			type="button"
			onclick={() => app.openCustomCss()}
		>
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
		<button
			class="settings-row-button"
			id="open-import-notes-dialog"
			type="button"
			disabled={app.importBusy}
			onclick={openImport}
		>
			<i aria-hidden="true">file_upload</i>
			<span>Import notes</span>
		</button>
		<button
			class="settings-row-button"
			id="open-change-key-dialog"
			type="button"
			onclick={() => app.openChangeKey()}
		>
			<i aria-hidden="true">key</i>
			<span>Change decryption key</span>
		</button>
		<button
			class="settings-row-button"
			id="forget-remembered-device"
			type="button"
			onclick={() => app.forgetThisDevice()}
		>
			<i aria-hidden="true">lock</i>
			<span>Forget decryption key</span>
		</button>
		{#if app.authMode === 'redirect'}
			<button class="settings-row-button" id="sign-out" type="button" onclick={() => app.signOut()}>
				<i aria-hidden="true">logout</i>
				<span>Sign out</span>
			</button>
		{/if}
	</div>
</dialog>

<dialog
	bind:this={importDialog}
	class="settings-dialog import-notes-dialog"
	id="import-notes-dialog"
	aria-labelledby="import-notes-dialog-title"
	onclose={() => (app.importOpen = false)}
	oncancel={closeImport}
	onclick={(event) => closeOnBackdrop(event, () => closeImport())}
>
	<form class="settings-dialog-content" onsubmit={submitImport}>
		<div class="settings-dialog-header">
			<h2 id="import-notes-dialog-title">Import notes</h2>
			<button
				class="icon-dialog-btn"
				type="button"
				aria-label="Close import"
				disabled={app.importBusy}
				onclick={closeImport}
			>
				<i aria-hidden="true">close</i>
			</button>
		</div>
		<p class="settings-dialog-copy">
			Choose the JSON file from Download all data/notes. Older JNote exports work too. Notes,
			folders, and saved versions are added as new copies, encrypted with your current key. Unsaved
			text is included as a saved version. Existing notes stay as they are.
		</p>
		<label for="import-notes-file">JNote export file</label>
		<input
			bind:this={importInput}
			id="import-notes-file"
			type="file"
			accept=".json,application/json"
			disabled={app.importBusy || importComplete}
			onchange={readImportFile}
		/>
		{#if importReading}
			<p class="settings-dialog-status" role="status">Reading backup…</p>
		{/if}
		{#if importPreview}
			<p class="settings-dialog-copy" id="import-notes-preview">
				{importPreview.activeCount}
				{importPreview.activeCount === 1 ? 'note' : 'notes'},
				{importPreview.versionCount} saved versions.
				{#if importPreview.deletedCount}{importPreview.deletedCount} deleted notes will stay deleted.{/if}
				Importing this file again adds another set of copies.
			</p>
		{/if}
		{#if app.importStatus}
			<p class="settings-dialog-status" id="import-notes-status" role="status" aria-live="polite">
				{app.importStatus}
			</p>
		{/if}
		{#if app.importError}
			<p class="settings-dialog-error" id="import-notes-error" role="alert">{app.importError}</p>
		{/if}
		<div class="settings-dialog-actions">
			<button class="btn-secondary" type="button" disabled={app.importBusy} onclick={closeImport}
				>{importComplete ? 'Done' : 'Cancel'}</button
			>
			{#if !importComplete}
				<button
					class="btn-primary"
					id="submit-import-notes"
					type="submit"
					disabled={!importPreview || importReading || app.importBusy}
				>
					{app.importBusy ? 'Importing…' : 'Import notes'}
				</button>
			{/if}
		</div>
	</form>
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
			placeholder={'body { }'}></textarea>
		<div class="settings-dialog-actions">
			<button class="btn-secondary" id="clear-custom-css" type="button" onclick={clearCss}
				>Clear</button
			>
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
	<form
		class="settings-dialog-content"
		id="change-key-form"
		autocomplete="off"
		onsubmit={submitKeyChange}
	>
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
			Change the passphrase protecting your vault. Notes, history, and public links keep their
			existing keys.
		</p>
		<p class="settings-dialog-warning">
			Wait for cloud confirmation. This change does not revoke keys or copies already obtained.
		</p>
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
