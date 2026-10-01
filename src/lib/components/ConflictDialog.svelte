<script>
	let { app } = $props();
	let comparison = $state(null);
	let selected = $state(null);
	let error = $state('');
	let busy = $state(false);
	let dialog;
	$effect(() => {
		if (app.unlockMode !== 'ready') {
			comparison = null;
			selected = null;
			error = '';
			dialog?.close();
		}
	});
	async function compare(item) {
		try {
			const value = await app.compareConflict(item);
			if (app.unlockMode !== 'ready') return;
			comparison = value;
			selected = item;
			dialog.showModal();
		} catch (e) {
			error = e.message;
		}
	}
	async function retry() {
		busy = true;
		try {
			await app.retryConflict(selected);
			dialog.close();
			comparison = null;
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}
	async function copy() {
		busy = true;
		try {
			await app.resolveConflictCopy(selected);
			dialog.close();
			comparison = null;
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}
</script>

{#if app.conflicts.length}
	<aside class="conflict-actions" aria-label="Sync conflicts">
		{#each app.conflicts as item (item.id)}
			<button type="button" onclick={() => compare(item)}
				>Review {item.endpoint === 'commit' ? 'note' : item.endpoint} conflict</button
			>
		{/each}
		{#if error}<p role="alert">{error}</p>{/if}
	</aside>
{/if}
<dialog
	bind:this={dialog}
	class="settings-dialog"
	id="conflict-dialog"
	aria-label="Compare note conflict"
>
	<div class="settings-dialog-content">
		{#if comparison}
			<h2>Local commit</h2>
			<h3>{comparison.local.title}</h3>
			<pre>{comparison.local.content}</pre>
			<h2>Cloud commit</h2>
			<h3>{comparison.cloud.title}</h3>
			<pre>{comparison.cloud.content}</pre>
			{#if comparison.kind === 'note'}
				<p>
					Save your local commit and its dependent commits as an independent note. The cloud note
					remains available for editing.
				</p>
				<button type="button" disabled={busy} onclick={copy}>Save conflict copy</button>
			{:else}<button type="button" disabled={busy} onclick={retry}
					>Retry local change against current cloud revision</button
				>{/if}
		{/if}
		{#if error}<p role="alert">{error}</p>{/if}
		<button type="button" onclick={() => dialog.close()}>Close</button>
	</div>
</dialog>

<style>
	.conflict-actions {
		position: fixed;
		bottom: 4rem;
		right: 1rem;
		z-index: 100;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 25vh;
		overflow: auto;
	}
</style>
