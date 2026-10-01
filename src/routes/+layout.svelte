<script>
	import '../../style.css';
	import { beforeNavigate } from '$app/navigation';
	beforeNavigate(({ to, cancel }) => {
		if (!to) return;
		const publicPath = /(?:^|\/)s\/[^/]+\/?$/.test(to.url.pathname);
		if (publicPath !== Boolean(window.__jnotePublic)) {
			cancel();
			window.location.assign(to.url.href);
		}
	});

	let { children } = $props();
</script>

{@render children()}
