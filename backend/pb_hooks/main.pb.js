for (const action of ['bootstrap', 'changes', 'content', 'share-list']) {
	routerAdd(
		'GET',
		`/api/jnote/v2/${action}`,
		(e) => require(`${__hooks}/jnote.js`).handle(e, e.request.url.path.split('/').pop()),
		$apis.requireAuth('users')
	);
}
for (const action of ['vault', 'commit', 'object', 'share']) {
	routerAdd(
		'POST',
		`/api/jnote/v2/${action}`,
		(e) => require(`${__hooks}/jnote.js`).handle(e, e.request.url.path.split('/').pop()),
		$apis.requireAuth('users'),
		$apis.bodyLimit(3000000)
	);
}
routerAdd('GET', '/api/jnote/v2/public/{shareId}', (e) =>
	require(`${__hooks}/jnote.js`).publicRead(e)
);
// Explicit one-time command. No ordinary migration or serve command erases data.
$app.rootCmd.addCommand(
	new Command({
		use: 'jnote-cutover',
		run: (cmd, args) => {
			require(`${__hooks}/cutover.js`).run($app, args);
		}
	})
);
$app.rootCmd.addCommand(
	new Command({
		use: 'jnote-check',
		run: () => require(`${__hooks}/maintenance.js`).check($app)
	})
);
$app.rootCmd.addCommand(
	new Command({
		use: 'jnote-restore-control',
		run: (cmd, args) => require(`${__hooks}/maintenance.js`).restoreControl($app, args)
	})
);

// Install these guards before cutover. They also block old clients when collection
// rules are still cached by the serving process during schema replacement.
const jnoteCollections = [
	'jnote',
	'jnote_content',
	'jnote_vaults',
	'jnote_key_grants',
	'jnote_private_objects',
	'jnote_operations',
	'jnote_changes',
	'jnote_public_shares',
	'jnote_control'
];
for (const register of [onRecordCreateRequest, onRecordUpdateRequest, onRecordDeleteRequest]) {
	register(
		(e) => {
			if (!e.hasSuperuserAuth()) throw new ForbiddenError('Use the versioned JNote API.');
			return e.next();
		},
		...jnoteCollections
	);
}
