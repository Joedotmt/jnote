import {
	context,
	encryptObject,
	decryptObject,
	generateKey,
	encodeBytes,
	decodeBytes,
	importKey,
	randomBytes,
	newId
} from './crypto.js';
import { wrapKey, unwrapKey } from './vault.js';
import { pocketbaseUrl } from './accounts.js';
export const sharePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export function publicationContext(shareId, revision) {
	return context(
		'public-publication',
		{ owner: 'public', epoch: 'publication-v2' },
		shareId,
		revision
	);
}
export async function createPublication(
	title,
	content,
	vaultKey,
	scope,
	sourceNote,
	sourceRevision,
	expires = ''
) {
	const shareId = encodeBytes(randomBytes());
	const key = await generateKey();
	const revision = newId();
	const ownerWrapper = await wrapKey(key, vaultKey, scope, { keyId: shareId });
	const ciphertext = await encryptObject(
		{ title, content },
		key,
		publicationContext(shareId, revision)
	);
	return {
		shareId,
		revision,
		sourceNote,
		sourceRevision,
		expires,
		enabled: true,
		ownerWrapper,
		ciphertext
	};
}
export async function publicationKey(publication, vaultKey, scope) {
	return unwrapKey(publication.ownerWrapper, vaultKey, scope, {
		keyId: publication.shareId,
		recipientKind: 'owner-vault',
		recipientId: scope.owner,
		revision: '',
		generation: 1
	});
}
export async function publicationLink(
	publication,
	vaultKey,
	scope,
	base = '',
	origin = globalThis.location?.origin
) {
	const key = await publicationKey(publication, vaultKey, scope);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
	try {
		return `${origin}${base}/s/${publication.shareId}#${encodeBytes(raw)}`;
	} finally {
		raw.fill(0);
	}
}
export async function republish(publication, title, content, vaultKey, scope, sourceRevision) {
	const revision = newId();
	return {
		...publication,
		revision,
		sourceRevision,
		ciphertext: await encryptObject(
			{ title, content },
			await publicationKey(publication, vaultKey, scope),
			publicationContext(publication.shareId, revision)
		)
	};
}
export async function readPublication(shareId, secret, fetcher = globalThis.fetch) {
	if (!sharePattern.test(shareId) || !sharePattern.test(secret || ''))
		throw new Error('Open the original full link, including its key.');
	const response = await fetcher(`${pocketbaseUrl()}/api/jnote/v2/public/${shareId}`, {
		cache: 'no-store',
		credentials: 'omit',
		referrerPolicy: 'no-referrer'
	});
	if (!response.ok)
		throw new Error(
			response.status === 404
				? 'This link is unavailable, expired, or disabled.'
				: 'Could not download this publication. Try again.'
		);
	const value = await response.json();
	const raw = decodeBytes(secret, 32);
	try {
		return await decryptObject(
			value.ciphertext,
			await importKey(raw),
			publicationContext(shareId, value.revision)
		);
	} catch {
		throw new Error('This link has an incorrect key or damaged publication.');
	} finally {
		raw.fill(0);
	}
}
