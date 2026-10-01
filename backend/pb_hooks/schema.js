// Tested on PocketBase 0.28.2 and 0.40.3. Generic client access is closed.
const definitions = {
	jnote_control: {
		text: ['name', 'epoch', 'instance', 'resetReceipt'],
		number: ['minimumClient', 'sequence'],
		bool: ['maintenance'],
		indexes: ['CREATE UNIQUE INDEX jnote_control_name ON jnote_control (name)']
	},
	jnote_vaults: {
		text: ['owner', 'epoch', 'revision'],
		json: ['header'],
		indexes: ['CREATE UNIQUE INDEX jnote_vault_owner ON jnote_vaults (owner)']
	},
	jnote: {
		text: ['owner', 'epoch', 'logicalId', 'revision', 'summaryRevision'],
		number: ['generation'],
		bool: ['deleted'],
		json: ['summary'],
		indexes: ['CREATE UNIQUE INDEX jnote_identity ON jnote (owner, epoch, logicalId)']
	},
	jnote_content: {
		text: ['owner', 'epoch', 'logicalId', 'revision', 'parentRevision', 'operationId'],
		number: ['generation', 'sequence'],
		json: ['ciphertext'],
		indexes: [
			'CREATE UNIQUE INDEX jnote_revision ON jnote_content (owner, epoch, revision)',
			'CREATE UNIQUE INDEX jnote_content_operation ON jnote_content (owner, epoch, operationId)',
			'CREATE INDEX jnote_history ON jnote_content (owner, epoch, logicalId)'
		]
	},
	jnote_key_grants: {
		text: ['owner', 'epoch', 'logicalId', 'recipientKind', 'recipientId', 'scheme'],
		number: ['generation'],
		json: ['wrapper'],
		indexes: [
			'CREATE UNIQUE INDEX jnote_grant ON jnote_key_grants (owner, epoch, logicalId, generation, recipientKind, recipientId)'
		]
	},
	jnote_private_objects: {
		text: ['owner', 'epoch', 'objectId', 'objectType', 'revision'],
		bool: ['deleted'],
		json: ['ciphertext'],
		indexes: [
			'CREATE UNIQUE INDEX jnote_private_id ON jnote_private_objects (owner, epoch, objectId)'
		]
	},
	jnote_operations: {
		text: ['owner', 'epoch', 'operationId', 'fingerprint'],
		json: ['receipt'],
		indexes: ['CREATE UNIQUE INDEX jnote_operation ON jnote_operations (owner, epoch, operationId)']
	},
	jnote_changes: {
		text: ['owner', 'epoch', 'objectId', 'type', 'revision'],
		number: ['sequence'],
		json: ['value', 'grant'],
		indexes: [
			'CREATE UNIQUE INDEX jnote_change_sequence ON jnote_changes (epoch, sequence)',
			'CREATE INDEX jnote_owner_cursor ON jnote_changes (owner, epoch, sequence)'
		]
	},
	jnote_public_shares: {
		text: ['owner', 'epoch', 'shareId', 'sourceNote', 'sourceRevision', 'revision', 'expires'],
		bool: ['enabled'],
		json: ['ciphertext', 'ownerWrapper'],
		indexes: [
			'CREATE UNIQUE INDEX jnote_share_id ON jnote_public_shares (shareId)',
			'CREATE INDEX jnote_source_shares ON jnote_public_shares (owner, epoch, sourceNote)'
		]
	}
};
function install(app, epoch, instance) {
	app.findCollectionByNameOrId('users');
	for (const name of Object.keys(definitions)) {
		let old = null;
		try {
			old = app.findCollectionByNameOrId(name);
		} catch {}
		if (old) {
			if (!old.fields.getByName('epoch'))
				throw new Error('Legacy schema requires explicit jnote-cutover.');
			continue;
		}
		const d = definitions[name];
		const fields = [];
		for (const field of d.text || []) fields.push({ name: field, type: 'text', max: 500 });
		for (const field of d.number || [])
			fields.push({ name: field, type: 'number', onlyInt: true, min: 0 });
		for (const field of d.bool || []) fields.push({ name: field, type: 'bool' });
		for (const field of d.json || []) fields.push({ name: field, type: 'json', maxSize: 3000000 });
		fields.push(
			{ name: 'created', type: 'autodate', onCreate: true },
			{ name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
		);
		app.save(
			new Collection({
				name,
				type: 'base',
				fields,
				indexes: d.indexes,
				listRule: null,
				viewRule: null,
				createRule: null,
				updateRule: null,
				deleteRule: null
			})
		);
	}
	let control;
	try {
		control = app.findFirstRecordByData('jnote_control', 'name', 'active');
	} catch {}
	if (!control) {
		control = new Record(app.findCollectionByNameOrId('jnote_control'));
		control.load({
			name: 'active',
			epoch,
			instance,
			minimumClient: 2,
			sequence: 0,
			maintenance: false
		});
		app.save(control);
	}
	// Dedicated limiter state avoids changing account-service rate-limit settings.
	app
		.db()
		.newQuery(
			'CREATE TABLE IF NOT EXISTS jnote_public_limits (client TEXT PRIMARY KEY, window INTEGER NOT NULL, requests INTEGER NOT NULL)'
		)
		.execute();
	app
		.db()
		.newQuery(
			'CREATE INDEX IF NOT EXISTS jnote_public_limit_window ON jnote_public_limits (window)'
		)
		.execute();
}
module.exports = { definitions, install };
