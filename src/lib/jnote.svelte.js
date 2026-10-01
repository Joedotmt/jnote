import PocketBase, { LocalAuthStore } from 'pocketbase';
import { SvelteSet } from 'svelte/reactivity';
import { searchNotes } from './search.js';
import {
	accountsHandoffProblem,
	accountsLoginUrl,
	accountsOrigin,
	isAccountsBridgeAvailable,
	isAccountsHandoffAvailable,
	pocketbaseUrl,
	takeAccountsHandoffToken,
	whenAccountsScriptSettled
} from './accounts.js';
import { context, encryptObject, decryptObject, newId } from './crypto.js';
import {
	createVault,
	unlockVault,
	rewrapVault,
	createNoteKey,
	unwrapNoteKey,
	rememberVault,
	unlockRemembered
} from './vault.js';
import { openLocalDb, retireLegacyStores } from './localDb.js';
import { JNoteApi, flushOutbox } from './sync.js';
import { createPublication, publicationLink, republish } from './publicSharing.js';

const CUSTOM_CSS_STORAGE_KEY = 'jnote.customCss.v1';
function now() {
	return new Date().toISOString();
}
function makeLocalNoteId() {
	return newId();
}

function getContextMenuPosition(event) {
	const clientX = Number(event?.clientX) || 0;
	const clientY = Number(event?.clientY) || 0;
	if (clientX || clientY) return { x: clientX, y: clientY };
	const rect = event?.currentTarget?.getBoundingClientRect?.();
	if (!rect) return { x: 8, y: 8 };
	return {
		x: Math.round(rect.left + Math.min(28, rect.width / 2)),
		y: Math.round(rect.top + Math.min(rect.height, 36))
	};
}

export function buildFolderList(notes = [], clientOnlyFolders = []) {
	const folders = new Set(clientOnlyFolders);
	notes.forEach((note) => {
		if (note?.folder) folders.add(note.folder);
	});
	folders.delete('Notes');
	return ['Notes', ...folders].sort((a, b) =>
		a === 'Notes' ? -1 : b === 'Notes' ? 1 : a.localeCompare(b)
	);
}

export class JNoteState {
	notes = $state([]);
	currentFolder = $state('Notes');
	currentNoteId = $state(null);
	selectedNoteIds = new SvelteSet();
	selectionAnchorId = $state(null);
	focusedNoteId = $state(null);
	renamingNoteId = $state(null);
	renameDraftValue = $state('');
	creatingFolder = $state(false);
	newFolderDraftValue = $state('');
	renamingFolder = $state(null);
	folderRenameDraftValue = $state('');
	folderActionBusy = $state(false);
	clientOnlyFolders = new SvelteSet();
	draggedNoteIds = $state([]);
	dragOverFolder = $state(null);
	drafts = $state({});
	localNotes = $state({});
	pendingPushes = $state({});
	activePushes = new SvelteSet();
	hasPushError = $state(false);
	isKeyMigrationRunning = $state(false);

	loadState = $state('idle');
	noteLoadState = $state('idle');
	noteLoadError = $state('');
	unlockMode = $state('loading');
	encryptionError = $state('');
	accountError = $state('');
	// How the session gets back here from the account site:
	// 'bridge'      - read through its iframe, same-site origins only
	// 'redirect'    - handed over in the URL fragment, any origin it serves
	// 'unsupported' - the account site does not serve this origin, so sign-in cannot work
	authMode = $state('unsupported');
	unlockBusy = $state(false);

	searchOpen = $state(false);
	searchQuery = $state('');
	foldersOpen = $state(false);
	detailOpen = $state(false);
	isMobileViewport = $state(false);
	folderModal = $state({
		open: false,
		mode: 'move',
		noteId: null,
		noteIds: [],
		returnFocusNoteId: null
	});
	contextMenu = $state({
		open: false,
		type: null,
		surface: null,
		noteId: null,
		folder: null,
		x: 0,
		y: 0
	});
	settingsOpen = $state(false);
	customCssOpen = $state(false);
	changeKeyOpen = $state(false);
	customCss = $state('');
	exportBusy = $state(false);
	changeKeyBusy = $state(false);
	changeKeyStatus = $state('');
	changeKeyError = $state('');

	editorBaseline = $state({ noteId: null, title: '', content: '' });
	editorRevision = $state(0);

	folders = $derived.by(() => buildFolderList(this.notes, this.clientOnlyFolders));

	isSearching = $derived(this.searchQuery.trim().length > 0);
	// The one list the pane renders; see computeVisibleNotes for what goes in it.
	visibleNotes = $derived.by(() => this.computeVisibleNotes());
	currentNote = $derived(this.notes.find((note) => note.id === this.currentNoteId) ?? null);
	selectedCount = $derived(this.getSelectedNoteIds().length);

	syncStatus = $derived.by(() => {
		if (this.persistenceError) return { idle: false, error: true, text: this.persistenceError };
		if (this.conflicts?.length)
			return {
				idle: false,
				error: true,
				text: `${this.conflicts.length} conflicts need attention`
			};
		if (this.localBusy)
			return { idle: false, error: false, text: 'Saving encrypted changes on this device…' };
		const count = Object.keys(this.pendingPushes).length;
		if (this.cloudState !== 'online')
			return {
				idle: false,
				error: false,
				text: `${this.cloudState}: ${count ? 'changes saved on this device' : 'local vault'}`
			};
		if (this.syncRunning || count)
			return {
				idle: false,
				error: this.hasPushError,
				text: `${count} changes waiting for cloud sync`
			};
		return { idle: true, error: false, text: 'All changes synced' };
	});

	client = null;
	currentUser = null;
	encryptionState = null;
	db = null;
	api = null;
	scope = null;
	vaultHeader = null;
	noteKeys = new Map();
	objectValues = new Map();
	localWork = Promise.resolve();
	draftSequences = new Map();
	manualLock = false;
	cloudValidated = false;
	syncController = null;
	syncTimer = null;
	syncRunning = $state(false);
	sessionGeneration = 0;
	activeDirectMoves = new Set();
	activeDirectMoveNoteIds = new Set();
	cloudState = $state('checking');
	persistenceError = $state('');
	hydrationState = $state('idle');
	conflicts = $state([]);
	shares = $state([]);
	sharingOpen = $state(false);
	sharingBusy = $state(false);
	sharingError = $state('');
	sharingNoteId = $state(null);
	localBusy = $state(0);

	noteLoadRequest = 0;
	initialized = false;
	accountReady = false;

	get pb() {
		if (!this.client) {
			// Under the bridge the account site can be re-asked at any moment, so this app
			// holds the session in memory only. A handed-over session cannot be re-asked for
			// without another round trip, so it persists here instead.
			const AccountStore = this.authMode === 'bridge' ? window.JoeAccounts?.AuthStore : null;
			if (AccountStore) this.client = new PocketBase(pocketbaseUrl(), new AccountStore());
			else this.client = new PocketBase(pocketbaseUrl(), new LocalAuthStore());
		}
		return this.client;
	}

	get signInUrl() {
		return accountsLoginUrl(globalThis.window?.location?.href || '') || accountsOrigin();
	}

	/**
	 * Takes the session the account site put in the URL fragment and turns it into a
	 * working login. The token arrives alone, so the record comes from a refresh, which
	 * also proves to this app that the token is one the server still accepts.
	 */
	async consumeAccountHandoff() {
		const token = takeAccountsHandoffToken();
		if (!token) {
			// A token that arrived but was refused deserves a message; a plain first visit
			// has nothing to say.
			const problem = accountsHandoffProblem();
			if (problem) {
				console.warn(`The account site's session was refused (${problem}).`);
				this.accountError =
					problem === 'expired'
						? 'That sign-in had already expired by the time it arrived. Try again.'
						: `The session from ${accountsOrigin()} was not in a form this app accepts (${problem}).`;
			}
			return false;
		}

		this.pb.authStore.save(token, null);
		try {
			await this.pb.collection('users').authRefresh();
			return true;
		} catch (error) {
			console.warn('The handed-over session was not accepted:');
			this.pb.authStore.clear();
			this.accountError = 'That sign-in did not carry through. Try signing in again.';
			return false;
		}
	}

	async getAccountSession() {
		if (this.authMode !== 'bridge') {
			// Same shape check the bridge applies, so a handed-over token is held to it too.
			const store = this.pb.authStore;
			if (!store.isValid || !store.record?.id || store.record.collectionName !== 'users')
				return null;
			return { token: store.token, record: store.record };
		}
		return this.getBridgeSession();
	}

	async getBridgeSession() {
		const accounts = window.JoeAccounts;
		if (!accounts?.AuthStore || typeof accounts.getSession !== 'function') {
			throw new Error('The account service is unavailable.');
		}

		const session = await accounts.getSession();
		if (
			session !== null &&
			(!session?.token || !session?.record?.id || session.record.collectionName !== 'users')
		) {
			throw new Error('The account service returned an invalid session.');
		}
		return session;
	}

	async refreshAccountSession() {
		if (!this.accountReady) return 'unchanged';
		// Only the bridge has an external session that can change underneath this tab.
		if (this.authMode !== 'bridge') return 'unchanged';

		let session;
		try {
			session = await this.getAccountSession();
			this.accountError = '';
		} catch (error) {
			console.warn('Could not check the account session:');
			this.accountError = 'Could not reach the account service. Try again when it is available.';
			return 'unchanged';
		}

		const nextUserId = session?.record?.id || '';
		const currentUserId = this.getCurrentUserId();
		if (nextUserId === currentUserId) {
			if (session && session.token !== this.pb.authStore.token) {
				this.pb.authStore.save(session.token, session.record);
			}
			return 'unchanged';
		}

		if (this.localBusy || this.persistenceError) return 'deferred';

		if (this.encryptionState) {
			try {
				await this.localWork;
			} catch (error) {
				console.warn('Could not save encrypted local notes before switching accounts:');
				this.accountError = 'Could not save local notes before switching accounts.';
				return 'deferred';
			}
		}

		await this.lock();
		this.unlockMode = 'auth-required';
		if (session) this.pb.authStore.save(session.token, session.record);
		else this.pb.authStore.clear();
		return 'changed';
	}

	getCurrentUserId() {
		return this.currentUser?.id || this.pb.authStore.record?.id || '';
	}

	async loadCurrentUser() {
		const result = await this.pb.collection('users').authRefresh();
		this.currentUser = result.record;
		return this.currentUser;
	}

	readCustomCss() {
		try {
			return localStorage.getItem(CUSTOM_CSS_STORAGE_KEY) || '';
		} catch (error) {
			console.warn('Could not read custom CSS:');
			return '';
		}
	}

	saveCustomCss(css) {
		try {
			if (css) localStorage.setItem(CUSTOM_CSS_STORAGE_KEY, css);
			else localStorage.removeItem(CUSTOM_CSS_STORAGE_KEY);
		} catch (error) {
			console.warn('Could not save custom CSS:');
		}

		this.customCss = css;
		this.applyCustomCss(css);
		this.enqueueLocal(() => this.saveSetting({ customCss: css }));
	}

	applyCustomCss(css = this.customCss) {
		let customCssElement = document.getElementById('custom-css');
		if (!customCssElement) {
			customCssElement = document.createElement('style');
			customCssElement.id = 'custom-css';
			document.head.appendChild(customCssElement);
		}
		customCssElement.textContent = css;
	}

	getDraft(noteId) {
		return this.drafts[noteId] || null;
	}

	hasDraft(noteId) {
		return Boolean(this.getDraft(noteId));
	}

	saveDraft(noteId, title, content, folder = 'Notes') {
		this.drafts[noteId] = { title, content, folder, updatedAt: now() };
		this.persistDrafts();
	}

	clearDraft(noteId) {
		if (!this.drafts[noteId]) return;
		delete this.drafts[noteId];
		this.persistDrafts();
	}

	moveDraft(fromNoteId, toNoteId) {
		if (!this.drafts[fromNoteId]) return;
		this.drafts[toNoteId] = this.drafts[fromNoteId];
		delete this.drafts[fromNoteId];
		this.persistDrafts();
	}

	upsertLocalNote(note) {
		if (!note?.isLocalOnly) return;
		this.localNotes[note.id] = {
			id: note.id,
			title: note.title || '',
			content: note.content || '',
			folder: note.folder || 'Notes',
			updated: note.updated || now(),
			hasContent: true,
			isLocalOnly: true
		};
		this.persistLocalNotes();
	}

	removeLocalNote(noteId) {
		if (!this.localNotes[noteId]) return;
		delete this.localNotes[noteId];
		this.persistLocalNotes();
	}

	hasUnfinishedPushes() {
		return Object.keys(this.pendingPushes).length > 0 || this.activePushes.size > 0;
	}

	async signOut() {
		// Clear this app's copy first, then let the account site clear its own: signing out
		// of one but not the other just signs you straight back in.
		await this.lock();
		this.pb.authStore.clear();
		window.location.href = window.JoeAccounts.logoutUrl(window.location.href);
	}

	computeVisibleNotes() {
		if (this.searchQuery.trim()) {
			return searchNotes(this.notes, this.searchQuery, (note) => ({
				title: this.getDisplayTitle(note),
				folder: note.folder,
				content: this.getDraft(note.id)?.content ?? note.content ?? ''
			}));
		}
		return this.notes.filter((note) => note.folder === this.currentFolder);
	}

	getVisibleNoteIds() {
		// The same list the pane renders, so keyboard navigation and select-all follow a
		// search's results rather than the folder behind them.
		return this.computeVisibleNotes().map((note) => note.id);
	}

	openSearch() {
		this.closeContextMenu();
		this.searchOpen = true;
	}

	setSearchQuery(query) {
		this.searchQuery = query;
	}

	closeSearch() {
		this.searchOpen = false;
		this.searchQuery = '';
	}

	getSelectedNoteIds() {
		const selected = this.selectedNoteIds;
		return this.getVisibleNoteIds().filter((noteId) => selected.has(noteId));
	}

	isNoteSelected(noteId) {
		return this.selectedNoteIds.has(noteId);
	}

	getActionNoteIds(originNoteId = null) {
		const selectedIds = this.getSelectedNoteIds();
		if (originNoteId && selectedIds.includes(originNoteId)) return selectedIds;
		return originNoteId && this.notes.some((note) => note.id === originNoteId)
			? [originNoteId]
			: selectedIds;
	}

	replaceNoteSelection(noteIds, anchorId = null, focusedId = null) {
		this.selectedNoteIds.clear();
		noteIds.forEach((noteId) => this.selectedNoteIds.add(noteId));
		this.selectionAnchorId = anchorId;
		this.focusedNoteId = focusedId;
	}

	async selectAllVisibleNotes() {
		const visibleIds = this.getVisibleNoteIds();
		if (!visibleIds.length) return false;
		this.selectedNoteIds.clear();
		visibleIds.forEach((noteId) => this.selectedNoteIds.add(noteId));
		const currentId = visibleIds.includes(this.currentNoteId)
			? this.currentNoteId
			: this.focusedNoteId && visibleIds.includes(this.focusedNoteId)
				? this.focusedNoteId
				: visibleIds[0];
		if (!visibleIds.includes(this.selectionAnchorId)) this.selectionAnchorId = visibleIds[0];
		this.focusedNoteId = currentId;
		this.cancelRename();
		await this.openNote(currentId);
		return true;
	}

	cancelRename() {
		this.renamingNoteId = null;
		this.renameDraftValue = '';
	}

	resetOpenNote() {
		this.noteLoadRequest += 1;
		this.currentNoteId = null;
		this.noteLoadState = 'idle';
		this.noteLoadError = '';
		this.editorBaseline = { noteId: null, title: '', content: '' };
		this.editorRevision += 1;
	}

	clearNoteSelection(options = {}) {
		const closeDetail = options.closeDetail ?? (globalThis.window?.innerWidth ?? 1024) <= 768;
		this.selectedNoteIds.clear();
		this.selectionAnchorId = null;
		this.focusedNoteId = null;
		this.cancelRename();
		this.clearNoteDrag();
		this.resetOpenNote();
		this.closeContextMenu();
		if (closeDetail) this.detailOpen = false;
	}

	focusNote(noteId) {
		if (this.notes.some((note) => note.id === noteId)) this.focusedNoteId = noteId;
	}

	resolveFolderName(folder) {
		const requested = String(folder ?? '').trim();
		if (!requested || requested.toLocaleLowerCase() === 'notes') return 'Notes';
		return (
			buildFolderList(this.notes, this.clientOnlyFolders).find(
				(existing) => existing.toLocaleLowerCase() === requested.toLocaleLowerCase()
			) || requested
		);
	}

	getSuggestedFolderName() {
		const names = new Set(
			buildFolderList(this.notes, this.clientOnlyFolders).map((folder) =>
				folder.toLocaleLowerCase()
			)
		);
		let index = 1;
		let candidate = 'New folder';
		while (names.has(candidate.toLocaleLowerCase())) {
			index += 1;
			candidate = `New folder (${index})`;
		}
		return candidate;
	}

	beginCreateFolder() {
		if (this.folderActionBusy || this.isKeyMigrationRunning || this.changeKeyBusy) return false;
		this.cancelFolderRename();
		this.newFolderDraftValue = this.getSuggestedFolderName();
		this.creatingFolder = true;
		this.closeContextMenu();
		if ((globalThis.window?.innerWidth ?? 1024) <= 768) {
			this.foldersOpen = true;
			this.detailOpen = false;
		}
		return true;
	}

	setNewFolderDraft(value) {
		if (!this.creatingFolder) return;
		this.newFolderDraftValue = String(value ?? '');
	}

	commitCreateFolder(value = this.newFolderDraftValue, options = {}) {
		if (!this.creatingFolder) return null;
		this.creatingFolder = false;
		this.newFolderDraftValue = '';
		return this.createClientFolder(value, options);
	}

	cancelCreateFolder() {
		this.creatingFolder = false;
		this.newFolderDraftValue = '';
	}

	createClientFolder(folder, options = {}) {
		const requested = String(folder ?? '').trim();
		if (!requested) return null;
		const resolved = this.resolveFolderName(requested);
		if (resolved !== 'Notes' && !this.notes.some((note) => note.folder === resolved)) {
			this.clientOnlyFolders.add(resolved);
		}
		if (resolved !== 'Notes') this.persistFolder(resolved);
		if (options.select !== false) this.selectFolder(resolved);
		return resolved;
	}

	canManageFolder(folder) {
		if (
			this.folderActionBusy ||
			this.isKeyMigrationRunning ||
			this.changeKeyBusy ||
			this.activeDirectMoves.size > 0
		) {
			return false;
		}
		const resolved = this.resolveFolderName(folder);
		return (
			resolved !== 'Notes' && buildFolderList(this.notes, this.clientOnlyFolders).includes(resolved)
		);
	}

	beginRenameFolder(folder) {
		const resolved = this.resolveFolderName(folder);
		if (!this.canManageFolder(resolved)) return false;
		this.cancelCreateFolder();
		this.renamingFolder = resolved;
		this.folderRenameDraftValue = resolved;
		this.closeContextMenu();
		return true;
	}

	setFolderRenameDraft(value) {
		if (!this.renamingFolder) return;
		this.folderRenameDraftValue = String(value ?? '');
	}

	cancelFolderRename() {
		this.renamingFolder = null;
		this.folderRenameDraftValue = '';
	}

	async commitFolderRename(value = this.folderRenameDraftValue) {
		const sourceFolder = this.renamingFolder;
		const requestedFolder = String(value ?? '').trim();
		this.cancelFolderRename();
		if (!sourceFolder || !this.canManageFolder(sourceFolder)) return false;
		if (!requestedFolder || requestedFolder === sourceFolder) return Boolean(requestedFolder);
		if (requestedFolder.toLocaleLowerCase() === 'notes') {
			globalThis.alert?.('“Notes” is the default folder and cannot be replaced.');
			return false;
		}

		const folderNames = buildFolderList(this.notes, this.clientOnlyFolders);
		const existingFolder = folderNames.find(
			(folder) =>
				folder !== sourceFolder &&
				folder.toLocaleLowerCase() === requestedFolder.toLocaleLowerCase()
		);
		if (existingFolder) {
			globalThis.alert?.(`A folder named “${existingFolder}” already exists.`);
			return false;
		}

		const targetFolder = requestedFolder;
		const sourceNoteIds = this.notes
			.filter((note) => note.folder === sourceFolder)
			.map((note) => note.id);
		if (sourceNoteIds.some((noteId) => this.activeDirectMoveNoteIds.has(noteId))) {
			globalThis.alert?.('Wait for the folder’s current note move to finish before renaming it.');
			return false;
		}
		const destinationExisted = folderNames.includes(targetFolder);
		this.folderActionBusy = true;
		if (!destinationExisted) this.clientOnlyFolders.add(targetFolder);

		try {
			if (!sourceNoteIds.length) {
				this.removeFolderObject(sourceFolder);
				this.persistFolder(targetFolder);
				this.clientOnlyFolders.delete(sourceFolder);
				if (targetFolder !== 'Notes') this.clientOnlyFolders.add(targetFolder);
				if (this.currentFolder === sourceFolder) this.currentFolder = targetFolder;
				return true;
			}

			const results = await Promise.all(
				sourceNoteIds.map((noteId) =>
					this.queueNoteFolderUpdate(noteId, targetFolder, {
						exactFolderName: true
					})
				)
			);
			const allMoved = results.every(Boolean);
			if (!this.notes.some((note) => note.folder === sourceFolder)) {
				this.removeFolderObject(sourceFolder);
				this.persistFolder(targetFolder);
				this.clientOnlyFolders.delete(sourceFolder);
				if (this.currentFolder === sourceFolder) this.currentFolder = targetFolder;
			}
			if (!this.notes.some((note) => note.folder === targetFolder) && !destinationExisted) {
				this.removeFolderObject(targetFolder);
				this.clientOnlyFolders.delete(targetFolder);
			}
			return allMoved;
		} finally {
			this.folderActionBusy = false;
		}
	}

	async deleteFolder(folder, confirmDelete = (message) => globalThis.confirm(message)) {
		const targetFolder = this.resolveFolderName(folder);
		if (!this.canManageFolder(targetFolder)) return false;
		const folderNotes = this.notes.filter((note) => note.folder === targetFolder);
		const draftCount = folderNotes.filter((note) => this.hasDraft(note.id)).length;
		const message = folderNotes.length
			? `Delete folder “${targetFolder}” and its ${folderNotes.length} ${folderNotes.length === 1 ? 'note' : 'notes'}? This cannot be undone.${
					draftCount ? ` ${draftCount} ${draftCount === 1 ? 'has' : 'have'} unsaved changes.` : ''
				}`
			: `Delete empty folder “${targetFolder}”?`;
		if (!confirmDelete(message)) return false;

		if (
			folderNotes.length &&
			!(await this.deleteNotes(
				folderNotes.map((note) => note.id),
				() => true
			))
		)
			return false;
		this.removeFolderObject(targetFolder);
		this.clientOnlyFolders.delete(targetFolder);
		this.cancelFolderRename();
		this.closeContextMenu();
		if (this.currentFolder === targetFolder) this.selectFolder('Notes');
		return true;
	}

	markFolderBacked(folder) {
		const normalized = String(folder ?? '')
			.trim()
			.toLocaleLowerCase();
		if (!normalized) return;
		const clientFolder = [...this.clientOnlyFolders].find(
			(candidate) => candidate.toLocaleLowerCase() === normalized
		);
		if (clientFolder) this.clientOnlyFolders.delete(clientFolder);
	}

	rememberFolderIfEmpty(folder) {
		const normalized = String(folder ?? '').trim();
		if (!normalized || normalized === 'Notes') return;
		if (!this.notes.some((note) => note.folder === normalized)) {
			this.clientOnlyFolders.add(normalized);
			this.persistFolder(normalized);
		}
	}

	selectFolder(folder) {
		// Picking a folder means browsing it, so any search in progress ends.
		this.closeSearch();
		this.currentFolder = this.resolveFolderName(folder);
		this.clearNoteSelection();
		this.foldersOpen = false;
	}

	async selectNote(noteId, options = {}) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) return false;
		if (note.folder !== this.currentFolder) {
			this.currentFolder = note.folder || 'Notes';
			this.replaceNoteSelection([], null, null);
		}

		const toggle = options.toggle === true;
		const extend = options.extend === true;
		const additive = options.additive === true;
		const visibleIds = this.getVisibleNoteIds();
		const targetIndex = visibleIds.indexOf(noteId);
		if (targetIndex === -1) return false;

		if (this.renamingNoteId && this.renamingNoteId !== noteId) this.cancelRename();

		if (extend) {
			const anchorIndex = visibleIds.indexOf(this.selectionAnchorId);
			if (anchorIndex === -1) {
				this.replaceNoteSelection([noteId], noteId, noteId);
			} else {
				if (!additive) this.selectedNoteIds.clear();
				const start = Math.min(anchorIndex, targetIndex);
				const end = Math.max(anchorIndex, targetIndex);
				visibleIds.slice(start, end + 1).forEach((id) => this.selectedNoteIds.add(id));
				this.focusedNoteId = noteId;
			}
		} else if (toggle) {
			if (this.selectedNoteIds.has(noteId)) this.selectedNoteIds.delete(noteId);
			else this.selectedNoteIds.add(noteId);
			this.selectionAnchorId = noteId;
			this.focusedNoteId = noteId;

			if (!this.selectedNoteIds.size) {
				this.resetOpenNote();
				this.closeContextMenu();
				if ((globalThis.window?.innerWidth ?? 1024) <= 768) this.detailOpen = false;
				return true;
			}

			if (!this.selectedNoteIds.has(noteId)) {
				const fallbackId = visibleIds.find((id) => this.selectedNoteIds.has(id));
				if (fallbackId && this.currentNoteId === noteId) await this.openNote(fallbackId);
				return true;
			}
		} else {
			this.replaceNoteSelection([noteId], noteId, noteId);
		}

		await this.openNote(noteId);
		return true;
	}

	async openNote(noteId, options = {}) {
		this.currentNoteId = noteId;
		this.noteLoadError = '';
		this.closeContextMenu();

		if ((globalThis.window?.innerWidth ?? 1024) <= 768) {
			this.foldersOpen = false;
			this.detailOpen = options.openDetail !== false;
		}

		let note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) {
			this.noteLoadState = 'idle';
			return false;
		}

		const request = ++this.noteLoadRequest;
		if (!note.hasContent && !note.isLocalOnly) {
			this.noteLoadState = 'loading';
			try {
				await this.hydrateNote(note);
				if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return false;
				note.hasContent = true;
			} catch (error) {
				if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return;
				this.noteLoadState = 'error';
				this.noteLoadError = 'Failed to load note';
				console.error('Error fetching note:');
				return false;
			}
		}

		if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return false;
		this.noteLoadState = 'ready';
		this.setEditorBaseline(note);
		this.editorRevision += 1;
		return true;
	}

	getEditorValue(note) {
		const committed = this.getCommittedNote(note);
		const draft = this.getDraft(note.id);
		return draft ? { ...committed, ...draft } : committed;
	}

	setEditorBaseline(note) {
		const committed = this.getCommittedNote(note);
		this.editorBaseline = {
			noteId: note.id,
			title: committed.title || '',
			content: committed.content || ''
		};
	}

	updateDraft(noteId, title, content) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) return;

		if (note.isLocalOnly) {
			note.title = title;
			note.content = content;
			note.updated = now();
			this.upsertLocalNote(note);
		}

		const baseline =
			this.editorBaseline.noteId === noteId ? this.editorBaseline : this.getCommittedNote(note);

		if (title === (baseline.title || '') && content === (baseline.content || '')) {
			this.clearDraft(noteId);
		} else {
			this.saveDraft(noteId, title, content, note.folder || 'Notes');
		}
	}

	getDisplayTitle(note) {
		const draft = this.getDraft(note.id);
		if (draft) return draft.title ?? '';

		const pending = this.getPendingPush(note.id);
		return note.title ?? '';
	}

	canCommit(noteId) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		return Boolean(note && (this.hasDraft(noteId) || note.isLocalOnly));
	}

	getNoteCommitPayload(noteId) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) return null;

		const draft = this.getDraft(noteId);
		if (draft) return { title: draft.title || '', content: draft.content || '' };
		if (note.isLocalOnly) return { title: note.title || '', content: note.content || '' };
		return null;
	}

	async commitCurrentNote() {
		if (!this.currentNoteId) return;
		const payload = this.getNoteCommitPayload(this.currentNoteId);
		if (!payload) return;
		return this.commitNote(this.currentNoteId, payload.title, payload.content);
	}

	revertNoteDraft(noteId) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) return;
		this.clearDraft(noteId);
		this.setEditorBaseline(note);
		this.editorRevision += 1;
	}

	async beginRenameSelectedNote() {
		const selectedIds = this.getSelectedNoteIds();
		const noteId = selectedIds[0];
		if (
			selectedIds.length !== 1 ||
			this.isKeyMigrationRunning ||
			this.changeKeyBusy ||
			this.activeDirectMoveNoteIds.has(noteId)
		) {
			return false;
		}

		const loaded = await this.openNote(noteId, { openDetail: false });
		if (!loaded || this.getSelectedNoteIds().length !== 1 || !this.selectedNoteIds.has(noteId)) {
			return false;
		}

		const note = this.notes.find((candidate) => candidate.id === noteId);
		if (!note) return false;
		this.renamingNoteId = noteId;
		this.renameDraftValue = this.getDisplayTitle(note);
		this.closeContextMenu();
		return true;
	}

	canRenameNote(noteId = null) {
		const selectedIds = this.getSelectedNoteIds();
		return (
			selectedIds.length === 1 &&
			(!noteId || selectedIds[0] === noteId) &&
			!this.isKeyMigrationRunning &&
			!this.changeKeyBusy &&
			!this.activeDirectMoveNoteIds.has(selectedIds[0])
		);
	}

	setRenameDraft(value) {
		if (!this.renamingNoteId) return;
		this.renameDraftValue = String(value ?? '');
	}

	async commitRename(value = this.renameDraftValue) {
		const noteId = this.renamingNoteId;
		const note = this.notes.find((n) => n.id === noteId);
		if (!note) {
			this.cancelRename();
			return false;
		}
		const title = String(value ?? '').trim();
		const previous = this.getDisplayTitle(note);
		const draft = this.getDraft(noteId) ? { ...this.getDraft(noteId) } : null;
		this.cancelRename();
		if (title === previous) return true;
		const ok = await this.commitNote(noteId, title, note.content || '');
		if (ok && draft && draft.content !== note.content)
			this.saveDraft(noteId, title, draft.content, note.folder);
		this.editorRevision += 1;
		return ok;
	}

	createNewNote(folder = this.currentFolder) {
		// A new note would not match the search, so end it to keep the note in view.
		this.closeSearch();
		const targetFolder = this.resolveFolderName(folder);
		const note = {
			id: makeLocalNoteId(),
			revision: '',
			generation: 1,
			title: '',
			folder: targetFolder,
			updated: now(),
			hasContent: true,
			content: '',
			isLocalOnly: true
		};
		this.notes.push(note);
		this.upsertLocalNote(note);
		this.saveDraft(note.id, '', '', targetFolder);
		this.markFolderBacked(targetFolder);
		this.currentFolder = note.folder;
		this.currentNoteId = note.id;
		this.replaceNoteSelection([note.id], note.id, note.id);
		this.cancelRename();
		this.noteLoadState = 'ready';
		this.setEditorBaseline(note);
		this.editorRevision += 1;
		this.foldersOpen = false;
		if ((globalThis.window?.innerWidth ?? 1024) <= 768) this.detailOpen = true;
		this.closeContextMenu();
		return note;
	}

	deleteNote(noteId, confirmDelete) {
		return this.deleteNotes(this.getActionNoteIds(noteId), confirmDelete);
	}

	deleteSelectedNotes(confirmDelete) {
		return this.deleteNotes(this.getSelectedNoteIds(), confirmDelete);
	}

	async deleteNotes(noteIds, confirmDelete = (message) => globalThis.confirm(message)) {
		const targets = [...new Set(noteIds)]
			.map((id) => this.notes.find((n) => n.id === id))
			.filter(Boolean);
		if (
			!targets.length ||
			!confirmDelete(`Delete ${targets.length} ${targets.length === 1 ? 'note' : 'notes'}?`)
		)
			return false;
		for (const note of targets) {
			const ok = await this.enqueueLocal(async () => {
				if (!note.revision) {
					await this.db.delete('drafts', note.id);
					await this.db.delete('notes', note.id);
					delete this.drafts[note.id];
				} else {
					const revision = newId();
					const payload = {
						epoch: this.scope.epoch,
						operationId: newId(),
						logicalId: note.id,
						action: 'delete',
						baseRevision: note.revision,
						revision
					};
					const stored = await this.db.get('notes', note.id);
					await this.db.commit({
						note: { ...stored, revision, deleted: true },
						operation: await this.makeOperation('commit', note.id, payload),
						draftSequence: Number.MAX_SAFE_INTEGER
					});
					delete this.drafts[note.id];
				}
				this.notes = this.notes.filter((n) => n.id !== note.id);
				this.selectedNoteIds.delete(note.id);
				delete this.localNotes[note.id];
				if (this.currentNoteId === note.id) this.resetOpenNote();
				this.rememberFolderIfEmpty(note.folder);
			});
			if (!ok) return false;
		}
		await this.refreshPending();
		this.closeContextMenu();
		this.flushPendingPushes();
		return true;
	}

	async queueNoteFolderUpdate(noteId, folder, options = {}) {
		const note = this.notes.find((n) => n.id === noteId);
		if (!note) return false;
		const target = options.exactFolderName ? folder : this.resolveFolderName(folder);
		if (note.folder === target) return true;
		const oldFolder = note.folder;
		const ok = await this.enqueueLocal(() =>
			this.writeObject('placement', { noteId, folder: target }, this.placementId(noteId))
		);
		if (!ok) return false;
		note.folder = target;
		if (this.drafts[noteId]) {
			this.drafts[noteId].folder = target;
			this.persistDrafts();
		}
		this.persistFolder(target);
		this.markFolderBacked(target);
		this.rememberFolderIfEmpty(oldFolder);
		this.flushPendingPushes();
		return true;
	}

	async moveNoteToFolder(noteId, folder, options = {}) {
		return this.queueNoteFolderUpdate(noteId, folder, options);
	}

	async moveNotesToFolder(noteIds, folder) {
		const uniqueIds = [...new Set(noteIds || [])].filter((noteId) =>
			this.notes.some((note) => note.id === noteId)
		);
		if (!uniqueIds.length) return false;
		if (uniqueIds.some((noteId) => this.activeDirectMoveNoteIds.has(noteId))) {
			alert('One or more selected notes are already being moved. Wait for that move to finish.');
			return false;
		}
		const targetFolder = this.resolveFolderName(folder);
		const moveCandidateIds = new Set(
			uniqueIds.filter(
				(noteId) => this.notes.find((note) => note.id === noteId)?.folder !== targetFolder
			)
		);
		const hasMove = moveCandidateIds.size > 0;
		const results = await Promise.all(
			uniqueIds.map((noteId) => this.moveNoteToFolder(noteId, targetFolder))
		);
		if (hasMove) {
			const movedIds = uniqueIds.filter(
				(noteId, index) => moveCandidateIds.has(noteId) && results[index] === true
			);
			movedIds.forEach((noteId) => this.selectedNoteIds.delete(noteId));
			const remainingIds = this.getSelectedNoteIds();
			if (movedIds.includes(this.selectionAnchorId)) {
				this.selectionAnchorId = remainingIds[0] || null;
			}
			if (movedIds.includes(this.focusedNoteId)) {
				this.focusedNoteId = remainingIds[0] || null;
			}
			if (movedIds.includes(this.currentNoteId)) {
				if (remainingIds.length) {
					this.focusedNoteId = remainingIds[0];
					await this.openNote(remainingIds[0]);
				} else {
					this.resetOpenNote();
					if ((globalThis.window?.innerWidth ?? 1024) <= 768) this.detailOpen = false;
				}
			}
		}
		return results.every(Boolean);
	}

	beginNoteDrag(event, noteId) {
		if (this.renamingNoteId || !this.notes.some((note) => note.id === noteId)) {
			event.preventDefault();
			return false;
		}
		if (!this.selectedNoteIds.has(noteId)) this.selectNote(noteId);
		const noteIds = this.getActionNoteIds(noteId);
		if (!noteIds.length) {
			event.preventDefault();
			return false;
		}

		this.draggedNoteIds = noteIds;
		this.dragOverFolder = null;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('application/x-jnote-note-ids', JSON.stringify(noteIds));
			event.dataTransfer.setData(
				'text/plain',
				`${noteIds.length} JNote ${noteIds.length === 1 ? 'note' : 'notes'}`
			);
		}
		this.closeContextMenu();
		return true;
	}

	canDropNotesOnFolder(folder) {
		const targetFolder = this.resolveFolderName(folder);
		if (this.draggedNoteIds.some((noteId) => this.activeDirectMoveNoteIds.has(noteId))) {
			return false;
		}
		return this.draggedNoteIds.some((noteId) => {
			const note = this.notes.find((candidate) => candidate.id === noteId);
			return note && note.folder !== targetFolder;
		});
	}

	dragNotesOverFolder(event, folder) {
		if (!this.canDropNotesOnFolder(folder)) return false;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.dragOverFolder = this.resolveFolderName(folder);
		return true;
	}

	leaveFolderDropTarget(event, folder) {
		if (event.currentTarget.contains(event.relatedTarget)) return;
		if (this.dragOverFolder === this.resolveFolderName(folder)) this.dragOverFolder = null;
	}

	async dropNotesOnFolder(event, folder) {
		if (!this.canDropNotesOnFolder(folder)) {
			this.clearNoteDrag();
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		const noteIds = [...this.draggedNoteIds];
		const targetFolder = this.resolveFolderName(folder);
		this.clearNoteDrag();
		return this.moveNotesToFolder(noteIds, targetFolder);
	}

	clearNoteDrag() {
		this.draggedNoteIds = [];
		this.dragOverFolder = null;
	}

	openFolderModal(noteId, mode = 'move') {
		this.closeContextMenu();
		const noteIds = mode === 'move' ? this.getActionNoteIds(noteId) : noteId ? [noteId] : [];
		if (mode === 'move' && !noteIds.length) return;
		this.folderModal = {
			open: true,
			mode,
			noteId: noteIds[0] || noteId || null,
			noteIds,
			returnFocusNoteId: noteId || noteIds[0] || null
		};
	}

	closeFolderModal() {
		this.folderModal = {
			open: false,
			mode: 'move',
			noteId: null,
			noteIds: [],
			returnFocusNoteId: null
		};
	}

	toggleFolders() {
		this.foldersOpen = !this.foldersOpen;
		if (this.foldersOpen && (globalThis.window?.innerWidth ?? 1024) <= 768) {
			this.detailOpen = false;
		}
	}

	closeFolders() {
		this.foldersOpen = false;
	}

	closeDetail() {
		this.detailOpen = false;
	}

	closeMobilePanels() {
		this.foldersOpen = false;
		this.detailOpen = false;
		this.closeContextMenu();
	}

	handleResize() {
		this.closeContextMenu();
		this.isMobileViewport = window.innerWidth <= 768;
		if (!this.isMobileViewport) this.closeMobilePanels();
	}

	openContextMenu(event, noteId) {
		event.preventDefault();
		event.stopPropagation();
		if (!this.notes.some((note) => note.id === noteId)) return;
		if (!this.selectedNoteIds.has(noteId)) {
			this.selectNote(noteId);
		} else {
			this.focusedNoteId = noteId;
		}
		const { x, y } = getContextMenuPosition(event);
		this.contextMenu = {
			open: true,
			type: 'note',
			surface: null,
			noteId,
			folder: null,
			x,
			y
		};
	}

	openFolderContextMenu(event, folder) {
		event.preventDefault();
		event.stopPropagation();
		const resolved = this.resolveFolderName(folder);
		if (!buildFolderList(this.notes, this.clientOnlyFolders).includes(resolved)) return false;
		const { x, y } = getContextMenuPosition(event);
		this.contextMenu = {
			open: true,
			type: 'folder',
			surface: null,
			noteId: null,
			folder: resolved,
			x,
			y
		};
		return true;
	}

	openBlankContextMenu(event, surface = 'notes') {
		event.preventDefault();
		event.stopPropagation();
		const normalizedSurface = surface === 'folders' ? 'folders' : 'notes';
		if (normalizedSurface === 'notes') this.clearNoteSelection();
		else this.closeContextMenu();
		const { x, y } = getContextMenuPosition(event);
		this.contextMenu = {
			open: true,
			type: 'blank',
			surface: normalizedSurface,
			noteId: null,
			folder: this.currentFolder,
			x,
			y
		};
		return true;
	}

	closeContextMenu() {
		if (!this.contextMenu.open) return;
		this.contextMenu = {
			open: false,
			type: null,
			surface: null,
			noteId: null,
			folder: null,
			x: 0,
			y: 0
		};
	}

	commitFromContextMenu(noteId) {
		const payload = this.getNoteCommitPayload(noteId);
		if (!payload) return;
		this.commitNote(noteId, payload.title, payload.content);
	}

	downloadJsonFile(data, filename) {
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		link.rel = 'noopener';
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	makeExportFilename() {
		const timestamp = now().replace(/[:.]/g, '-');
		return `jnote-plaintext-export-${timestamp}.json`;
	}

	async downloadAllDataNotes() {
		if (!this.encryptionState) {
			alert('Unlock notes before exporting.');
			return false;
		}
		if (this.exportBusy) return false;

		this.exportBusy = true;
		try {
			const data = await this.buildPlaintextExport();
			this.downloadJsonFile(data, this.makeExportFilename());
			this.settingsOpen = false;
			return true;
		} catch (error) {
			console.error('Could not export notes:');
			alert('Could not export notes. Check your connection and try again.');
			return false;
		} finally {
			this.exportBusy = false;
		}
	}

	async submitKeyChange(currentKey, newKey, confirmKey) {
		this.changeKeyError = '';
		this.changeKeyStatus = '';

		if (!currentKey || !newKey || !confirmKey) {
			this.changeKeyError = 'Enter the current key, the new key, and the confirmation.';
			return { ok: false, focus: !currentKey ? 'current' : !newKey ? 'new' : 'confirm' };
		}
		if (newKey !== confirmKey) {
			this.changeKeyError = 'The new key and confirmation do not match.';
			return { ok: false, focus: 'confirm' };
		}
		if (newKey === currentKey) {
			this.changeKeyError = 'Choose a new key that is different from the current key.';
			return { ok: false, focus: 'new' };
		}

		this.changeKeyBusy = true;
		try {
			await this.changeDecryptionKey(currentKey, newKey, (message) => {
				this.changeKeyStatus = message;
			});
			this.changeKeyStatus = 'Decryption key changed.';
			return { ok: true };
		} catch (error) {
			console.error('Could not change decryption key:');
			this.changeKeyError = this.getKeyChangeFailureMessage(error);
			return { ok: false };
		} finally {
			this.changeKeyBusy = false;
		}
	}

	openSettings() {
		this.settingsOpen = true;
	}

	openCustomCss() {
		this.settingsOpen = false;
		this.customCss = this.readCustomCss();
		this.customCssOpen = true;
	}

	openChangeKey() {
		this.settingsOpen = false;
		this.changeKeyStatus = '';
		this.changeKeyError = '';
		this.changeKeyOpen = true;
	}

	closeChangeKey() {
		if (!this.changeKeyBusy && !this.isKeyMigrationRunning) this.changeKeyOpen = false;
	}

	async forgetThisDevice() {
		await this.forgetRememberedDeviceKey();
		this.settingsOpen = false;
		alert('This browser will ask for your encryption passphrase next time.');
	}

	beforeUnloadMessage() {
		if (this.isKeyMigrationRunning) {
			return 'Your vault wrapper change is being confirmed.';
		}
		if (this.localBusy || this.persistenceError)
			return 'Changes have not been saved on this device yet.';
		if (this.activeDirectMoves.size > 0) {
			return 'A folder move is still being saved to the cloud.';
		}
		if (this.renamingNoteId) {
			const note = this.notes.find((candidate) => candidate.id === this.renamingNoteId);
			if (note && this.renameDraftValue.trim() !== this.getDisplayTitle(note)) {
				return 'A note rename is still being edited.';
			}
		}
		if (
			this.renamingFolder &&
			this.folderRenameDraftValue.trim() &&
			this.folderRenameDraftValue.trim() !== this.renamingFolder
		) {
			return 'A folder rename is still being edited.';
		}
		return '';
	}

	async initialize() {
		if (this.initialized) return;
		this.initialized = true;
		this.customCss = this.readCustomCss();
		this.applyCustomCss();
		// A remembered namespace can unlock before the account/network checks finish.
		try {
			const cached = JSON.parse(localStorage.getItem('jnote.account.v2') || 'null');
			if (cached?.owner && cached?.epoch) {
				this.currentUser = { id: cached.owner };
				await this.selectNamespace(cached.owner, cached.epoch);
				this.vaultHeader = (await this.db.get('meta', 'vault'))?.value;
				this.unlockMode = this.vaultHeader ? 'unlock' : 'loading';
				const remembered = await this.db.get('protected', 'device');
				if (remembered && this.vaultHeader) {
					this.encryptionState = { key: await unlockRemembered(remembered, this.scope) };
					await this.finishEncryptionUnlock();
				}
			}
		} catch {
			this.persistenceError = 'Could not open the encrypted cache. Storage may have been evicted.';
		}
		this.checkCloud();
		this.syncTimer = window.setInterval(() => this.checkCloud(), 10000);
	}

	async selectNamespace(owner, epoch) {
		if (this.scope?.owner === owner && this.scope.epoch === epoch && this.db) return;
		if (this.encryptionState && this.persistenceError)
			throw new Error('Save or export unsaved work before switching namespaces.');
		await this.lock(false);
		this.db?.close();
		this.db = await openLocalDb(owner, epoch);
		this.scope = { owner, epoch };
		localStorage.setItem('jnote.account.v2', JSON.stringify(this.scope));
		retireLegacyStores(localStorage, owner);
	}

	async checkCloud() {
		if (this.checkingCloud || !this.initialized) return;
		this.checkingCloud = true;
		try {
			await whenAccountsScriptSettled();
			if (isAccountsBridgeAvailable()) this.authMode = 'bridge';
			else if (isAccountsHandoffAvailable()) this.authMode = 'redirect';
			else this.authMode = 'unsupported';
			if (this.authMode === 'unsupported') {
				this.cloudValidated = false;
				this.cloudState =
					navigator.onLine === false ||
					(window.JNOTE_CONFIG?.accountsOrigins || []).includes(window.location.origin)
						? 'offline'
						: 'unsupported';
				this.accountError =
					this.cloudState === 'offline'
						? 'Cloud unavailable. Your encrypted cache remains available.'
						: `${accountsOrigin()} does not serve sessions to ${window.location.origin}.`;
				if (!this.vaultHeader) this.unlockMode = 'auth-required';
				return;
			}
			if (!this.accountReady) {
				this.client = null;
				if (this.authMode === 'redirect') await this.consumeAccountHandoff();
			}
			const session = await this.getAccountSession();
			if (!session) {
				this.cloudValidated = false;
				this.cloudState = 'signed-out';
				await this.lock();
				this.unlockMode = 'auth-required';
				return;
			}
			if (this.scope && session.record.id !== this.scope.owner) {
				if (this.persistenceError)
					throw new Error('Save or export local work before switching accounts.');
				await this.lock(false);
			}
			this.pb.authStore.save(session.token, session.record);
			await this.loadCurrentUser();
			const api = new JNoteApi(this.pb);
			const bootstrap = await api.bootstrap();
			if (bootstrap.protocol !== 2 || bootstrap.minimumClient > 2)
				throw new Error('Update required.');
			const changed =
				this.scope &&
				(this.scope.owner !== this.currentUser.id || this.scope.epoch !== bootstrap.epoch);
			if (changed)
				this.accountError =
					'The account or dataset changed. Old encrypted work is retained in its original cache.';
			await this.selectNamespace(this.currentUser.id, bootstrap.epoch);
			this.api = api;
			this.cloudValidated = true;
			this.cloudState = 'online';
			this.vaultHeader = bootstrap.vault;
			await this.db.put('meta', { id: 'vault', value: bootstrap.vault });
			if (!this.encryptionState) {
				this.unlockMode = bootstrap.vault ? 'unlock' : 'setup';
				const remembered = await this.db.get('protected', 'device');
				if (remembered && bootstrap.vault && !this.manualLock) {
					this.encryptionState = { key: await unlockRemembered(remembered, this.scope) };
					await this.finishEncryptionUnlock();
				}
			} else await this.syncNow();
		} catch (error) {
			this.cloudValidated = false;
			this.cloudState = error.status === 401 || error.status === 403 ? 'signed-out' : 'offline';
			this.accountError =
				error.status === 404
					? 'This server needs the JNote v2 backend before encryption setup.'
					: 'Cloud check failed. Cached notes remain available.';
			if (this.cloudState === 'signed-out') {
				await this.lock();
				this.unlockMode = 'auth-required';
			} else if (!this.vaultHeader) this.unlockMode = 'auth-required';
		} finally {
			this.checkingCloud = false;
			this.accountReady = true;
		}
	}

	async submitEncryptionKey(passphrase, rememberDevice) {
		if (!passphrase || this.unlockBusy || !this.db) return false;
		this.unlockBusy = true;
		this.encryptionError = '';
		try {
			if (this.unlockMode === 'setup') {
				if (!this.cloudValidated) throw new Error('Connect to set up encryption.');
				const vault = await createVault(passphrase, this.scope);
				const operationId = newId();
				// Keep the exact staged request for retry after a lost server response.
				const stage = {
					id: 'vault-setup',
					value: { epoch: this.scope.epoch, operationId, baseRevision: '', header: vault.header }
				};
				const previous = await this.db.get('meta', 'vault-setup');
				if (previous) {
					vault.header = previous.value.header;
					vault.key = await unlockVault(passphrase, vault.header, this.scope);
					stage.value = previous.value;
				} else await this.db.put('meta', stage);
				await this.api.send('vault', stage.value);
				this.vaultHeader = vault.header;
				this.encryptionState = { key: vault.key };
				await this.db.put('meta', { id: 'vault', value: vault.header });
				await this.db.delete('meta', 'vault-setup');
			} else
				this.encryptionState = { key: await unlockVault(passphrase, this.vaultHeader, this.scope) };
			if (rememberDevice) {
				await this.db.put('protected', await rememberVault(this.encryptionState.key, this.scope));
				// Structured-clone support and nonextractability are verified by a round trip.
				await unlockRemembered(await this.db.get('protected', 'device'), this.scope);
			}
			this.manualLock = false;
			await this.finishEncryptionUnlock();
			return true;
		} catch (error) {
			this.encryptionState = null;
			this.encryptionError = error.message?.includes('required')
				? error.message
				: 'Could not unlock or save the vault. Check your passphrase, connection, and browser storage.';
			return false;
		} finally {
			this.unlockBusy = false;
		}
	}

	async finishEncryptionUnlock() {
		await this.loadNotes({ bodies: false });
		this.unlockMode = 'ready';
		this.hydrateCurrentBodies();
		this.syncNow();
	}

	enqueueLocal(work) {
		const generation = this.sessionGeneration;
		this.localBusy += 1;
		const result = this.localWork
			.then(async () => {
				if (!this.encryptionState || !this.db || generation !== this.sessionGeneration)
					throw new Error('Vault is locked.');
				await work();
				this.persistenceError = '';
				return true;
			})
			.catch(() => {
				this.persistenceError =
					'Changes could not be saved on this device. Keep the app open and retry.';
				return false;
			})
			.finally(() => {
				this.localBusy -= 1;
			});
		this.localWork = result;
		return result;
	}

	async makeOperation(endpoint, objectId, payload) {
		return {
			id: payload.operationId,
			objectId,
			endpoint,
			ciphertext: await encryptObject(
				payload,
				this.encryptionState.key,
				context('outbox', this.scope, payload.operationId)
			)
		};
	}

	async keyFor(logicalId, generation = 1) {
		if (this.noteKeys.has(logicalId)) return this.noteKeys.get(logicalId);
		const grant = await this.db.get('grants', logicalId);
		const pair = grant
			? {
					key: await unwrapNoteKey(
						grant.wrapper,
						this.encryptionState.key,
						this.scope,
						logicalId,
						generation
					),
					wrapper: grant.wrapper
				}
			: await createNoteKey(this.encryptionState.key, this.scope, logicalId, generation);
		this.noteKeys.set(logicalId, pair);
		return pair;
	}

	persistDrafts() {
		for (const [id, value] of Object.entries(this.drafts)) {
			const snapshot = { ...value };
			const sequence = Math.max(Date.now() * 1000, (this.draftSequences.get(id) || 0) + 1);
			this.draftSequences.set(id, sequence);
			this.enqueueLocal(async () => {
				if (this.draftSequences.get(id) !== sequence) return;
				const pair = await this.keyFor(id);
				const ciphertext = await encryptObject(
					snapshot,
					pair.key,
					context('draft', this.scope, id)
				);
				await this.db.transaction(['grants', 'drafts'], 'readwrite', async (s) => {
					await s.grants.put({ id, wrapper: pair.wrapper });
					const existing = await s.drafts.get(id);
					if (!existing || existing.sequence < sequence)
						await s.drafts.put({ id, sequence, ciphertext });
				});
			});
		}
		for (const id of this.draftSequences.keys()) {
			if (!this.drafts[id]) {
				const sequence = this.draftSequences.get(id);
				this.enqueueLocal(async () => {
					await this.db.transaction(['drafts'], 'readwrite', async (s) => {
						const current = await s.drafts.get(id);
						if (current && current.sequence <= sequence) await s.drafts.delete(id);
					});
				});
			}
		}
	}
	// Uncommitted local notes live in the encrypted draft store.
	persistLocalNotes() {}
	persistPendingPushes() {}

	async commitNote(noteId, title, content) {
		if (this.isKeyMigrationRunning || this.changeKeyBusy) return false;
		const draftSequence = this.draftSequences.get(noteId) || 0;
		const ok = await this.enqueueLocal(async () => {
			const note = this.notes.find((n) => n.id === noteId);
			if (!note) throw new Error('Note unavailable.');
			const revision = newId();
			const pair = await this.keyFor(noteId);
			const summary = await encryptObject(
				{ title },
				pair.key,
				context('summary', this.scope, noteId, revision)
			);
			const ciphertext = await encryptObject(
				{ title, content },
				pair.key,
				context('history', this.scope, noteId, revision)
			);
			const payload = {
				epoch: this.scope.epoch,
				operationId: newId(),
				logicalId: noteId,
				action: note.revision ? 'update' : 'create',
				baseRevision: note.revision || '',
				revision,
				generation: 1,
				summary,
				ciphertext,
				wrapper: pair.wrapper
			};
			const stored = {
				id: noteId,
				logicalId: noteId,
				serverId: note.serverId || '',
				revision,
				summaryRevision: revision,
				generation: 1,
				summary,
				deleted: false,
				updated: now()
			};
			await this.db.commit({
				note: stored,
				content: { id: revision, logicalId: noteId, revision, generation: 1, ciphertext },
				grant: { id: noteId, wrapper: pair.wrapper },
				operation: await this.makeOperation('commit', noteId, payload),
				draftSequence
			});
			// A later draft is kept even when encryption of this snapshot took time.
			if ((this.draftSequences.get(noteId) || 0) <= draftSequence) delete this.drafts[noteId];
			Object.assign(note, {
				title,
				content,
				revision,
				versionId: revision,
				hasContent: true,
				isLocalOnly: false,
				updated: stored.updated
			});
			if (this.currentNoteId === noteId) this.editorBaseline = { noteId, title, content };
			if (note.folder !== 'Notes')
				await this.writeObject(
					'placement',
					{ noteId, folder: note.folder },
					this.placementId(noteId)
				);
		});
		await this.refreshPending();
		if (ok) this.flushPendingPushes();
		return ok;
	}

	async refreshPending() {
		if (!this.db || !this.encryptionState) return;
		const pending = {};
		const conflicts = [];
		for (const item of (await this.db.all('outbox')).sort((a, b) => a.order - b.order)) {
			const value = await decryptObject(
				item.ciphertext,
				this.encryptionState.key,
				context('outbox', this.scope, item.id)
			);
			pending[item.id] = { ...item, action: value.action, noteId: item.objectId };
			if (item.conflict) conflicts.push({ ...item });
		}
		this.pendingPushes = pending;
		this.conflicts = conflicts;
	}
	getPendingPush(noteId) {
		return (
			Object.values(this.pendingPushes)
				.filter((p) => p.noteId === noteId)
				.at(-1) || null
		);
	}
	getCommittedNote(note) {
		return note;
	}

	async loadNotes({ bodies = true } = {}) {
		if (!this.encryptionState || !this.db) return;
		const notes = [];
		const cachedContents = bodies
			? new Map((await this.db.all('contents')).map((b) => [b.id, b]))
			: new Map();
		this.objectValues.clear();
		for (const object of await this.db.all('objects')) {
			const value = await decryptObject(
				object.ciphertext,
				this.encryptionState.key,
				context(`personal:${object.objectType}`, this.scope, object.id, object.revision)
			);
			this.objectValues.set(object.id, { ...object, value });
		}
		for (const item of (await this.db.all('outbox')).sort((a, b) => a.order - b.order)) {
			if (item.endpoint !== 'object') continue;
			const p = await decryptObject(
				item.ciphertext,
				this.encryptionState.key,
				context('outbox', this.scope, item.id)
			);
			const value = await decryptObject(
				p.ciphertext,
				this.encryptionState.key,
				context(`personal:${p.objectType}`, this.scope, p.objectId, p.revision)
			);
			this.objectValues.set(p.objectId, { ...p, id: p.objectId, value });
		}
		const placements = new Map(
			[...this.objectValues.values()]
				.filter((o) => o.objectType === 'placement' && !o.deleted)
				.map((o) => [o.value.noteId, o.value.folder])
		);
		this.clientOnlyFolders.clear();
		for (const object of this.objectValues.values()) {
			if (object.objectType === 'folder' && !object.deleted)
				this.clientOnlyFolders.add(object.value.name);
			if (object.objectType === 'settings' && !object.deleted) {
				this.customCss = object.value.customCss || '';
				this.applyCustomCss();
				localStorage.setItem(CUSTOM_CSS_STORAGE_KEY, this.customCss);
			}
		}
		for (const stored of await this.db.all('notes')) {
			if (stored.deleted) continue;
			const pair = await this.keyFor(stored.id, stored.generation);
			const summary = await decryptObject(
				stored.summary,
				pair.key,
				context(
					'summary',
					this.scope,
					stored.id,
					stored.summaryRevision || stored.revision,
					stored.generation
				)
			);
			const note = {
				...stored,
				title: summary.title,
				folder: placements.get(stored.id) || 'Notes',
				hasContent: false,
				isLocalOnly: false
			};
			const body = cachedContents.get(stored.revision);
			if (body) {
				Object.assign(
					note,
					await decryptObject(
						body.ciphertext,
						pair.key,
						context('history', this.scope, stored.id, body.revision, body.generation)
					)
				);
				note.hasContent = true;
			}
			notes.push(note);
		}
		// The current feed may be behind the durable local head. Replay local requests in order.
		for (const item of (await this.db.all('outbox')).sort((a, b) => a.order - b.order)) {
			if (item.endpoint !== 'commit') continue;
			const payload = await decryptObject(
				item.ciphertext,
				this.encryptionState.key,
				context('outbox', this.scope, item.id)
			);
			const index = notes.findIndex((n) => n.id === item.objectId);
			if (payload.action === 'delete') {
				if (index >= 0) notes.splice(index, 1);
				continue;
			}
			const pair = await this.keyFor(item.objectId);
			const value = await decryptObject(
				payload.ciphertext,
				pair.key,
				context('history', this.scope, item.objectId, payload.revision)
			);
			const note = {
				...(notes[index] || {}),
				...value,
				id: item.objectId,
				revision: payload.revision,
				generation: 1,
				hasContent: true,
				folder: placements.get(item.objectId) || 'Notes',
				updated: notes[index]?.updated || now()
			};
			if (index >= 0) notes[index] = note;
			else notes.push(note);
		}
		const drafts = {};
		for (const stored of await this.db.all('drafts')) {
			const pair = await this.keyFor(stored.id);
			drafts[stored.id] = await decryptObject(
				stored.ciphertext,
				pair.key,
				context('draft', this.scope, stored.id)
			);
			this.draftSequences.set(
				stored.id,
				Math.max(stored.sequence, this.draftSequences.get(stored.id) || 0)
			);
			if (!notes.some((n) => n.id === stored.id))
				notes.push({
					id: stored.id,
					...drafts[stored.id],
					revision: '',
					generation: 1,
					hasContent: true,
					isLocalOnly: true
				});
		}
		for (const [id, draft] of Object.entries(this.drafts)) {
			const stored = await this.db.get('drafts', id);
			if ((this.draftSequences.get(id) || 0) > (stored?.sequence || 0)) drafts[id] = draft;
		}
		this.drafts = drafts;
		this.notes = notes.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
		this.loadState = 'ready';
		await this.refreshPending();
		this.hydrationState = notes.every((n) => n.hasContent) ? 'complete' : 'incomplete';
	}

	flushPendingPushes() {
		this.syncNow();
	}
	async syncNow() {
		if (!this.encryptionState || !this.cloudValidated || this.syncRunning || !this.db) return;
		this.syncRunning = true;
		const generation = this.sessionGeneration;
		this.syncController = new AbortController();
		const db = this.db;
		const key = this.encryptionState.key;
		try {
			await this.localWork;
			const beforeOrder = (await db.get('meta', 'order'))?.value || 0;
			const beforePending = (await db.all('outbox')).length;
			let changesApplied = false;
			await flushOutbox(db, key, this.api, {
				signal: this.syncController.signal,
				onReceipt: async (item) => {
					if (item.endpoint === 'vault') {
						const value = await decryptObject(
							item.ciphertext,
							key,
							context('outbox', db.scope, item.id)
						);
						await db.put('meta', { id: 'vault', value: value.header });
						if (generation === this.sessionGeneration) this.vaultHeader = value.header;
					}
				}
			});
			if (generation !== this.sessionGeneration) return;
			let more;
			do {
				const cursor = (await db.get('meta', 'cursor'))?.value || 0;
				let page;
				try {
					page = await this.api.changes(this.scope.epoch, cursor);
				} catch (error) {
					if (error.status !== 410) throw error;
					// Rebuild server heads; preserve this epoch's local drafts, histories, and outbox.
					await db.transaction(['notes', 'objects', 'meta'], 'readwrite', async (s) => {
						await s.notes.clear();
						await s.objects.clear();
						await s.meta.put({ id: 'cursor', value: 0 });
					});
					page = await this.api.changes(this.scope.epoch, 0);
				}
				if (generation !== this.sessionGeneration) return;
				if (page.changes.length) changesApplied = true;
				await db.applyChanges(page);
				more = page.more;
			} while (more && generation === this.sessionGeneration);
			if (generation !== this.sessionGeneration) return;
			await this.localWork;
			const afterPending = (await db.all('outbox')).length;
			if (changesApplied || beforePending !== afterPending || this.lastLocalOrder !== beforeOrder) {
				await this.loadNotes({ bodies: false });
				this.lastLocalOrder = beforeOrder;
			} else await this.refreshPending();
			if (this.hydrationState !== 'complete') await this.hydrateCurrentBodies();
			this.hasPushError = false;
			this.cloudState = 'online';
		} catch (error) {
			if (generation !== this.sessionGeneration) return;
			this.hasPushError = true;
			if (error.status === 409) {
				this.cloudValidated = false;
				this.accountError = 'Dataset changed. Rechecking the server before uploading.';
			} else this.cloudState = 'offline';
		} finally {
			this.syncRunning = false;
		}
	}

	async hydrateNote(note) {
		const generation = this.sessionGeneration;
		const revision = note.revision;
		let body = await this.db.get('contents', revision);
		if (!body) {
			if (!this.cloudValidated)
				throw new Error('This body has not been downloaded. Connect to download it.');
			body = (await this.api.content(this.scope.epoch, note.id, revision)).items[0];
		}
		if (generation !== this.sessionGeneration) return;
		if (!body) throw new Error('Current body unavailable.');
		const pair = await this.keyFor(note.id, body.generation);
		const value = await decryptObject(
			body.ciphertext,
			pair.key,
			context('history', this.scope, note.id, body.revision, body.generation)
		);
		await this.db.put('contents', { ...body, id: body.revision });
		if (note.revision === revision) {
			Object.assign(note, value, { hasContent: true });
			if (
				this.currentNoteId === note.id &&
				!this.hasDraft(note.id) &&
				(this.editorBaseline.title !== value.title || this.editorBaseline.content !== value.content)
			) {
				this.setEditorBaseline(note);
				this.editorRevision += 1;
			}
		}
	}
	async hydrateCurrentBodies() {
		const generation = this.sessionGeneration;
		this.hydrationState = 'downloading';
		const notes = this.notes
			.filter((n) => !n.hasContent)
			.sort((a, b) => (a.id === this.currentNoteId ? -1 : b.id === this.currentNoteId ? 1 : 0));
		for (let index = 0; index < notes.length; index += 4) {
			if (generation !== this.sessionGeneration) return;
			const results = await Promise.allSettled(
				notes.slice(index, index + 4).map((n) => this.hydrateNote(n))
			);
			if (results.some((r) => r.status === 'rejected')) {
				this.hydrationState = 'incomplete';
				return;
			}
		}
		this.hydrationState = this.notes.every((n) => n.hasContent) ? 'complete' : 'incomplete';
	}

	placementId(noteId) {
		return (
			[...this.objectValues.values()].find(
				(o) => o.objectType === 'placement' && o.value.noteId === noteId
			)?.id || newId()
		);
	}
	async writeObject(type, value, objectId = newId(), deleted = false) {
		const old = this.objectValues.get(objectId);
		const revision = newId();
		const ciphertext = await encryptObject(
			value,
			this.encryptionState.key,
			context(`personal:${type}`, this.scope, objectId, revision)
		);
		const object = { id: objectId, objectId, objectType: type, revision, ciphertext, deleted };
		const payload = {
			epoch: this.scope.epoch,
			operationId: newId(),
			objectId,
			objectType: type,
			baseRevision: old?.revision || '',
			revision,
			ciphertext,
			deleted
		};
		const operation = await this.makeOperation('object', objectId, payload);
		await this.db.transaction(['objects', 'outbox', 'meta'], 'readwrite', async (s) => {
			const order = ((await s.meta.get('order'))?.value || 0) + 1;
			await s.meta.put({ id: 'order', value: order });
			await s.objects.put(object);
			await s.outbox.put({ ...operation, order });
		});
		this.objectValues.set(objectId, { ...object, value });
		await this.refreshPending();
		return objectId;
	}
	persistFolder(name) {
		if (name === 'Notes') return;
		this.enqueueLocal(async () => {
			const old = [...this.objectValues.values()].find(
				(o) => o.objectType === 'folder' && !o.deleted && o.value.name === name
			);
			if (!old) await this.writeObject('folder', { name });
		});
	}
	removeFolderObject(name) {
		this.enqueueLocal(async () => {
			for (const o of this.objectValues.values())
				if (o.objectType === 'folder' && !o.deleted && o.value.name === name)
					await this.writeObject('folder', o.value, o.id, true);
		});
	}
	async saveSetting(value) {
		const existing = [...this.objectValues.values()].find((o) => o.objectType === 'settings');
		await this.writeObject('settings', { ...existing?.value, ...value }, existing?.id);
		this.flushPendingPushes();
	}

	async changeDecryptionKey(currentPassphrase, newPassphrase, onStatus = () => {}) {
		if (!this.encryptionState || !this.cloudValidated)
			throw new Error('Connect and unlock before changing the passphrase.');
		if ((await this.db.all('outbox')).some((o) => o.endpoint === 'vault'))
			throw new Error('Confirm the staged passphrase change before starting another.');
		this.isKeyMigrationRunning = true;
		try {
			onStatus('Verifying current passphrase…');
			const key = await unlockVault(currentPassphrase, this.vaultHeader, this.scope);
			const header = await rewrapVault(key, newPassphrase, this.scope);
			onStatus('Saving the new vault wrapper…');
			const ok = await this.enqueueLocal(async () => {
				const payload = {
					epoch: this.scope.epoch,
					operationId: newId(),
					baseRevision: this.vaultHeader.revision,
					header
				};
				const operation = await this.makeOperation('vault', 'vault', payload);
				await this.db.commit({ operation });
			});
			if (!ok) throw new Error('Could not stage the new passphrase.');
			await this.syncNow();
			if (this.vaultHeader.revision !== header.revision)
				throw new Error(
					'Passphrase change is staged. Reconnect to confirm its operation receipt; the previous local wrapper is retained.'
				);
			onStatus('Passphrase changed. Note and history ciphertext is unchanged.');
		} finally {
			this.isKeyMigrationRunning = false;
		}
	}
	getKeyChangeFailureMessage(error) {
		return error.message || 'Could not change the passphrase.';
	}
	forgetRememberedDeviceKey() {
		return this.db?.delete('protected', 'device').catch(() => {
			this.persistenceError = 'Could not forget this device.';
		});
	}

	async lock(manual = true) {
		this.manualLock = manual;
		this.cloudValidated = false;
		this.syncController?.abort();
		await this.localWork;
		if (manual && this.persistenceError) {
			this.manualLock = false;
			return false;
		}
		this.sessionGeneration += 1;
		this.encryptionState = null;
		this.noteKeys.clear();
		this.objectValues.clear();
		this.notes = [];
		this.drafts = {};
		this.localNotes = {};
		this.pendingPushes = {};
		this.conflicts = [];
		this.shares = [];
		this.draftSequences.clear();
		this.resetOpenNote();
		this.selectedNoteIds.clear();
		this.clientOnlyFolders.clear();
		this.unlockMode = this.vaultHeader ? 'unlock' : 'loading';
		this.sharingOpen = false;
		this.settingsOpen = false;
		this.changeKeyOpen = false;
		this.customCssOpen = false;
	}

	async buildPlaintextExport() {
		if (!this.encryptionState) throw new Error('Unlock before exporting.');
		await this.localWork;
		if (this.cloudValidated) await this.syncNow();
		const stored = await this.db.all('notes');
		const all = new Map([
			...stored.map((n) => [n.id, n]),
			...this.notes.map((n) => [n.id, { ...stored.find((s) => s.id === n.id), ...n }])
		]);
		const cached = await this.db.all('contents');
		const notes = [];
		for (const note of all.values()) {
			const versions = new Map(
				cached.filter((b) => b.logicalId === note.id).map((b) => [b.revision, b])
			);
			if (this.cloudValidated && note.revision) {
				let page = 1,
					more;
				do {
					const result = await this.api.content(this.scope.epoch, note.id, '', page++);
					result.items.forEach((b) => versions.set(b.revision, b));
					more = result.more;
				} while (more);
			}
			const pair = await this.keyFor(note.id);
			const summary = note.summary
				? await decryptObject(
						note.summary,
						pair.key,
						context(
							'summary',
							this.scope,
							note.id,
							note.summaryRevision || note.revision,
							note.generation || 1
						)
					)
				: { title: note.title || '' };
			notes.push({
				id: note.id,
				title: summary.title,
				folder:
					note.folder ||
					[...this.objectValues.values()].find(
						(o) => o.objectType === 'placement' && o.value.noteId === note.id
					)?.value.folder ||
					'Notes',
				deleted: !!note.deleted,
				versions: await Promise.all(
					[...versions.values()].map(async (b) => ({
						revision: b.revision,
						created: b.created || null,
						...(await decryptObject(
							b.ciphertext,
							pair.key,
							context('history', this.scope, note.id, b.revision, b.generation)
						))
					}))
				)
			});
		}
		return {
			format: 'jnote.plaintext-export',
			formatVersion: 2,
			exportedAt: now(),
			historyCoverage: this.cloudValidated ? 'complete' : 'downloaded-only',
			notes,
			drafts: this.drafts,
			settings: { customCss: this.customCss }
		};
	}

	async openSharing(noteId = this.currentNoteId) {
		this.sharingNoteId = noteId;
		this.sharingOpen = true;
		this.sharingError = '';
		try {
			if (!this.cloudValidated) throw new Error('Connect to manage public links.');
			const shares = [];
			let page = 1,
				more;
			do {
				const r = await this.api.send(
					'share-list',
					{ epoch: this.scope.epoch, page: page++ },
					'GET'
				);
				shares.push(...r.items);
				more = r.more;
			} while (more);
			this.shares = shares.filter((p) => p.sourceNote === noteId);
		} catch (error) {
			this.sharingError = error.message;
		}
	}
	async publishSnapshot(expires = '') {
		this.sharingBusy = true;
		this.sharingError = '';
		try {
			const note = this.notes.find((n) => n.id === this.sharingNoteId);
			if (!note?.revision || !note.hasContent || !this.cloudValidated)
				throw new Error('Commit and sync this note before publishing.');
			await this.syncNow();
			if (
				Object.values(this.pendingPushes).some(
					(p) => p.endpoint === 'commit' && p.objectId === note.id
				)
			)
				throw new Error('Wait for this note to sync before publishing.');
			const publication = await createPublication(
				note.title,
				note.content,
				this.encryptionState.key,
				this.scope,
				note.id,
				note.revision,
				expires
			);
			await this.savePublication(publication, '');
			await this.openSharing(note.id);
		} catch (error) {
			this.sharingError = error.message;
		} finally {
			this.sharingBusy = false;
		}
	}
	async savePublication(publication, baseRevision) {
		const payload = {
			epoch: this.scope.epoch,
			operationId: newId(),
			shareId: publication.shareId,
			action: 'publish',
			baseRevision,
			publication
		};
		const ok = await this.enqueueLocal(async () => {
			const operation = await this.makeOperation('share', publication.shareId, payload);
			await this.db.commit({ operation });
		});
		if (!ok) throw new Error('Could not persist publication work.');
		await this.syncNow();
		if (await this.db.get('outbox', payload.operationId))
			throw new Error('Publication is saved locally and waiting for cloud confirmation.');
	}
	async copyPublicationLink(publication, base = '') {
		try {
			await navigator.clipboard.writeText(
				await publicationLink(publication, this.encryptionState.key, this.scope, base)
			);
		} catch {
			this.sharingError = 'Could not copy the link. Clipboard access is required.';
		}
	}
	async republishSnapshot(publication) {
		this.sharingBusy = true;
		try {
			const note = this.notes.find((n) => n.id === publication.sourceNote);
			if (!note?.hasContent) throw new Error('Download the committed body first.');
			await this.syncNow();
			if (
				Object.values(this.pendingPushes).some(
					(p) => p.endpoint === 'commit' && p.objectId === note.id
				)
			)
				throw new Error('Sync this commit first.');
			await this.savePublication(
				await republish(
					publication,
					note.title,
					note.content,
					this.encryptionState.key,
					this.scope,
					note.revision
				),
				publication.revision
			);
			await this.openSharing(note.id);
		} catch (error) {
			this.sharingError = error.message;
		} finally {
			this.sharingBusy = false;
		}
	}
	async disablePublication(publication) {
		this.sharingBusy = true;
		try {
			const payload = {
				epoch: this.scope.epoch,
				operationId: newId(),
				shareId: publication.shareId,
				action: 'disable',
				baseRevision: publication.revision,
				revision: newId()
			};
			await this.enqueueLocal(async () => {
				await this.db.commit({
					operation: await this.makeOperation('share', publication.shareId, payload)
				});
			});
			await this.syncNow();
			await this.openSharing(publication.sourceNote);
		} catch (error) {
			this.sharingError = error.message;
		} finally {
			this.sharingBusy = false;
		}
	}

	async remoteObject(type, objectId) {
		let cursor = 0,
			remote;
		do {
			const page = await this.api.changes(this.scope.epoch, cursor);
			for (const c of page.changes)
				if (c.type === type && c.objectId === objectId) remote = c.value;
			cursor = page.cursor;
			if (!page.more) break;
		} while (true);
		return remote;
	}
	async compareConflict(item) {
		const payload = await decryptObject(
			item.ciphertext,
			this.encryptionState.key,
			context('outbox', this.scope, item.id)
		);
		if (item.endpoint === 'object') {
			const remote = await this.remoteObject('object', item.objectId);
			const local = await decryptObject(
				payload.ciphertext,
				this.encryptionState.key,
				context(`personal:${payload.objectType}`, this.scope, item.objectId, payload.revision)
			);
			const cloud = remote
				? await decryptObject(
						remote.ciphertext,
						this.encryptionState.key,
						context(`personal:${remote.objectType}`, this.scope, item.objectId, remote.revision)
					)
				: {};
			return {
				kind: 'object',
				local: { title: 'Local organization/settings', content: JSON.stringify(local, null, 2) },
				cloud: { title: 'Cloud organization/settings', content: JSON.stringify(cloud, null, 2) },
				remote
			};
		}
		if (item.endpoint === 'vault') {
			const bootstrap = await this.api.bootstrap();
			return {
				kind: 'vault',
				local: {
					title: 'Staged passphrase change',
					content:
						'Retry the staged wrapper after the current cloud wrapper. Note ciphertext will remain unchanged.'
				},
				cloud: { title: 'Cloud passphrase changed', content: 'Another vault wrapper is current.' },
				remote: bootstrap.vault
			};
		}
		if (item.endpoint === 'share') {
			let page = 1,
				remote,
				more;
			do {
				const result = await this.api.send(
					'share-list',
					{ epoch: this.scope.epoch, page: page++ },
					'GET'
				);
				remote = result.items.find((p) => p.shareId === item.objectId) || remote;
				more = result.more;
			} while (more);
			return {
				kind: 'share',
				local: { title: 'Local publication change', content: payload.action },
				cloud: {
					title: 'Cloud publication',
					content: remote?.enabled ? 'Enabled' : 'Disabled or unavailable'
				},
				remote
			};
		}
		if (payload.action === 'delete') {
			const remote = await this.remoteObject('note', item.objectId);
			return {
				kind: 'delete',
				local: {
					title: 'Local deletion',
					content: 'Retry deleting the current cloud revision and disabling its public links.'
				},
				cloud: {
					title: 'Cloud note',
					content: remote?.deleted ? 'Already deleted' : 'Changed on another device'
				},
				remote
			};
		}
		const local = await decryptObject(
			payload.ciphertext,
			(await this.keyFor(item.objectId)).key,
			context('history', this.scope, item.objectId, payload.revision)
		);
		let cursor = 0,
			remote;
		do {
			const page = await this.api.changes(this.scope.epoch, cursor);
			for (const c of page.changes)
				if (c.type === 'note' && c.objectId === item.objectId) remote = c.value;
			cursor = page.cursor;
			if (!page.more) break;
		} while (true);
		const result = await this.api.content(
			this.scope.epoch,
			item.objectId,
			remote.deleted ? '' : remote.revision
		);
		const body = remote.deleted ? result.items.at(-1) : result.items[0];
		const cloud = await decryptObject(
			body.ciphertext,
			(await this.keyFor(item.objectId)).key,
			context('history', this.scope, item.objectId, body.revision)
		);
		await this.db.put('contents', {
			...body,
			logicalId: item.objectId,
			generation: body.generation || 1,
			id: body.revision
		});
		return { kind: 'note', local, cloud, remote };
	}
	async retryConflict(item) {
		const comparison = await this.compareConflict(item);
		const dependent = (await this.db.all('outbox'))
			.filter((o) => o.endpoint === item.endpoint && o.objectId === item.objectId)
			.sort((a, b) => a.order - b.order);
		const replacements = [];
		let baseRevision = comparison.remote?.revision || '';
		for (const old of dependent) {
			const p = await decryptObject(
				old.ciphertext,
				this.encryptionState.key,
				context('outbox', this.scope, old.id)
			);
			p.operationId = newId();
			p.baseRevision = baseRevision;
			if (item.endpoint === 'object') {
				const value = await decryptObject(
					p.ciphertext,
					this.encryptionState.key,
					context(`personal:${p.objectType}`, this.scope, p.objectId, p.revision)
				);
				p.revision = newId();
				p.ciphertext = await encryptObject(
					value,
					this.encryptionState.key,
					context(`personal:${p.objectType}`, this.scope, p.objectId, p.revision)
				);
			}
			if (item.endpoint === 'commit') {
				if (comparison.remote?.deleted) continue;
				p.revision = newId();
			}
			baseRevision = p.header?.revision || p.publication?.revision || p.revision;
			replacements.push({
				old,
				p,
				operation: {
					...(await this.makeOperation(item.endpoint, item.objectId, p)),
					order: old.order
				}
			});
		}
		const ok = await this.enqueueLocal(async () => {
			await this.db.transaction(['outbox', 'objects'], 'readwrite', async (stores) => {
				for (const old of dependent) await stores.outbox.delete(old.id);
				for (const { p, operation } of replacements) {
					await stores.outbox.put(operation);
					if (item.endpoint === 'object')
						await stores.objects.put({
							id: p.objectId,
							objectId: p.objectId,
							objectType: p.objectType,
							revision: p.revision,
							ciphertext: p.ciphertext,
							deleted: p.deleted
						});
				}
			});
		});
		if (!ok) throw new Error('Could not persist conflict resolution.');
		await this.refreshPending();
		await this.syncNow();
	}

	async resolveConflictCopy(item) {
		const comparison = await this.compareConflict(item);
		// Preserve every dependent commit as a history chain on an independent note.
		const dependent = (await this.db.all('outbox'))
			.filter((o) => o.endpoint === 'commit' && o.objectId === item.objectId)
			.sort((a, b) => a.order - b.order);
		const copy = this.createNewNote(
			this.notes.find((n) => n.id === item.objectId)?.folder || 'Notes'
		);
		for (const work of dependent) {
			const p = await decryptObject(
				work.ciphertext,
				this.encryptionState.key,
				context('outbox', this.scope, work.id)
			);
			if (p.action === 'delete') continue;
			const value = await decryptObject(
				p.ciphertext,
				(await this.keyFor(item.objectId)).key,
				context('history', this.scope, item.objectId, p.revision)
			);
			if (!(await this.commitNote(copy.id, value.title, value.content)))
				throw new Error('Could not save conflict copy. Original work is retained.');
		}
		await this.enqueueLocal(async () => {
			await this.db.transaction(['outbox', 'notes'], 'readwrite', async (s) => {
				for (const work of dependent) await s.outbox.delete(work.id);
				await s.notes.put({ ...comparison.remote, id: item.objectId });
			});
		});
		await this.loadNotes();
		this.flushPendingPushes();
	}
	async destroy() {
		this.initialized = false;
		clearInterval(this.syncTimer);
		if (this.encryptionState && this.persistenceError)
			throw new Error('Save or export unsaved work before switching namespaces.');
		await this.lock(false);
		this.db?.close();
		this.db = null;
	}
}

export const jnote = new JNoteState();
