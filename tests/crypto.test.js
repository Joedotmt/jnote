import assert from 'node:assert/strict';
import test from 'node:test';
import {
	context,
	encryptObject,
	decryptObject,
	newId,
	validateEnvelope,
	generateKey,
	decodeBytes
} from '../src/lib/crypto.js';
import {
	createVault,
	unlockVault,
	rewrapVault,
	createNoteKey,
	unwrapNoteKey,
	rememberVault,
	unlockRemembered
} from '../src/lib/vault.js';
import {
	createPublication,
	publicationKey,
	publicationLink,
	republish,
	publicationContext,
	readPublication
} from '../src/lib/publicSharing.js';
const scope = { owner: 'owner-a', epoch: 'epoch-a' };
test('vault rejects wrong passwords, contexts, formats and tampering', async () => {
	const { key, header } = await createVault('correct passphrase', scope);
	const unlocked = await unlockVault('correct passphrase', header, scope);
	const aad = context('history', scope, newId(), newId());
	const encrypted = await encryptObject({ text: 'Καλημέρα 🌿' }, key, aad);
	assert.deepEqual(await decryptObject(encrypted, unlocked, aad), { text: 'Καλημέρα 🌿' });
	await assert.rejects(() => unlockVault('wrong', header, scope));
	await assert.rejects(() => unlockVault('correct passphrase', header, { ...scope, owner: 'b' }));
	await assert.rejects(() =>
		decryptObject({ ...encrypted, ct: encrypted.ct.slice(0, -2) + 'AA' }, key, aad)
	);
	for (const other of [
		context('summary', scope, aad[4], aad[5]),
		context('history', { ...scope, epoch: 'b' }, aad[4], aad[5]),
		context('history', scope, newId(), aad[5]),
		context('history', scope, aad[4], newId())
	])
		await assert.rejects(() => decryptObject(encrypted, key, other));
	assert.throws(() => validateEnvelope({ v: 1 }), /Update\/reset/);
	assert.throws(() => validateEnvelope('plaintext'), /Update\/reset/);
	assert.throws(() => decodeBytes('a'.repeat(43), 16));
});
test('all private purposes, key generations and owners authenticate independently', async () => {
	const key = await generateKey();
	const purposes = [
		'wrapper:password',
		'summary',
		'history',
		'draft',
		'outbox',
		'personal:folder',
		'personal:placement',
		'personal:settings',
		'public-publication'
	];
	for (const purpose of purposes) {
		const aad = context(purpose, scope, 'object', 'revision');
		const encrypted = await encryptObject({ secret: purpose }, key, aad);
		await assert.rejects(() =>
			decryptObject(
				encrypted,
				key,
				context(purpose, { ...scope, owner: 'other' }, 'object', 'revision')
			)
		);
		await assert.rejects(() =>
			decryptObject(encrypted, key, context(purpose, scope, 'object', 'revision', 2))
		);
		await assert.rejects(() =>
			decryptObject(encrypted, key, context(purpose + 'other', scope, 'object', 'revision'))
		);
	}
});
test('independent note keys, fresh nonces, and passphrase rewrap leave histories unchanged', async () => {
	const { key, header } = await createVault('old passphrase', scope);
	const logicalId = newId();
	const first = await createNoteKey(key, scope, logicalId);
	const second = await createNoteKey(key, scope, newId());
	const aad = context('history', scope, logicalId, newId());
	const encrypted = await encryptObject({ title: 'Private', content: 'Body' }, first.key, aad);
	assert.notEqual(
		encrypted.iv,
		(await encryptObject({ title: 'Private', content: 'Body' }, first.key, aad)).iv
	);
	await assert.rejects(() => decryptObject(encrypted, second.key, aad));
	const newHeader = await rewrapVault(key, 'new passphrase', scope);
	assert.notEqual(header.kdf.salt, newHeader.kdf.salt);
	const newKey = await unlockVault('new passphrase', newHeader, scope);
	const noteKey = await unwrapNoteKey(first.wrapper, newKey, scope, logicalId);
	assert.equal((await decryptObject(encrypted, noteKey, aad)).content, 'Body');
	await assert.rejects(() => unlockVault('old passphrase', newHeader, scope));
	await assert.rejects(() =>
		unwrapNoteKey({ ...first.wrapper, scheme: 'recipient-public-key' }, newKey, scope, logicalId)
	);
});
test('remembered vault uses a nonextractable device key and remains scoped', async () => {
	const { key } = await createVault('passphrase', scope);
	const remembered = await rememberVault(key, scope);
	assert.equal(remembered.deviceKey.extractable, false);
	await assert.rejects(() => crypto.subtle.exportKey('raw', remembered.deviceKey));
	const unlocked = await unlockRemembered(structuredClone(remembered), scope);
	const aad = context('draft', scope, newId());
	assert.deepEqual(await decryptObject(await encryptObject({ a: 1 }, key, aad), unlocked, aad), {
		a: 1
	});
	await assert.rejects(() => unlockRemembered(remembered, { ...scope, epoch: 'other' }));
});
test('public publications contain only committed text and use independent keys', async () => {
	const { key } = await createVault('passphrase', scope);
	const p = await createPublication('<script>', 'Text', key, scope, newId(), newId());
	const link = await publicationLink(p, key, scope, '/jnote', 'https://notes.example');
	assert.match(link, /^https:\/\/notes.example\/jnote\/s\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
	const secret = link.split('#')[1];
	let request;
	const fetcher = async (url, options) => {
		request = { url, options };
		return { ok: true, json: async () => ({ revision: p.revision, ciphertext: p.ciphertext }) };
	};
	assert.deepEqual(await readPublication(p.shareId, secret, fetcher), {
		title: '<script>',
		content: 'Text'
	});
	assert.equal(request.url.includes(secret), false);
	assert.equal(request.options.cache, 'no-store');
	await assert.rejects(() =>
		decryptObject(p.ciphertext, key, publicationContext(p.shareId, p.revision))
	);
	const updated = await republish(p, 'new', 'new body', key, scope, newId());
	assert.notEqual(updated.ciphertext.iv, p.ciphertext.iv);
	assert.equal(
		(
			await decryptObject(
				updated.ciphertext,
				await publicationKey(p, key, scope),
				publicationContext(p.shareId, updated.revision)
			)
		).title,
		'new'
	);
	await assert.rejects(() => readPublication(p.shareId, '', fetcher));
});
test('large note payloads round-trip without argument-stack limits', async () => {
	const key = await generateKey(),
		aad = context('history', scope, newId(), newId());
	const content = '🌿 large body '.repeat(50000);
	assert.equal(
		(await decryptObject(await encryptObject({ content }, key, aad), key, aad)).content,
		content
	);
});
