migrate(
	(app) => {
		// Existing legacy collections cause a refusal; only the explicit cutover can reset.
		// Older migration runtimes omit __hooks. Custom layouts can set this env var.
		const hooks =
			$os.getenv('JNOTE_HOOKS_DIR') ||
			(typeof __hooks === 'undefined' ? `${app.dataDir()}/../pb_hooks` : __hooks);
		require(`${hooks}/schema.js`).install(
			app,
			$security.randomString(32),
			$os.getenv('JNOTE_INSTANCE') || 'disposable'
		);
	},
	(app) => {
		throw new Error('JNote v2 has no destructive downgrade. Fix forward.');
	}
);
