import { PROTOCOL, context, decryptObject, newId } from './crypto.js';
export class JNoteApi {
	constructor(pb) {
		this.pb = pb;
	}
	send(path, body = {}, method = 'POST') {
		return this.pb.send(`/api/jnote/v2/${path}`, {
			method,
			body: method === 'GET' ? undefined : { protocol: PROTOCOL, ...body },
			query: method === 'GET' ? { protocol: PROTOCOL, ...body } : undefined,
			requestKey: null
		});
	}
	bootstrap() {
		return this.send('bootstrap', {}, 'GET');
	}
	changes(epoch, cursor) {
		return this.send('changes', { epoch, cursor }, 'GET');
	}
	content(epoch, logicalId, revision = '', page = 1) {
		return this.send('content', { epoch, logicalId, revision, page }, 'GET');
	}
}
// Durable requests are immutable; operation receipts make ambiguous network failures safe.
export async function flushOutbox(
	db,
	key,
	api,
	{ onReceipt = () => {}, onConflict = () => {}, signal } = {}
) {
	const holder = newId();
	if (!(await db.acquireLease(holder))) return false;
	const renewal = setInterval(() => db.acquireLease(holder).catch(() => {}), 5000);
	try {
		const blocked = new Set();
		for (const item of (await db.all('outbox')).sort((a, b) => a.order - b.order)) {
			if (signal?.aborted) break;
			if (item.conflict || blocked.has(item.objectId)) {
				blocked.add(item.objectId);
				continue;
			}
			const payload = await decryptObject(
				item.ciphertext,
				key,
				context('outbox', db.scope, item.id)
			);
			try {
				const receipt = await api.send(item.endpoint, payload);
				await db.transaction(['outbox', 'notes', 'meta'], 'readwrite', async (s) => {
					await s.outbox.delete(item.id);
					if (receipt.serverId && item.endpoint === 'commit') {
						const note = await s.notes.get(item.objectId);
						if (note) await s.notes.put({ ...note, serverId: receipt.serverId });
					}
					await s.meta.put({ id: `receipt:${item.id}`, value: receipt });
				});
				await onReceipt(item, receipt);
			} catch (error) {
				if (error.status === 409) {
					await db.put('outbox', { ...item, conflict: true });
					blocked.add(item.objectId);
					await onConflict(item, error);
				} else throw error;
			}
		}
		return true;
	} finally {
		clearInterval(renewal);
		await db.releaseLease(holder);
	}
}
