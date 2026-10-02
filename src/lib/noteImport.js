// Plaintext backups from both generations of JNote. No browser or vault access.
function record(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, label, fallback = '') {
	if (value === undefined) return fallback;
	if (typeof value !== 'string') throw new Error(`${label} must be text.`);
	return value;
}

function version(value, label) {
	if (!record(value) || typeof value.content !== 'string')
		throw new Error(`${label} is missing its note text.`);
	const result = {
		title: text(value.title, `${label} title`),
		content: value.content,
		created: typeof value.created === 'string' ? value.created : null
	};
	const bytes = (data) => new TextEncoder().encode(JSON.stringify(data)).length;
	// Leave room for the AES-GCM tag and base64 encoding within the server limits.
	if (bytes({ title: result.title }) > 24500 || bytes(result) > 2099900)
		throw new Error(`${label} is too large to sync. No notes have been imported.`);
	return result;
}

export function normalizeNoteImport(data) {
	if (
		!record(data) ||
		data.format !== 'jnote.plaintext-export' ||
		![1, 2].includes(data.formatVersion) ||
		!Array.isArray(data.notes)
	)
		throw new Error('Choose a JSON backup made by JNote’s Download all data/notes option.');

	const notes = new Map();
	for (const [index, value] of data.notes.entries()) {
		const label = `Note ${index + 1}`;
		if (!record(value) || typeof value.id !== 'string' || !value.id || notes.has(value.id))
			throw new Error(`${label} has a missing or duplicate identity.`);
		if (!Array.isArray(value.versions)) throw new Error(`${label} is missing its saved versions.`);
		if (value.deleted !== undefined && typeof value.deleted !== 'boolean')
			throw new Error(`${label} has an invalid deletion status.`);
		const ordered = value.versions.map((item, i) => ({
			...version(item, `${label}, version ${i + 1}`),
			revision: item.revision,
			index: i
		}));
		if (ordered.every((item) => Number.isFinite(Date.parse(item.created || ''))))
			ordered.sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || a.index - b.index);
		// New v2 exports identify the current head even when histories arrived out of order.
		const head = ordered.findIndex((item) => item.revision && item.revision === value.revision);
		if (head >= 0) ordered.push(...ordered.splice(head, 1));
		const versions = ordered.map(({ title, content, created }) => ({ title, content, created }));
		const title = text(value.title, `${label} title`);
		if (!versions.length) versions.push(version({ title, content: '' }, label));
		else if (versions.at(-1).title !== title)
			versions.push(version({ title, content: versions.at(-1).content }, label));
		notes.set(value.id, {
			folder: text(value.folder, `${label} folder`, 'Notes') || 'Notes',
			deleted: !!value.deleted,
			versions
		});
	}

	function addLocal(value, label, pending = false) {
		if (!record(value) || typeof value.noteId !== 'string' || !value.noteId)
			throw new Error(`${label} has no note identity.`);
		if (pending && !['create', 'update', 'delete'].includes(value.action))
			throw new Error(`${label} has an unknown action.`);
		let note = notes.get(value.noteId);
		if (pending && value.action === 'delete') {
			if (note) note.deleted = true;
			return;
		}
		const body = version(value, label);
		if (!note) {
			note = { folder: 'Notes', deleted: false, versions: [] };
			notes.set(value.noteId, note);
		}
		note.folder = text(value.folder, `${label} folder`, note.folder) || 'Notes';
		// Legacy folder-only pending writes exported empty title/content fields.
		if (pending && !body.title && !body.content && note.versions.length) return;
		const latest = note.versions.at(-1);
		if (!latest || latest.title !== body.title || latest.content !== body.content)
			note.versions.push(body);
	}

	if (data.formatVersion === 1 && data.localChanges !== undefined) {
		if (!record(data.localChanges)) throw new Error('The backup’s local changes are invalid.');
		for (const [field, pending] of [
			['pendingPushes', true],
			['drafts', false]
		]) {
			const values = data.localChanges[field] ?? [];
			if (!Array.isArray(values)) throw new Error(`The backup’s ${field} are invalid.`);
			values.forEach((value, i) => addLocal(value, `Local change ${i + 1}`, pending));
		}
	}
	if (data.formatVersion === 2 && data.drafts !== undefined) {
		if (!record(data.drafts)) throw new Error('The backup’s drafts are invalid.');
		for (const [noteId, value] of Object.entries(data.drafts)) {
			if (!record(value)) throw new Error('The backup contains an invalid draft.');
			addLocal({ ...value, noteId }, 'Unsaved note');
		}
	}
	const result = [...notes.values()];
	if (!result.length) throw new Error('This backup has no notes to import.');
	return {
		notes: result,
		activeCount: result.filter((note) => !note.deleted).length,
		deletedCount: result.filter((note) => note.deleted).length,
		versionCount: result.reduce((count, note) => count + note.versions.length, 0)
	};
}
