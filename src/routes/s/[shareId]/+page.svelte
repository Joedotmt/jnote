<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { readPublication } from '$lib/publicSharing.js';
	let status = $state('Opening publication…');
	let publication = $state(null);
	onMount(() => {
		const key = window.__jnoteTakeShareKey?.() || '';
		readPublication(page.params.shareId, key)
			.then((value) => {
				publication = value;
				status = '';
			})
			.catch((error) => {
				status = error.message;
			});
	});
</script>

<svelte:head>
	<title>JNote public snapshot</title>
	<meta name="referrer" content="no-referrer" />
	<meta name="robots" content="noindex, nofollow, noarchive" />
</svelte:head>
<main class="public-viewer">
	<p class="label">JNote · Read-only snapshot</p>
	{#if publication}
		<h1>{publication.title || 'Untitled'}</h1>
		<div class="body">{publication.content}</div>
		<p class="notice">
			A snapshot of a committed note. The full link can be forwarded. Disabling the link prevents
			future downloads and cannot recall received copies.
		</p>
	{:else}<p role="status">{status}</p>{/if}
</main>

<style>
	:global(html.jnote-public) {
		height: auto;
		overflow: auto;
	}
	:global(html.jnote-public body) {
		height: auto;
		min-height: 100svh;
		overflow: visible;
		margin: 0;
		display: block;
		background: #121316;
	}
	.public-viewer {
		max-width: 48rem;
		margin: 0 auto;
		padding: 3rem 1.5rem;
		color: #e5e7eb;
		font:
			1rem/1.65 system-ui,
			sans-serif;
	}
	h1 {
		font-size: 2rem;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.label,
	.notice {
		color: #9ca3af;
		font-size: 0.85rem;
	}
	.notice {
		margin-top: 3rem;
	}
</style>
