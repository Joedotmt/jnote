<script>
	import { base } from '$app/paths';
	let { app } = $props();
	let dialog;
	let expiry = $state('');
	$effect(() => {
		if (!dialog) return;
		if (app.sharingOpen && !dialog.open) dialog.showModal();
		else if (!app.sharingOpen && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	class="settings-dialog"
	id="sharing-dialog"
	onclose={() => (app.sharingOpen = false)}
	aria-labelledby="sharing-title"
>
	<div class="settings-dialog-content">
		<h2 id="sharing-title">Public snapshots</h2>
		<p>
			Publish the committed title and body. Anyone with the full link can read and retain it.
			Drafts, folders, and history stay private.
		</p>
		<label for="share-expiry">Optional expiry</label>
		<input id="share-expiry" type="datetime-local" bind:value={expiry} />
		<button
			type="button"
			class="btn-primary"
			disabled={app.sharingBusy}
			onclick={() => app.publishSnapshot(expiry ? new Date(expiry).toISOString() : '')}
			>Create new link</button
		>
		{#if app.sharingError}<p role="alert">{app.sharingError}</p>{/if}
		{#each app.shares as share (share.shareId)}
			<div class="share-item">
				<p>
					{share.enabled ? 'Enabled' : 'Disabled'} · {share.expires
						? `Expires ${new Date(share.expires).toLocaleString()}`
						: 'No expiry'}
				</p>
				{#if share.enabled}
					<button
						type="button"
						disabled={app.sharingBusy}
						onclick={() => app.copyPublicationLink(share, base)}>Copy link</button
					>
					<button
						type="button"
						disabled={app.sharingBusy}
						onclick={() => app.republishSnapshot(share)}>Republish current commit</button
					>
					<button
						type="button"
						disabled={app.sharingBusy}
						onclick={() => app.disablePublication(share)}>Disable</button
					>
				{/if}
			</div>
		{/each}
		<button type="button" class="btn-secondary" onclick={() => (app.sharingOpen = false)}
			>Close</button
		>
	</div>
</dialog>
