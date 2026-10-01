// No browser access until openLocalDb(). Each database is a single owner/epoch namespace.
const STORES = [
	'meta',
	'notes',
	'contents',
	'grants',
	'drafts',
	'outbox',
	'objects',
	'shares',
	'protected',
	'leases'
];
function request(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
export async function openLocalDb(owner, epoch, factory = globalThis.indexedDB) {
	if (!owner || !epoch || !factory) throw new Error('Encrypted local storage is unavailable.');
	const req = factory.open(`jnote.v2.${encodeURIComponent(owner)}.${encodeURIComponent(epoch)}`, 1);
	req.onupgradeneeded = () =>
		STORES.forEach((name) => req.result.createObjectStore(name, { keyPath: 'id' }));
	const db = await request(req);
	db.onversionchange = () => db.close();
	return new LocalDb(db, { owner, epoch });
}
export class LocalDb {
	constructor(db, scope) {
		this.db = db;
		this.scope = scope;
	}
	close() {
		this.db.close();
	}
	async transaction(names, mode, work) {
		const tx = this.db.transaction(names, mode);
		const done = new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error || new Error('Local transaction aborted.'));
			tx.onerror = () => {}; // abort reports the failure, including quota errors
		});
		const stores = Object.fromEntries(
			names.map((name) => [
				name,
				{
					get: (id) => request(tx.objectStore(name).get(id)),
					all: () => request(tx.objectStore(name).getAll()),
					put: (value) => request(tx.objectStore(name).put(value)),
					delete: (id) => request(tx.objectStore(name).delete(id)),
					clear: () => request(tx.objectStore(name).clear())
				}
			])
		);
		try {
			const result = await work(stores);
			await done;
			return result;
		} catch (error) {
			try {
				tx.abort();
			} catch {}
			await done.catch(() => {});
			throw error;
		}
	}
	get(store, id) {
		return this.transaction([store], 'readonly', (s) => s[store].get(id));
	}
	all(store) {
		return this.transaction([store], 'readonly', (s) => s[store].all());
	}
	put(store, value) {
		return this.transaction([store], 'readwrite', (s) => s[store].put(value));
	}
	delete(store, id) {
		return this.transaction([store], 'readwrite', (s) => s[store].delete(id));
	}
	// Encryption occurs before this transaction: no async crypto while IDB is active.
	commit({ note, content, grant, operation, draftSequence }) {
		return this.transaction(
			['notes', 'contents', 'grants', 'drafts', 'outbox', 'meta'],
			'readwrite',
			async (s) => {
				const counter = (await s.meta.get('order'))?.value || 0;
				await s.meta.put({ id: 'order', value: counter + 1 });
				await s.outbox.put({ ...operation, order: counter + 1 });
				if (note) await s.notes.put(note);
				if (content) await s.contents.put(content);
				if (grant) await s.grants.put(grant);
				if (note && draftSequence !== undefined) {
					const draft = await s.drafts.get(note.id);
					if (!draft || draft.sequence <= draftSequence) await s.drafts.delete(note.id);
				}
			}
		);
	}
	saveDraft(record) {
		return this.transaction(['drafts'], 'readwrite', async (s) => {
			const existing = await s.drafts.get(record.id);
			if (!existing || existing.sequence < record.sequence) await s.drafts.put(record);
		});
	}
	async applyChanges(page) {
		return this.transaction(['notes', 'grants', 'objects', 'meta'], 'readwrite', async (s) => {
			if (((await s.meta.get('cursor'))?.value || 0) > page.cursor) return;
			for (const change of page.changes) {
				const store =
					change.type === 'note' ? 'notes' : change.type === 'object' ? 'objects' : null;
				if (!store) continue;
				await s[store].put({ ...change.value, id: change.objectId });
				if (change.grant) await s.grants.put({ id: change.objectId, wrapper: change.grant });
			}
			await s.meta.put({ id: 'cursor', value: page.cursor });
		});
	}
	async acquireLease(holder, duration = 15000, time = Date.now()) {
		return this.transaction(['leases'], 'readwrite', async (s) => {
			const lease = await s.leases.get('sync');
			if (lease && lease.holder !== holder && lease.until > time) return false;
			await s.leases.put({ id: 'sync', holder, until: time + duration });
			return true;
		});
	}
	releaseLease(holder) {
		return this.transaction(['leases'], 'readwrite', async (s) => {
			if ((await s.leases.get('sync'))?.holder === holder) await s.leases.delete('sync');
		});
	}
}
export const LEGACY_KEYS = [
	'jnote.unsavedDrafts.v1',
	'jnote.localNotes.v1',
	'jnote.pendingPushes.v1',
	'jnote.encryptionMetadata.v1',
	'jnote.rememberedDeviceKey.v1'
];
export function retireLegacyStores(storage, owner) {
	for (const key of LEGACY_KEYS) {
		storage.removeItem(key);
		storage.removeItem(`${key}.${owner}`);
	}
}
