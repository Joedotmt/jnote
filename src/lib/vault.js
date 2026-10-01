import {
	context,
	createKdf,
	deriveUnlockKey,
	generateKey,
	importKey,
	encryptBytes,
	decryptBytes,
	newId
} from './crypto.js';
export function wrapperContext(wrapper, scope) {
	return context(
		`wrapper:${wrapper.scheme}:${wrapper.recipientKind}:${wrapper.recipientId}`,
		scope,
		wrapper.keyId,
		wrapper.revision,
		wrapper.generation
	);
}
export async function wrapKey(
	key,
	wrappingKey,
	scope,
	{
		keyId,
		revision = '',
		generation = 1,
		recipientKind = 'owner-vault',
		recipientId = scope.owner
	} = {}
) {
	const wrapper = {
		v: 2,
		scheme: 'aes256-gcm',
		keyId,
		revision,
		generation,
		recipientKind,
		recipientId,
		scope: [scope.owner, scope.epoch]
	};
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
	try {
		wrapper.ciphertext = await encryptBytes(raw, wrappingKey, wrapperContext(wrapper, scope));
	} finally {
		raw.fill(0);
	}
	return wrapper;
}
export async function unwrapKey(wrapper, wrappingKey, scope, expected = {}) {
	if (
		wrapper?.v !== 2 ||
		wrapper.scheme !== 'aes256-gcm' ||
		!['owner-vault', 'password', 'device'].includes(wrapper.recipientKind) ||
		JSON.stringify(wrapper.scope) !== JSON.stringify([scope.owner, scope.epoch]) ||
		Object.entries(expected).some(([key, value]) => wrapper[key] !== value)
	) {
		throw new Error('Update/reset required: unsupported or misplaced key wrapper.');
	}
	const raw = await decryptBytes(wrapper.ciphertext, wrappingKey, wrapperContext(wrapper, scope));
	try {
		return await importKey(raw, true);
	} finally {
		raw.fill(0);
	}
}
export async function createVault(passphrase, scope) {
	const key = await generateKey();
	const header = await rewrapVault(key, passphrase, scope);
	return { key, header };
}
export async function rewrapVault(key, passphrase, scope) {
	const kdf = createKdf();
	const revision = newId();
	const unlockKey = await deriveUnlockKey(passphrase, kdf);
	const wrapper = await wrapKey(key, unlockKey, scope, {
		keyId: 'vault',
		revision,
		recipientKind: 'password'
	});
	return { format: 2, epoch: scope.epoch, revision, kdf, wrapper };
}
export async function unlockVault(passphrase, header, scope) {
	if (header?.format !== 2 || header.epoch !== scope.epoch)
		throw new Error('Update/reset required: wrong vault epoch.');
	return unwrapKey(header.wrapper, await deriveUnlockKey(passphrase, header.kdf), scope, {
		keyId: 'vault',
		revision: header.revision,
		recipientKind: 'password',
		recipientId: scope.owner,
		generation: 1
	});
}
export async function createNoteKey(vaultKey, scope, logicalId, generation = 1) {
	const key = await generateKey();
	return { key, wrapper: await wrapKey(key, vaultKey, scope, { keyId: logicalId, generation }) };
}
export function unwrapNoteKey(wrapper, vaultKey, scope, logicalId, generation = 1) {
	return unwrapKey(wrapper, vaultKey, scope, {
		keyId: logicalId,
		generation,
		recipientKind: 'owner-vault',
		recipientId: scope.owner,
		revision: ''
	});
}
export async function rememberVault(key, scope) {
	const deviceKey = await generateKey(false);
	const wrapper = await wrapKey(key, deviceKey, scope, { keyId: 'vault', recipientKind: 'device' });
	return { id: 'device', deviceKey, wrapper };
}
export function unlockRemembered(record, scope) {
	if (!record?.deviceKey || record.deviceKey.extractable)
		throw new Error('Protected device key unavailable.');
	return unwrapKey(record.wrapper, record.deviceKey, scope, {
		keyId: 'vault',
		recipientKind: 'device',
		recipientId: scope.owner,
		revision: '',
		generation: 1
	});
}
