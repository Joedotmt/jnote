const collections = [
	'jnote',
	'jnote_content',
	'jnote_vaults',
	'jnote_key_grants',
	'jnote_private_objects',
	'jnote_operations',
	'jnote_changes',
	'jnote_public_shares'
];

function check(app) {
	app.bootstrap();
	const control = app.findFirstRecordByData('jnote_control', 'name', 'active');
	if (
		!control.getString('epoch') ||
		control.getInt('minimumClient') !== 2 ||
		control.getBool('maintenance') ||
		control.getString('instance') !== $os.getenv('JNOTE_INSTANCE')
	)
		throw new Error('JNote control is not ready.');
	console.log('JNote ready: ' + control.getString('epoch'));
}

// Recovery of missing metadata is explicit and uses an already recorded receipt.
// Refuse to guess an epoch or sequence when encrypted records already exist.
function restoreControl(app, args) {
	app.bootstrap();
	const [instance, epoch, completedAt, ownerList] = args;
	const owners = (ownerList || '').split(',').filter(Boolean).sort();
	if (
		instance !== $os.getenv('JNOTE_INSTANCE') ||
		!instance ||
		!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{32})$/i.test(
			epoch || ''
		) ||
		!Number.isFinite(Date.parse(completedAt)) ||
		!owners.length ||
		new Set(owners).size !== owners.length
	)
		throw new Error(
			'Provide the confirmed instance, original epoch, completion time and approved owners.'
		);
	for (const owner of owners) app.findRecordById('users', owner);
	app.runInTransaction((tx) => {
		const existing = tx.findAllRecords('jnote_control');
		if (existing.length) {
			if (
				existing.length !== 1 ||
				existing[0].getString('name') !== 'active' ||
				existing[0].getString('epoch') !== epoch ||
				existing[0].getString('instance') !== instance
			)
				throw new Error('Existing JNote control differs; no changes made.');
			return;
		}
		for (const name of collections) {
			const collection = tx.findCollectionByNameOrId(name);
			if (!collection.fields.getByName('epoch') || tx.findAllRecords(name).length)
				throw new Error(
					'Restore control from a verified backup when JNote data exists; no changes made.'
				);
		}
		const control = new Record(tx.findCollectionByNameOrId('jnote_control'));
		control.load({
			name: 'active',
			epoch,
			instance,
			minimumClient: 2,
			sequence: 0,
			maintenance: false,
			resetReceipt: JSON.stringify({ owner: owners[0], owners, epoch, completedAt })
		});
		tx.save(control);
	});
	console.log('JNote control verified/restored: ' + epoch + '; no records reset.');
}

module.exports = { check, restoreControl };
