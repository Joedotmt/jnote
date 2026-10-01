const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_-]{43}$/;
function fail(status, message) {
	throw new ApiError(status, message);
}
function id(value) {
	if (!uuid.test(value || '')) fail(400, 'Invalid object identity.');
}
function envelope(value) {
	if (
		!value ||
		value.v !== 2 ||
		value.alg !== 'A256GCM' ||
		!/^[A-Za-z0-9_-]{16}$/.test(value.iv || '') ||
		typeof value.ct !== 'string' ||
		value.ct.length < 22 ||
		value.ct.length > 2800000 ||
		!/^[A-Za-z0-9_-]+$/.test(value.ct)
	)
		fail(400, 'Unsupported ciphertext.');
}
function wrapper(value, owner, epoch, keyId, kind, revision) {
	if (
		value?.v !== 2 ||
		value.scheme !== 'aes256-gcm' ||
		value.keyId !== keyId ||
		value.generation !== 1 ||
		value.recipientKind !== kind ||
		value.recipientId !== owner ||
		value.revision !== revision ||
		JSON.stringify(value.scope) !== JSON.stringify([owner, epoch])
	)
		fail(400, 'Invalid key grant.');
	envelope(value.ciphertext);
}
function header(value, owner, epoch) {
	if (
		value?.format !== 2 ||
		value.epoch !== epoch ||
		value.kdf?.name !== 'PBKDF2' ||
		value.kdf.hash !== 'SHA-256' ||
		value.kdf.iterations !== 310000 ||
		!/^[A-Za-z0-9_-]{22}$/.test(value.kdf.salt || '')
	)
		fail(400, 'Invalid vault header.');
	id(value.revision);
	wrapper(value.wrapper, owner, epoch, 'vault', 'password', value.revision);
}
function parse(record, field) {
	const value = record.get(field);
	if (value == null) return null;
	const serialized = JSON.parse(JSON.stringify(value));
	if (Array.isArray(serialized)) {
		let raw = '';
		for (let i = 0; i < serialized.length; i += 8192)
			raw += String.fromCharCode(...serialized.slice(i, i + 8192));
		return JSON.parse(raw);
	}
	return serialized;
}
function find(app, collection, owner, epoch, field, value) {
	const records = app.findRecordsByFilter(
		collection,
		`owner={:owner} && epoch={:epoch} && ${field}={:value}`,
		'',
		1,
		0,
		{ owner, epoch, value }
	);
	return records[0] || null;
}
function create(app, collection, value) {
	const record = new Record(app.findCollectionByNameOrId(collection));
	record.load(value);
	app.save(record);
	return record;
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, canonical(value[k])])
		);
	return value;
}
function noteValue(record) {
	return {
		serverId: record.id,
		logicalId: record.getString('logicalId'),
		revision: record.getString('revision'),
		generation: record.getInt('generation'),
		summary: parse(record, 'summary'),
		summaryRevision: record.getString('summaryRevision'),
		deleted: record.getBool('deleted'),
		updated: record.getString('updated')
	};
}
function objectValue(record) {
	return {
		objectId: record.getString('objectId'),
		objectType: record.getString('objectType'),
		revision: record.getString('revision'),
		deleted: record.getBool('deleted'),
		ciphertext: parse(record, 'ciphertext')
	};
}
function shareValue(record) {
	return Object.fromEntries(
		[
			'shareId',
			'sourceNote',
			'sourceRevision',
			'revision',
			'expires',
			'enabled',
			'ciphertext',
			'ownerWrapper'
		].map((k) => [k, parse(record, k)])
	);
}
function change(app, control, owner, epoch, objectId, type, revision, value, grant = null) {
	const sequence = control.getInt('sequence') + 1;
	control.set('sequence', sequence);
	app.save(control);
	create(app, 'jnote_changes', { owner, epoch, objectId, type, revision, sequence, value, grant });
	return sequence;
}
function handle(e, action) {
	e.response.header().set('Cache-Control', 'no-store');
	if (!e.auth || e.auth.collection().name !== 'users') fail(401, 'Sign in required.');
	const owner = e.auth.id;
	const input =
		e.request.method === 'GET'
			? Object.fromEntries(
					['protocol', 'epoch', 'cursor', 'logicalId', 'revision', 'page'].map((k) => [
						k,
						e.request.url.query().get(k)
					])
				)
			: e.requestInfo().body;
	if (input.owner && input.owner !== owner) fail(403, 'Invalid owner.');
	let result;
	e.app.runInTransaction((app) => {
		const control = app.findFirstRecordByData('jnote_control', 'name', 'active');
		const epoch = control.getString('epoch');
		if (+input.protocol !== 2 || control.getInt('minimumClient') > 2) fail(426, 'Update required.');
		if (control.getBool('maintenance')) fail(503, 'JNote maintenance in progress.');
		if (action !== 'bootstrap' && input.epoch !== epoch)
			fail(409, 'Dataset epoch changed. Fresh setup required.');
		const vault = find(app, 'jnote_vaults', owner, epoch, 'owner', owner);
		if (action === 'bootstrap') {
			result = {
				protocol: 2,
				minimumClient: control.getInt('minimumClient'),
				epoch,
				vault: vault ? parse(vault, 'header') : null,
				checkpoint: control.getInt('sequence')
			};
			return;
		}
		if (action === 'changes') {
			const cursor = Number(input.cursor || 0);
			if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > control.getInt('sequence'))
				fail(410, 'Cursor reset required.');
			const rows = app.findRecordsByFilter(
				'jnote_changes',
				'owner={:owner} && epoch={:epoch} && sequence>{:cursor}',
				'sequence',
				100,
				0,
				{ owner, epoch, cursor }
			);
			result = {
				changes: rows.map((r) => ({
					sequence: r.getInt('sequence'),
					objectId: r.getString('objectId'),
					type: r.getString('type'),
					revision: r.getString('revision'),
					value: parse(r, 'value'),
					grant: parse(r, 'grant')
				})),
				cursor:
					rows.length === 100
						? rows[rows.length - 1].getInt('sequence')
						: control.getInt('sequence'),
				more: rows.length === 100
			};
			return;
		}
		if (action === 'content') {
			id(input.logicalId);
			if (!find(app, 'jnote', owner, epoch, 'logicalId', input.logicalId))
				fail(404, 'Note unavailable.');
			const page = Number(input.page || 1);
			if (!Number.isSafeInteger(page) || page < 1) fail(400, 'Invalid history page.');
			const filter =
				'owner={:owner} && epoch={:epoch} && logicalId={:logicalId}' +
				(input.revision ? ' && revision={:revision}' : '');
			const rows = app.findRecordsByFilter(
				'jnote_content',
				filter,
				'sequence',
				100,
				(page - 1) * 100,
				{ owner, epoch, logicalId: input.logicalId, revision: input.revision }
			);
			result = {
				items: rows.map((r) => ({
					logicalId: r.getString('logicalId'),
					revision: r.getString('revision'),
					parentRevision: r.getString('parentRevision'),
					generation: r.getInt('generation'),
					ciphertext: parse(r, 'ciphertext'),
					created: r.getString('created')
				})),
				more: rows.length === 100
			};
			return;
		}
		if (action === 'share-list') {
			const page = Number(input.page || 1);
			if (!Number.isSafeInteger(page) || page < 1) fail(400, 'Invalid page.');
			const rows = app.findRecordsByFilter(
				'jnote_public_shares',
				'owner={:owner} && epoch={:epoch}',
				'created',
				100,
				(page - 1) * 100,
				{ owner, epoch }
			);
			result = { items: rows.map(shareValue), more: rows.length === 100 };
			return;
		}
		id(input.operationId);
		const fingerprint = $security.sha256(JSON.stringify(canonical(input)));
		const previous = find(app, 'jnote_operations', owner, epoch, 'operationId', input.operationId);
		if (previous) {
			if (previous.getString('fingerprint') !== fingerprint)
				fail(409, 'Operation ID reused with different contents.');
			result = parse(previous, 'receipt');
			return;
		}
		if (action !== 'vault' && !vault) fail(409, 'Create vault first.');
		if (action === 'vault') {
			header(input.header, owner, epoch);
			if ((vault?.getString('revision') || '') !== (input.baseRevision || ''))
				fail(409, 'Vault revision conflict.');
			const record = vault || new Record(app.findCollectionByNameOrId('jnote_vaults'));
			record.load({ owner, epoch, revision: input.header.revision, header: input.header });
			app.save(record);
			result = { revision: input.header.revision };
		} else if (action === 'commit') {
			id(input.logicalId);
			id(input.revision);
			if (!['create', 'update', 'delete'].includes(input.action))
				fail(400, 'Invalid commit action.');
			let note = find(app, 'jnote', owner, epoch, 'logicalId', input.logicalId);
			if (
				(note?.getString('revision') || '') !== (input.baseRevision || '') ||
				note?.getBool('deleted')
			)
				fail(409, 'Note revision conflict.');
			if ((input.action === 'create') !== !note) fail(409, 'Note identity conflict.');
			if (input.action !== 'delete') {
				envelope(input.summary);
				if (input.summary.ct.length > 32768) fail(413, 'Summary too large.');
				envelope(input.ciphertext);
				if (input.generation !== 1) fail(400, 'Unsupported key generation.');
			}
			if (!note) {
				wrapper(input.wrapper, owner, epoch, input.logicalId, 'owner-vault', '');
				note = new Record(app.findCollectionByNameOrId('jnote'));
				note.load({ owner, epoch, logicalId: input.logicalId, generation: 1 });
				create(app, 'jnote_key_grants', {
					owner,
					epoch,
					logicalId: input.logicalId,
					generation: 1,
					scheme: 'aes256-gcm',
					recipientKind: 'owner-vault',
					recipientId: owner,
					wrapper: input.wrapper
				});
			}
			note.set('revision', input.revision);
			if (input.action === 'delete') {
				note.set('deleted', true);
				for (const share of app.findAllRecords(
					'jnote_public_shares',
					$dbx.hashExp({ owner, epoch, sourceNote: input.logicalId })
				)) {
					share.set('enabled', false);
					app.save(share);
				}
			} else {
				note.set('summary', input.summary);
				note.set('summaryRevision', input.revision);
				create(app, 'jnote_content', {
					owner,
					epoch,
					logicalId: input.logicalId,
					revision: input.revision,
					parentRevision: input.baseRevision || '',
					operationId: input.operationId,
					generation: 1,
					sequence: control.getInt('sequence') + 1,
					ciphertext: input.ciphertext
				});
			}
			app.save(note);
			const grant = find(app, 'jnote_key_grants', owner, epoch, 'logicalId', input.logicalId);
			const sequence = change(
				app,
				control,
				owner,
				epoch,
				input.logicalId,
				'note',
				input.revision,
				noteValue(note),
				parse(grant, 'wrapper')
			);
			result = {
				serverId: note.id,
				logicalId: input.logicalId,
				revision: input.revision,
				sequence
			};
		} else if (action === 'object') {
			id(input.objectId);
			id(input.revision);
			if (!['folder', 'placement', 'settings'].includes(input.objectType))
				fail(400, 'Invalid personal object type.');
			envelope(input.ciphertext);
			let record = find(app, 'jnote_private_objects', owner, epoch, 'objectId', input.objectId);
			if (
				(record?.getString('revision') || '') !== (input.baseRevision || '') ||
				(record && record.getString('objectType') !== input.objectType)
			)
				fail(409, 'Personal object revision conflict.');
			record = record || new Record(app.findCollectionByNameOrId('jnote_private_objects'));
			record.load({
				owner,
				epoch,
				objectId: input.objectId,
				objectType: input.objectType,
				revision: input.revision,
				ciphertext: input.ciphertext,
				deleted: !!input.deleted
			});
			app.save(record);
			result = {
				revision: input.revision,
				sequence: change(
					app,
					control,
					owner,
					epoch,
					input.objectId,
					'object',
					input.revision,
					objectValue(record)
				)
			};
		} else if (action === 'share') {
			if (!token.test(input.shareId || '')) fail(400, 'Invalid share identity.');
			let record = find(app, 'jnote_public_shares', owner, epoch, 'shareId', input.shareId);
			if (input.action === 'disable' && !record) fail(404, 'Publication unavailable.');
			if ((record?.getString('revision') || '') !== (input.baseRevision || ''))
				fail(409, 'Publication revision conflict.');
			if (!['publish', 'disable'].includes(input.action)) fail(400, 'Invalid publication action.');
			if (input.action === 'disable') {
				if (!record) fail(404, 'Publication unavailable.');
				record.set('enabled', false);
				id(input.revision);
				record.set('revision', input.revision);
			} else {
				const p = input.publication;
				if (
					p?.shareId !== input.shareId ||
					(record && p.sourceNote !== record.getString('sourceNote'))
				)
					fail(400, 'Invalid publication.');
				id(p.revision);
				id(p.sourceNote);
				id(p.sourceRevision);
				envelope(p.ciphertext);
				wrapper(p.ownerWrapper, owner, epoch, p.shareId, 'owner-vault', '');
				const source = find(app, 'jnote', owner, epoch, 'logicalId', p.sourceNote);
				if (
					!source ||
					source.getBool('deleted') ||
					!find(app, 'jnote_content', owner, epoch, 'revision', p.sourceRevision) ||
					find(app, 'jnote_content', owner, epoch, 'revision', p.sourceRevision).getString(
						'logicalId'
					) !== p.sourceNote
				)
					fail(404, 'Source revision unavailable.');
				if (
					p.expires &&
					(!Number.isFinite(Date.parse(p.expires)) || Date.parse(p.expires) <= Date.now())
				)
					fail(400, 'Expiry must be in the future.');
				record = record || new Record(app.findCollectionByNameOrId('jnote_public_shares'));
				record.load({ ...p, owner, epoch, enabled: true });
			}
			app.save(record);
			result = { revision: record.getString('revision') };
		} else fail(404, 'Unknown operation.');
		create(app, 'jnote_operations', {
			owner,
			epoch,
			operationId: input.operationId,
			fingerprint,
			receipt: result
		});
	});
	return e.json(200, result);
}
function publicRateLimit(e) {
	const client = $security.sha256(e.realIP());
	const window = Math.floor(Date.now() / 60000);
	let requests = 0;
	e.app.runInTransaction((app) => {
		app
			.db()
			.newQuery(
				'INSERT INTO jnote_public_limits (client, window, requests) VALUES ({:client}, {:window}, 1) ON CONFLICT (client) DO UPDATE SET window=excluded.window, requests=CASE WHEN jnote_public_limits.window=excluded.window THEN jnote_public_limits.requests+1 ELSE 1 END'
			)
			.bind({ client, window })
			.execute();
		const result = new DynamicModel({ requests: 0 });
		app
			.db()
			.newQuery('SELECT requests FROM jnote_public_limits WHERE client={:client}')
			.bind({ client })
			.one(result);
		requests = result.requests;
		app
			.db()
			.newQuery('DELETE FROM jnote_public_limits WHERE window < {:expired}')
			.bind({ expired: window - 2 })
			.execute();
	});
	if (requests > 60) fail(429, 'Too many publication requests. Try again later.');
}
function publicRead(e) {
	e.response.header().set('Cache-Control', 'no-store');
	publicRateLimit(e);
	const control = e.app.findFirstRecordByData('jnote_control', 'name', 'active');
	if (control.getBool('maintenance')) fail(404, 'Publication unavailable.');
	const shareId = e.request.pathValue('shareId');
	if (!token.test(shareId || '')) fail(404, 'Publication unavailable.');
	const rows = e.app.findRecordsByFilter(
		'jnote_public_shares',
		'shareId={:shareId} && epoch={:epoch} && enabled=true',
		'',
		1,
		0,
		{ shareId, epoch: control.getString('epoch') }
	);
	const r = rows[0];
	if (!r || (r.getString('expires') && Date.parse(r.getString('expires')) <= Date.now()))
		fail(404, 'Publication unavailable.');
	return e.json(200, { revision: r.getString('revision'), ciphertext: parse(r, 'ciphertext') });
}
module.exports = { handle, publicRead };
