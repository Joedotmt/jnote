// v2 only. All encrypted values authenticate an explicit, canonical object context.
export const FORMAT = 'jnote.v2';
export const PROTOCOL = 2;
export const KDF_ITERATIONS = 310000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function assertWebCryptoAvailable() {
	if (!globalThis.crypto?.subtle) throw new Error('Web Crypto requires HTTPS or localhost.');
}
export function randomBytes(length = 32) {
	assertWebCryptoAvailable();
	return crypto.getRandomValues(new Uint8Array(length));
}
export function newId() {
	return crypto.randomUUID();
}
export function encodeBytes(bytes) {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 32768)
		binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBytes(value, length) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
		throw new Error('Invalid encoded bytes.');
	const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
		c.charCodeAt(0)
	);
	if ((length && bytes.length !== length) || encodeBytes(bytes) !== value)
		throw new Error('Invalid encoded length.');
	return bytes;
}
export function context(purpose, scope, objectId, revision = '', generation = 1) {
	if (
		!purpose ||
		!scope?.owner ||
		!scope?.epoch ||
		!objectId ||
		!Number.isSafeInteger(generation) ||
		generation < 1
	) {
		throw new Error('Missing authenticated object identity.');
	}
	return [FORMAT, purpose, scope.owner, scope.epoch, objectId, revision, generation];
}
export async function importKey(bytes, extractable = false) {
	if (bytes.length !== 32) throw new Error('AES-256 key required.');
	return crypto.subtle.importKey('raw', bytes, 'AES-GCM', extractable, ['encrypt', 'decrypt']);
}
export async function generateKey(extractable = true) {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
		'encrypt',
		'decrypt'
	]);
}
export function createKdf() {
	return {
		name: 'PBKDF2',
		hash: 'SHA-256',
		iterations: KDF_ITERATIONS,
		salt: encodeBytes(randomBytes(16))
	};
}
export async function deriveUnlockKey(passphrase, kdf) {
	if (kdf?.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== KDF_ITERATIONS) {
		throw new Error('Update/reset required: unsupported key derivation.');
	}
	const salt = decodeBytes(kdf.salt, 16);
	const key = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt },
		key,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}
export function validateEnvelope(value) {
	if (value?.v !== 2 || value.alg !== 'A256GCM')
		throw new Error('Update/reset required: unsupported encrypted format.');
	decodeBytes(value.iv, 12);
	if (decodeBytes(value.ct).length < 16) throw new Error('Invalid ciphertext.');
	return value;
}
export async function encryptBytes(bytes, key, aad) {
	const iv = randomBytes(12);
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(aad)) },
		key,
		bytes
	);
	return { v: 2, alg: 'A256GCM', iv: encodeBytes(iv), ct: encodeBytes(new Uint8Array(ct)) };
}
export async function decryptBytes(value, key, aad) {
	validateEnvelope(value);
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: decodeBytes(value.iv, 12),
				additionalData: encoder.encode(JSON.stringify(aad))
			},
			key,
			decodeBytes(value.ct)
		)
	);
}
export function encryptObject(value, key, aad) {
	return encryptBytes(encoder.encode(JSON.stringify(value)), key, aad);
}
export async function decryptObject(value, key, aad) {
	const bytes = await decryptBytes(value, key, aad);
	try {
		return JSON.parse(decoder.decode(bytes));
	} catch {
		throw new Error('Authenticated payload is malformed.');
	}
}
