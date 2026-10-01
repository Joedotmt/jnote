function run(app, args) {
	// Positional: expected-instance comma-separated-approved-owners target-epoch. Run against the
	// configured production data directory after installing the write-blocking request guards and taking a snapshot.
	app.bootstrap();
	const [instance, ownerList, epoch] = args;
	const owners = (ownerList || '').split(',').filter(Boolean).sort();
	if (
		!instance ||
		!owners.length ||
		new Set(owners).size !== owners.length ||
		!/^(?:[0-9a-f-]{36}|[A-Za-z0-9_-]{32})$/i.test(epoch || '')
	)
		throw new Error('Usage: jnote-cutover <instance> <approved-owners> <target-epoch>');
	if ($os.getenv('JNOTE_INSTANCE') !== instance)
		throw new Error('Instance confirmation does not match JNOTE_INSTANCE.');
	const userIds = new Set(app.findAllRecords('users').map((r) => r.id));
	if (owners.some((owner) => !userIds.has(owner))) throw new Error('Unexpected approved owner.');
	const schema = require(`${__hooks}/schema.js`);
	const allowed = Object.keys(schema.definitions);
	const unexpected = app
		.findAllCollections()
		.filter((c) => c.name.startsWith('jnote') && !allowed.includes(c.name));
	if (unexpected.length) throw new Error('Unexpected JNote collection; inspect before reset.');
	let control;
	try {
		control = app.findFirstRecordByData('jnote_control', 'name', 'active');
	} catch {}
	if (control?.getString('resetReceipt')) {
		if (control.getString('epoch') !== epoch || control.getString('instance') !== instance)
			throw new Error('Reset already completed for another epoch/instance.');
		console.log('Cutover already completed; no deletion.');
		return;
	}
	if (control && control.getString('epoch') !== epoch) throw new Error('Stale target epoch.');
	const collections = app.findAllCollections();
	const jnoteIds = new Set(collections.filter((c) => allowed.includes(c.name)).map((c) => c.id));
	for (const c of collections) {
		if (allowed.includes(c.name)) {
			for (const r of app.findAllRecords(c.id)) {
				const recordOwner = r.getString('owner') || r.getString('user');
				if (recordOwner && !owners.includes(recordOwner))
					throw new Error('Unexpected record owner.');
			}
		} else {
			const fields = JSON.parse(JSON.stringify(c)).fields || [];
			if (fields.some((f) => f.type === 'relation' && jnoteIds.has(f.collectionId)))
				throw new Error('Unrelated collection references JNote; inspect before reset.');
		}
	}
	// Close legacy writes durably before destruction. Request guards must already be active in the serving process.
	for (const name of allowed) {
		let c;
		try {
			c = app.findCollectionByNameOrId(name);
		} catch {
			continue;
		}
		c.createRule = null;
		c.updateRule = null;
		c.deleteRule = null;
		c.listRule = null;
		c.viewRule = null;
		app.save(c);
	}
	if (control) {
		control.set('maintenance', true);
		app.save(control);
	}
	app.runInTransaction((tx) => {
		const order = [
			'jnote_public_shares',
			'jnote_changes',
			'jnote_operations',
			'jnote_private_objects',
			'jnote_key_grants',
			'jnote_content',
			'jnote',
			'jnote_vaults',
			'jnote_control'
		];
		for (const name of order) {
			let c;
			try {
				c = tx.findCollectionByNameOrId(name);
			} catch {
				continue;
			}
			for (const r of tx.findAllRecords(name)) {
				const recordOwner = r.getString('owner') || r.getString('user');
				if (recordOwner && !owners.includes(recordOwner))
					throw new Error('Unexpected record owner.');
				tx.delete(r);
			}
			tx.delete(c);
		}
		schema.install(tx, epoch, instance);
		const active = tx.findFirstRecordByData('jnote_control', 'name', 'active');
		active.set(
			'resetReceipt',
			JSON.stringify({ owner: owners[0], owners, epoch, completedAt: new Date().toISOString() })
		);
		tx.save(active);
	});
	console.log('JNote cutover completed: ' + epoch);
}
module.exports = { run };
