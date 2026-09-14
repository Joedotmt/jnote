import PocketBase, { BaseAuthStore } from 'pocketbase';
import { SvelteSet } from 'svelte/reactivity';
import {
  createEncryptionMetadata,
  decryptStringWithState,
  deriveEncryptionKey,
  encryptStringWithState,
  encryptionFormat,
  exportKey,
  extractEncryptionMetadata,
  importRememberedKey,
  isEncryptedEnvelopeString,
  normalizeEncryptionMetadata,
  randomBase64
} from './crypto.js';

const POCKETBASE_URL = 'https://joemt.fly.dev';
const DRAFTS_STORAGE_KEY = 'jnote.unsavedDrafts.v1';
const LOCAL_NOTES_STORAGE_KEY = 'jnote.localNotes.v1';
const PENDING_PUSHES_STORAGE_KEY = 'jnote.pendingPushes.v1';
const CUSTOM_CSS_STORAGE_KEY = 'jnote.customCss.v1';
const ENCRYPTION_METADATA_STORAGE_KEY = 'jnote.encryptionMetadata.v1';
const REMEMBERED_DEVICE_KEY_STORAGE_KEY = 'jnote.rememberedDeviceKey.v1';
const PUSH_RETRY_DELAY = 5000;
const EXPORT_FORMAT_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function makeQueueId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeLocalNoteId() {
  return `local-${makeQueueId()}`;
}

function escapePocketBaseFilterValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  return ['Notes', ...folders].sort((a, b) => (
    a === 'Notes' ? -1 : b === 'Notes' ? 1 : a.localeCompare(b)
  ));
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
  unlockBusy = $state(false);

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

  visibleNotes = $derived(this.notes.filter((note) => note.folder === this.currentFolder));
  currentNote = $derived(this.notes.find((note) => note.id === this.currentNoteId) ?? null);
  selectedCount = $derived(this.getSelectedNoteIds().length);

  syncStatus = $derived.by(() => {
    if (this.isKeyMigrationRunning) {
      return { idle: false, error: false, text: 'Changing encryption key...' };
    }

    const pendingCount = Object.keys(this.pendingPushes).length;
    const isSyncing = this.activePushes.size > 0;
    const hasWork = pendingCount > 0 || isSyncing;

    if (!hasWork) return { idle: true, error: false, text: 'All changes pushed' };
    if (this.hasPushError && !isSyncing) {
      return { idle: false, error: true, text: 'Push failed. Retrying...' };
    }

    return {
      idle: false,
      error: this.hasPushError,
      text: pendingCount > 1
        ? `Pushing ${pendingCount} commits to cloud...`
        : 'Pushing commit to cloud...'
    };
  });

  client = null;
  currentUser = null;
  encryptionState = null;
  encryptedStorePersistVersions = Object.create(null);
  pushRetryTimers = new Map();
  // The queue id, rather than just the note id, distinguishes work already in flight
  // from a newer commit or move waiting behind it.
  activePushIds = new Map();
  activeDirectMoves = new Set();
  activeDirectMoveNoteIds = new Set();
  noteLoadRequest = 0;
  initialized = false;
  accountReady = false;

  get pb() {
    if (!this.client) {
      const AccountStore = window.JoeAccounts?.AuthStore;
      this.client = new PocketBase(POCKETBASE_URL, AccountStore ? new AccountStore() : new BaseAuthStore());
    }
    return this.client;
  }

  async getAccountSession() {
    const accounts = window.JoeAccounts;
    if (!accounts?.AuthStore || typeof accounts.getSession !== 'function') {
      throw new Error('The account service is unavailable.');
    }

    const session = await accounts.getSession();
    if (
      session !== null
      && (!session?.token || !session?.record?.id || session.record.collectionName !== 'users')
    ) {
      throw new Error('The account service returned an invalid session.');
    }
    return session;
  }

  async refreshAccountSession() {
    if (!this.accountReady) return 'unchanged';

    let session;
    try {
      session = await this.getAccountSession();
      this.accountError = '';
    } catch (error) {
      console.warn('Could not check the account session:', error);
      this.accountError = 'Could not reach accounts.joe.mt. Try again when the account service is available.';
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

    if (this.beforeUnloadMessage()) return 'deferred';

    if (this.encryptionState) {
      try {
        await this.saveLocalStoresWithState(this.encryptionState);
      } catch (error) {
        console.warn('Could not save encrypted local notes before switching accounts:', error);
        this.accountError = 'Could not save local notes before switching accounts.';
        return 'deferred';
      }
    }

    this.unlockMode = 'auth-required';
    if (session) this.pb.authStore.save(session.token, session.record);
    else this.pb.authStore.clear();
    return 'changed';
  }

  getCurrentUserId() {
    return this.currentUser?.id || this.pb.authStore.record?.id || '';
  }

  getUserScopedStorageKey(storageKey) {
    const userId = this.getCurrentUserId();
    return userId ? `${storageKey}.${userId}` : storageKey;
  }

  getOwnedNotesFilter(extraFilter = '') {
    const userId = this.getCurrentUserId();
    const filters = [];
    if (userId) filters.push(`user = "${userId}"`);
    if (extraFilter) filters.push(extraFilter);
    return filters.join(' && ');
  }

  async loadCurrentUser() {
    if (!this.pb.authStore.isValid || !this.pb.authStore.record?.id) {
      throw new Error('JNote requires an authenticated PocketBase user.');
    }

    this.currentUser = await this.pb.collection('users').getOne(this.pb.authStore.record.id);
    return this.currentUser;
  }

  async markJnoteKeySet() {
    if (!this.currentUser || this.currentUser.is_jnote_key_set) return;

    this.currentUser = await this.pb.collection('users').update(this.currentUser.id, {
      is_jnote_key_set: true
    });

    if (this.pb.authStore.token && this.pb.authStore.record) {
      this.pb.authStore.save(this.pb.authStore.token, {
        ...this.pb.authStore.record,
        ...this.currentUser
      });
    }
  }

  getStoredEncryptionMetadata() {
    try {
      return normalizeEncryptionMetadata(
        JSON.parse(localStorage.getItem(this.getUserScopedStorageKey(ENCRYPTION_METADATA_STORAGE_KEY)) || 'null')
      );
    } catch (error) {
      console.warn('Could not read encryption metadata:', error);
      return null;
    }
  }

  saveEncryptionMetadata(metadata) {
    try {
      localStorage.setItem(
        this.getUserScopedStorageKey(ENCRYPTION_METADATA_STORAGE_KEY),
        JSON.stringify(metadata)
      );
    } catch (error) {
      console.warn('Could not save encryption metadata:', error);
    }
  }

  async getRemoteEncryptionMetadata() {
    const result = await this.pb.collection('jnote').getList(1, 1, {
      sort: '-updated',
      filter: this.getOwnedNotesFilter('deleted=false')
    });
    const record = result.items[0];
    if (!record) return null;
    return extractEncryptionMetadata(record.title) || extractEncryptionMetadata(record.folder);
  }

  async resolveEncryptionMetadata() {
    const storedMetadata = this.getStoredEncryptionMetadata();
    let remoteMetadata = null;

    try {
      remoteMetadata = await this.getRemoteEncryptionMetadata();
    } catch (error) {
      if (!storedMetadata) console.warn('Could not read remote encryption metadata:', error);
    }

    return remoteMetadata || storedMetadata || createEncryptionMetadata();
  }

  async unlockEncryption(passphrase, options = {}) {
    const metadata = await this.resolveEncryptionMetadata();
    const key = await deriveEncryptionKey(passphrase, metadata, {
      extractable: Boolean(options.rememberDevice)
    });
    this.encryptionState = { key, metadata };

    await this.validateEncryptionKey();
    this.saveEncryptionMetadata(metadata);
    if (options.rememberDevice) await this.rememberCurrentDeviceKey();
  }

  getRememberedDeviceKeyRecord() {
    try {
      const record = JSON.parse(
        localStorage.getItem(this.getUserScopedStorageKey(REMEMBERED_DEVICE_KEY_STORAGE_KEY)) || 'null'
      );
      const metadata = normalizeEncryptionMetadata(record?.metadata);
      if (
        !record
        || record.v !== encryptionFormat.version
        || record.alg !== encryptionFormat.algorithm
        || typeof record.key !== 'string'
        || !metadata
      ) {
        return null;
      }
      return { ...record, metadata };
    } catch (error) {
      console.warn('Could not read remembered device key:', error);
      return null;
    }
  }

  async unlockRememberedDevice() {
    const record = this.getRememberedDeviceKeyRecord();
    if (!record) return false;

    try {
      this.encryptionState = {
        key: await importRememberedKey(record.key),
        metadata: record.metadata
      };
      await this.validateEncryptionKey();
      this.saveEncryptionMetadata(record.metadata);
      return true;
    } catch (error) {
      this.encryptionState = null;
      this.forgetRememberedDeviceKey();
      console.warn('Remembered device key could not unlock notes:', error);
      return false;
    }
  }

  async rememberCurrentDeviceKey() {
    if (!this.encryptionState) return;

    try {
      localStorage.setItem(
        this.getUserScopedStorageKey(REMEMBERED_DEVICE_KEY_STORAGE_KEY),
        JSON.stringify({
          v: encryptionFormat.version,
          alg: encryptionFormat.algorithm,
          metadata: this.encryptionState.metadata,
          key: await exportKey(this.encryptionState.key),
          createdAt: now()
        })
      );
    } catch (error) {
      console.warn('Could not remember this device:', error);
    }
  }

  forgetRememberedDeviceKey() {
    try {
      localStorage.removeItem(this.getUserScopedStorageKey(REMEMBERED_DEVICE_KEY_STORAGE_KEY));
    } catch (error) {
      console.warn('Could not forget remembered device key:', error);
    }
  }

  async validateEncryptionKey(state = this.encryptionState) {
    let remoteSample = null;

    try {
      const result = await this.pb.collection('jnote').getList(1, 1, {
        sort: '-updated',
        filter: this.getOwnedNotesFilter('deleted=false')
      });
      remoteSample = result.items[0]?.title || result.items[0]?.folder;
    } catch (error) {
      console.warn('Could not validate passphrase against remote notes:', error);
    }

    if (remoteSample) {
      await decryptStringWithState(remoteSample, state);
      return;
    }

    const localSample = this.findEncryptedLocalStoreSample();
    if (localSample) await decryptStringWithState(localSample, state);
  }

  findEncryptedLocalStoreSample() {
    for (const key of this.getEncryptedObjectStoreKeys()) {
      const value = localStorage.getItem(this.getUserScopedStorageKey(key));
      if (isEncryptedEnvelopeString(value)) return value;
    }
    return null;
  }

  encryptString(plaintext) {
    return encryptStringWithState(plaintext, this.encryptionState);
  }

  decryptString(encryptedValue) {
    return decryptStringWithState(encryptedValue, this.encryptionState);
  }

  async loadEncryptedClientStores() {
    this.drafts = await this.getEncryptedObjectStore(DRAFTS_STORAGE_KEY);
    this.localNotes = await this.getEncryptedObjectStore(LOCAL_NOTES_STORAGE_KEY);
    this.pendingPushes = await this.getEncryptedObjectStore(PENDING_PUSHES_STORAGE_KEY);
  }

  async getEncryptedObjectStore(storageKey, state = this.encryptionState) {
    const scopedStorageKey = this.getUserScopedStorageKey(storageKey);
    const stored = localStorage.getItem(scopedStorageKey);
    if (!stored) return {};

    if (!isEncryptedEnvelopeString(stored)) {
      localStorage.removeItem(scopedStorageKey);
      return {};
    }

    const decrypted = await decryptStringWithState(stored, state);
    const parsed = JSON.parse(decrypted);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  getEncryptedObjectStoreKeys() {
    return [DRAFTS_STORAGE_KEY, LOCAL_NOTES_STORAGE_KEY, PENDING_PUSHES_STORAGE_KEY];
  }

  invalidateEncryptedObjectStorePersists() {
    this.getEncryptedObjectStoreKeys().forEach((storageKey) => {
      const scopedStorageKey = this.getUserScopedStorageKey(storageKey);
      this.encryptedStorePersistVersions[scopedStorageKey]
        = (this.encryptedStorePersistVersions[scopedStorageKey] || 0) + 1;
    });
  }

  async saveEncryptedObjectStoreNow(storageKey, value, state = this.encryptionState) {
    if (!state) throw new Error('Notes are locked.');

    const scopedStorageKey = this.getUserScopedStorageKey(storageKey);
    const snapshot = JSON.parse(JSON.stringify(value || {}));
    if (Object.keys(snapshot).length === 0) {
      localStorage.removeItem(scopedStorageKey);
      return;
    }

    localStorage.setItem(
      scopedStorageKey,
      await encryptStringWithState(JSON.stringify(snapshot), state)
    );
  }

  persistEncryptedObjectStore(storageKey, value) {
    if (!this.encryptionState) return;

    const scopedStorageKey = this.getUserScopedStorageKey(storageKey);
    const snapshot = JSON.parse(JSON.stringify(value || {}));
    const sequence = (this.encryptedStorePersistVersions[scopedStorageKey] || 0) + 1;
    this.encryptedStorePersistVersions[scopedStorageKey] = sequence;

    if (Object.keys(snapshot).length === 0) {
      localStorage.removeItem(scopedStorageKey);
      return;
    }

    encryptStringWithState(JSON.stringify(snapshot), this.encryptionState)
      .then((encrypted) => {
        if (this.encryptedStorePersistVersions[scopedStorageKey] !== sequence) return;
        localStorage.setItem(scopedStorageKey, encrypted);
      })
      .catch((error) => console.warn('Could not persist encrypted local store:', error));
  }

  async encryptNoteRecordPayload(title, folder = 'Notes') {
    return {
      title: await this.encryptString(title),
      folder: await this.encryptString(folder || 'Notes'),
      user: this.getCurrentUserId()
    };
  }

  async encryptNoteContentPayload(title, content) {
    return {
      title: await this.encryptString(title),
      content: await this.encryptString(content)
    };
  }

  readCustomCss() {
    try {
      return localStorage.getItem(CUSTOM_CSS_STORAGE_KEY) || '';
    } catch (error) {
      console.warn('Could not read custom CSS:', error);
      return '';
    }
  }

  saveCustomCss(css) {
    try {
      if (css) localStorage.setItem(CUSTOM_CSS_STORAGE_KEY, css);
      else localStorage.removeItem(CUSTOM_CSS_STORAGE_KEY);
    } catch (error) {
      console.warn('Could not save custom CSS:', error);
    }

    this.customCss = css;
    this.applyCustomCss(css);
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

  persistDrafts() {
    this.persistEncryptedObjectStore(DRAFTS_STORAGE_KEY, this.drafts);
  }

  persistLocalNotes() {
    this.persistEncryptedObjectStore(LOCAL_NOTES_STORAGE_KEY, this.localNotes);
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

  getPendingPush(noteId) {
    return this.pendingPushes[noteId] || null;
  }

  persistPendingPushes() {
    this.persistEncryptedObjectStore(PENDING_PUSHES_STORAGE_KEY, this.pendingPushes);
  }

  queuePush(noteId, title, content) {
    const note = this.notes.find((candidate) => candidate.id === noteId);
    const pending = this.getPendingPush(noteId);

    this.pendingPushes[noteId] = {
      id: makeQueueId(),
      action: note?.isLocalOnly || pending?.action === 'create' ? 'create' : 'update',
      noteId,
      title,
      content,
      folder: note?.folder || 'Notes',
      syncContent: true,
      syncFolder: Boolean(pending?.syncFolder),
      queuedAt: now()
    };
    this.persistPendingPushes();
    this.flushNotePush(noteId);
  }

  queueDelete(noteId) {
    this.pendingPushes[noteId] = {
      id: makeQueueId(),
      action: 'delete',
      noteId,
      queuedAt: now()
    };
    this.persistPendingPushes();
    this.flushNotePush(noteId);
  }

  hasUnfinishedPushes() {
    return Object.keys(this.pendingPushes).length > 0 || this.activePushes.size > 0;
  }

  schedulePushRetry(noteId) {
    if (this.pushRetryTimers.has(noteId)) return;
    const timer = window.setTimeout(() => {
      this.pushRetryTimers.delete(noteId);
      this.flushNotePush(noteId);
    }, PUSH_RETRY_DELAY);
    this.pushRetryTimers.set(noteId, timer);
  }

  async flushNotePush(noteId) {
    if (this.isKeyMigrationRunning) return;
    if (this.activePushes.has(noteId) || !this.pendingPushes[noteId]) return;

    this.activePushes.add(noteId);
    this.hasPushError = false;

    try {
      while (this.pendingPushes[noteId]) {
        const push = { ...this.pendingPushes[noteId] };
        this.activePushIds.set(noteId, push.id);

        if (push.action === 'delete') {
          await this.pb.collection('jnote').update(noteId, { deleted: true });
          if (this.pendingPushes[noteId]?.id === push.id) {
            delete this.pendingPushes[noteId];
            this.persistPendingPushes();
          }
        } else if (push.action === 'create') {
          const newNoteRecord = await this.pb.collection('jnote').create(
            await this.encryptNoteRecordPayload(push.title, push.folder || 'Notes')
          );
          const newVersion = await this.pb.collection('jnote_content').create({
            note: newNoteRecord.id,
            ...(await this.encryptNoteContentPayload(push.title, push.content))
          });

          const latestPending = this.pendingPushes[noteId]
            ? { ...this.pendingPushes[noteId] }
            : null;
          delete this.pendingPushes[noteId];
          this.persistPendingPushes();
          this.applyCreatePushResult(noteId, push, newNoteRecord, newVersion, latestPending);
        } else {
          const syncContent = push.syncContent !== false;
          const notePayload = {};
          if (syncContent) notePayload.title = await this.encryptString(push.title);
          if (push.syncFolder) {
            notePayload.folder = await this.encryptString(push.folder || 'Notes');
          }
          const updatedNote = await this.pb.collection('jnote').update(noteId, notePayload);
          const newVersion = syncContent
            ? await this.pb.collection('jnote_content').create({
                note: noteId,
                ...(await this.encryptNoteContentPayload(push.title, push.content))
              })
            : null;

          const dependentPush = this.pendingPushes[noteId];
          if (
            syncContent
            && dependentPush?.id !== push.id
            && dependentPush?.contentCoveredBy === push.id
          ) {
            // The content/history write completed, so the dependent move only needs
            // to update the folder. On failure this block is never reached and the
            // dependent push safely retries both pieces.
            const folderOnlyPush = { ...dependentPush, syncContent: false };
            delete folderOnlyPush.contentCoveredBy;
            this.pendingPushes[noteId] = folderOnlyPush;
            this.persistPendingPushes();
          }

          if (this.pendingPushes[noteId]?.id === push.id) {
            delete this.pendingPushes[noteId];
            this.persistPendingPushes();
            this.applyCloudPushResult(noteId, push, updatedNote, newVersion);
          }
        }
      }
    } catch (error) {
      console.error('Error pushing note:', error);
      this.hasPushError = true;
      this.schedulePushRetry(noteId);
    } finally {
      this.activePushIds.delete(noteId);
      this.activePushes.delete(noteId);
    }
  }

  flushPendingPushes() {
    Object.keys(this.pendingPushes).forEach((noteId) => this.flushNotePush(noteId));
  }

  applyCloudPushResult(noteId, push, updatedNote, newVersion) {
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (note && !this.pendingPushes[noteId]) {
      if (push.syncContent !== false) {
        note.title = push.title;
        note.content = push.content;
        if (newVersion) note.versionId = newVersion.id;
        note.hasContent = true;
      }
      if (push.syncFolder) note.folder = push.folder || 'Notes';
      note.updated = updatedNote.updated;
    }

    if (
      push.syncContent !== false
      && this.currentNoteId === noteId
      && !this.hasDraft(noteId)
      && !this.pendingPushes[noteId]
    ) {
      this.editorBaseline = { noteId, title: push.title, content: push.content };
    }
  }

  applyCreatePushResult(localNoteId, push, newNoteRecord, newVersion, latestPending) {
    const newNoteId = newNoteRecord.id;
    const index = this.notes.findIndex((note) => note.id === localNoteId);
    const originalFolder = push.folder || 'Notes';
    const latestFolder = latestPending?.folder || originalFolder;
    const contentChanged = Boolean(latestPending && latestPending.id !== push.id);
    const folderChanged = Boolean(latestPending && latestFolder !== originalFolder);
    // A move mutates the queued create's folder without changing its queue id. A
    // real Commit creates a new id, preserving the user's content-history intent.
    const latestChange = latestPending && (
      latestPending.action === 'delete' || contentChanged || folderChanged
    )
      ? latestPending
      : null;
    const reconciledNote = {
      id: newNoteId,
      title: latestChange?.title ?? push.title,
      folder: latestChange?.folder ?? push.folder ?? 'Notes',
      updated: newNoteRecord.updated,
      content: latestChange?.content ?? push.content,
      versionId: newVersion.id,
      hasContent: true,
      isLocalOnly: false
    };

    if (index !== -1) {
      this.notes[index] = { ...this.notes[index], ...reconciledNote };
    } else if (latestChange?.action !== 'delete') {
      this.notes.push(reconciledNote);
    }

    this.moveDraft(localNoteId, newNoteId);
    this.removeLocalNote(localNoteId);

    if (latestChange) {
      this.pendingPushes[newNoteId] = {
        ...latestChange,
        action: latestChange.action === 'delete' ? 'delete' : 'update',
        noteId: newNoteId,
        folder: latestFolder,
        syncContent: contentChanged,
        syncFolder: folderChanged
      };
      this.persistPendingPushes();
      this.flushNotePush(newNoteId);
    }

    if (this.currentNoteId === localNoteId) {
      this.currentNoteId = newNoteId;
      this.editorBaseline = {
        ...this.editorBaseline,
        noteId: newNoteId
      };
      this.editorRevision += 1;
    }

    if (this.selectedNoteIds.has(localNoteId)) {
      this.selectedNoteIds.delete(localNoteId);
      this.selectedNoteIds.add(newNoteId);
    }
    if (this.selectionAnchorId === localNoteId) this.selectionAnchorId = newNoteId;
    if (this.focusedNoteId === localNoteId) this.focusedNoteId = newNoteId;
    if (this.renamingNoteId === localNoteId) this.renamingNoteId = newNoteId;
    if (this.draggedNoteIds.includes(localNoteId)) {
      this.draggedNoteIds = this.draggedNoteIds.map((noteId) => (
        noteId === localNoteId ? newNoteId : noteId
      ));
    }

    if (this.folderModal.noteId === localNoteId) {
      this.folderModal = { ...this.folderModal, noteId: newNoteId };
    }
    if (this.folderModal.noteIds?.includes(localNoteId)) {
      this.folderModal = {
        ...this.folderModal,
        noteIds: this.folderModal.noteIds.map((noteId) => (
          noteId === localNoteId ? newNoteId : noteId
        ))
      };
    }
    if (this.folderModal.returnFocusNoteId === localNoteId) {
      this.folderModal = { ...this.folderModal, returnFocusNoteId: newNoteId };
    }
    if (this.contextMenu.noteId === localNoteId) this.closeContextMenu();
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.accountReady = false;
    this.customCss = this.readCustomCss();
    this.applyCustomCss();
    try {
      localStorage.removeItem('pocketbase_auth');
    } catch (error) {
      console.warn('Could not remove the old local account session:', error);
    }

    try {
      const session = await this.getAccountSession();
      this.accountError = '';
      try {
        for (const name of ['joe_mt_users_auth', 'joe_mt_users_auth_initialized']) {
          document.cookie = `${name}=; Max-Age=0; Domain=joe.mt; Path=/; Secure; SameSite=Lax`;
        }
      } catch (error) {
        console.warn('Could not remove the old shared account cookies:', error);
      }
      if (!session) {
        this.pb.authStore.clear();
        this.unlockMode = 'auth-required';
        return;
      }
      this.pb.authStore.save(session.token, session.record);
      await this.loadCurrentUser();
      if (this.currentUser.is_jnote_key_set && await this.unlockRememberedDevice()) {
        await this.finishEncryptionUnlock();
        return;
      }
    } catch (error) {
      console.warn('Could not initialize encrypted notes:', error);
      this.accountError = 'Could not check your account. Open accounts.joe.mt and try again.';
      this.unlockMode = 'auth-required';
      return;
    } finally {
      this.accountReady = true;
    }

    this.unlockMode = this.currentUser?.is_jnote_key_set ? 'unlock' : 'setup';
  }

  async submitEncryptionKey(passphrase, rememberDevice) {
    if (!passphrase || this.unlockBusy) return false;

    const mode = this.unlockMode;
    this.encryptionError = '';
    this.unlockBusy = true;

    try {
      await this.unlockEncryption(passphrase, { rememberDevice });
      if (mode === 'setup') await this.markJnoteKeySet();
      await this.finishEncryptionUnlock();
      return true;
    } catch (error) {
      this.encryptionState = null;
      this.drafts = {};
      this.localNotes = {};
      this.pendingPushes = {};
      this.unlockMode = mode;
      this.encryptionError = 'Could not unlock notes. Check the passphrase and try again.';
      console.error('Could not unlock encrypted notes:', error);
      return false;
    } finally {
      this.unlockBusy = false;
    }
  }

  async finishEncryptionUnlock() {
    await this.loadEncryptedClientStores();
    this.unlockMode = 'ready';
    await this.loadNotes();
    this.flushPendingPushes();
  }

  async loadNotes() {
    this.loadState = 'loading';

    try {
      const fetched = await this.pb.collection('jnote').getFullList({
        sort: '-updated',
        filter: this.getOwnedNotesFilter('deleted=false')
      });
      this.notes = await Promise.all(fetched.map(async (record) => ({
        id: record.id,
        title: await this.decryptString(record.title),
        folder: await this.decryptString(record.folder),
        updated: record.updated,
        hasContent: false
      })));
      this.mergeLocalNotesIntoNotes();
      this.mergePendingPushesIntoNotes();
      this.mergeOrphanLocalDraftsIntoNotes();
      this.loadState = 'ready';
    } catch (error) {
      this.loadState = 'error';
      console.error('Error loading notes:', error);
      throw error;
    }
  }

  mergeLocalNotesIntoNotes() {
    Object.values(this.localNotes).forEach((localNote) => {
      const index = this.notes.findIndex((note) => note.id === localNote.id);
      if (index !== -1) this.notes[index] = { ...this.notes[index], ...localNote };
      else this.notes.push({ ...localNote });
    });
  }

  mergeOrphanLocalDraftsIntoNotes() {
    Object.entries(this.drafts).forEach(([noteId, draft]) => {
      if (
        !noteId.startsWith('local-')
        || this.notes.some((note) => note.id === noteId)
        || this.pendingPushes[noteId]
      ) {
        return;
      }

      const note = {
        id: noteId,
        title: draft.title || '',
        folder: draft.folder || 'Notes',
        updated: draft.updatedAt || now(),
        content: draft.content || '',
        hasContent: true,
        isLocalOnly: true
      };
      this.notes.push(note);
      this.upsertLocalNote(note);
    });
  }

  mergePendingPushesIntoNotes() {
    Object.values(this.pendingPushes).forEach((push) => {
      if (push.action === 'delete') {
        this.notes = this.notes.filter((note) => note.id !== push.noteId);
        return;
      }

      const note = this.notes.find((candidate) => candidate.id === push.noteId);
      if (note) {
        if (push.syncContent !== false) {
          note.title = push.title;
          note.content = push.content;
          note.hasContent = true;
        }
        if (push.syncFolder) note.folder = push.folder || 'Notes';
      } else if (push.action === 'create') {
        this.notes.push({
          id: push.noteId,
          title: push.title,
          folder: push.folder || 'Notes',
          updated: push.queuedAt,
          content: push.content,
          hasContent: true,
          isLocalOnly: true
        });
      }
    });
  }

  getVisibleNoteIds() {
    return this.notes
      .filter((note) => note.folder === this.currentFolder)
      .map((note) => note.id);
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
      : (this.focusedNoteId && visibleIds.includes(this.focusedNoteId)
          ? this.focusedNoteId
          : visibleIds[0]);
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
    const closeDetail = options.closeDetail ?? ((globalThis.window?.innerWidth ?? 1024) <= 768);
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
    return buildFolderList(this.notes, this.clientOnlyFolders)
      .find((existing) => existing.toLocaleLowerCase() === requested.toLocaleLowerCase())
      || requested;
  }

  getSuggestedFolderName() {
    const names = new Set(
      buildFolderList(this.notes, this.clientOnlyFolders)
        .map((folder) => folder.toLocaleLowerCase())
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
    if (options.select !== false) this.selectFolder(resolved);
    return resolved;
  }

  canManageFolder(folder) {
    if (
      this.folderActionBusy
      || this.isKeyMigrationRunning
      || this.changeKeyBusy
      || this.activeDirectMoves.size > 0
    ) {
      return false;
    }
    const resolved = this.resolveFolderName(folder);
    return resolved !== 'Notes'
      && buildFolderList(this.notes, this.clientOnlyFolders).includes(resolved);
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
    const existingFolder = folderNames.find((folder) => (
      folder !== sourceFolder
      && folder.toLocaleLowerCase() === requestedFolder.toLocaleLowerCase()
    ));
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
        this.clientOnlyFolders.delete(sourceFolder);
        if (targetFolder !== 'Notes') this.clientOnlyFolders.add(targetFolder);
        if (this.currentFolder === sourceFolder) this.currentFolder = targetFolder;
        return true;
      }

      const results = await Promise.all(
        sourceNoteIds.map((noteId) => this.queueNoteFolderUpdate(noteId, targetFolder, {
          exactFolderName: true
        }))
      );
      const allMoved = results.every(Boolean);
      if (!this.notes.some((note) => note.folder === sourceFolder)) {
        this.clientOnlyFolders.delete(sourceFolder);
        if (this.currentFolder === sourceFolder) this.currentFolder = targetFolder;
      }
      if (!this.notes.some((note) => note.folder === targetFolder) && !destinationExisted) {
        this.clientOnlyFolders.delete(targetFolder);
      }
      return allMoved;
    } finally {
      this.folderActionBusy = false;
    }
  }

  deleteFolder(folder, confirmDelete = (message) => globalThis.confirm(message)) {
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

    if (folderNotes.length) this.deleteNotes(folderNotes.map((note) => note.id), () => true);
    this.clientOnlyFolders.delete(targetFolder);
    this.cancelFolderRename();
    this.closeContextMenu();
    if (this.currentFolder === targetFolder) this.selectFolder('Notes');
    return true;
  }

  markFolderBacked(folder) {
    const normalized = String(folder ?? '').trim().toLocaleLowerCase();
    if (!normalized) return;
    const clientFolder = [...this.clientOnlyFolders]
      .find((candidate) => candidate.toLocaleLowerCase() === normalized);
    if (clientFolder) this.clientOnlyFolders.delete(clientFolder);
  }

  rememberFolderIfEmpty(folder) {
    const normalized = String(folder ?? '').trim();
    if (!normalized || normalized === 'Notes') return;
    if (!this.notes.some((note) => note.folder === normalized)) {
      this.clientOnlyFolders.add(normalized);
    }
  }

  selectFolder(folder) {
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
        const query = await this.pb.collection('jnote_content').getList(1, 1, {
          filter: `note = "${escapePocketBaseFilterValue(noteId)}"`,
          sort: '-created'
        });
        if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return;

        note = this.notes.find((candidate) => candidate.id === noteId);
        if (!note) return;

        const latest = query.items[0];
        if (latest) {
          note.title = await this.decryptString(latest.title);
          note.content = await this.decryptString(latest.content);
          note.versionId = latest.id;
        } else {
          note.content = '';
        }
        note.hasContent = true;
      } catch (error) {
        if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return;
        this.noteLoadState = 'error';
        this.noteLoadError = 'Failed to load note';
        console.error('Error fetching note:', error);
        return false;
      }
    }

    if (request !== this.noteLoadRequest || this.currentNoteId !== noteId) return false;
    this.noteLoadState = 'ready';
    this.setEditorBaseline(note);
    this.editorRevision += 1;
    return true;
  }

  getCommittedNote(note) {
    const pending = this.getPendingPush(note.id);
    if (!pending || pending.action === 'delete' || pending.syncContent === false) return note;
    return { ...note, title: pending.title, content: pending.content };
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

    const baseline = this.editorBaseline.noteId === noteId
      ? this.editorBaseline
      : this.getCommittedNote(note);

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
    if (pending && pending.syncContent !== false) return pending.title ?? '';
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

  commitNote(noteId, title, content) {
    if (this.isKeyMigrationRunning || this.changeKeyBusy) return false;
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) return false;

    note.title = title;
    note.content = content;
    note.updated = now();
    note.hasContent = true;
    this.upsertLocalNote(note);
    this.clearDraft(noteId);

    if (this.currentNoteId === noteId) {
      this.editorBaseline = { noteId, title, content };
    }
    this.queuePush(noteId, title, content);
    return true;
  }

  commitCurrentNote() {
    if (!this.currentNoteId) return;
    const payload = this.getNoteCommitPayload(this.currentNoteId);
    if (!payload) return;
    this.commitNote(this.currentNoteId, payload.title, payload.content);
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
      selectedIds.length !== 1
      || this.isKeyMigrationRunning
      || this.changeKeyBusy
      || this.activeDirectMoveNoteIds.has(noteId)
    ) {
      return false;
    }

    const loaded = await this.openNote(noteId, { openDetail: false });
    if (
      !loaded
      || this.getSelectedNoteIds().length !== 1
      || !this.selectedNoteIds.has(noteId)
    ) {
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
    return selectedIds.length === 1
      && (!noteId || selectedIds[0] === noteId)
      && !this.isKeyMigrationRunning
      && !this.changeKeyBusy
      && !this.activeDirectMoveNoteIds.has(selectedIds[0]);
  }

  setRenameDraft(value) {
    if (!this.renamingNoteId) return;
    this.renameDraftValue = String(value ?? '');
  }

  commitRename(value = this.renameDraftValue) {
    const noteId = this.renamingNoteId;
    if (!noteId) return false;
    if (this.isKeyMigrationRunning || this.changeKeyBusy) return false;

    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) {
      this.cancelRename();
      return false;
    }

    const title = String(value ?? '').trim();
    const previousTitle = this.getDisplayTitle(note);
    const existingDraft = this.getDraft(noteId)
      ? { ...this.getDraft(noteId) }
      : null;
    const committed = this.getCommittedNote(note);
    this.cancelRename();

    if (title === previousTitle) return true;

    const pendingCreate = note.isLocalOnly && this.getPendingPush(noteId)?.action === 'create';
    if (pendingCreate) {
      const committedContent = committed.content || '';
      this.commitNote(noteId, title, committedContent);
      if (existingDraft && (existingDraft.content || '') !== committedContent) {
        this.saveDraft(noteId, title, existingDraft.content || '', note.folder || 'Notes');
      }
      if (this.currentNoteId === noteId) this.editorRevision += 1;
      return true;
    }

    if (note.isLocalOnly) {
      note.title = title;
      note.updated = now();
      if (existingDraft) {
        this.saveDraft(noteId, title, existingDraft.content || '', note.folder || 'Notes');
      }
      this.upsertLocalNote(note);
      if (this.currentNoteId === noteId) {
        this.editorBaseline = { ...this.editorBaseline, noteId, title };
        this.editorRevision += 1;
      }
      return true;
    }

    const committedContent = committed.content || '';
    this.commitNote(noteId, title, committedContent);
    if (existingDraft && (existingDraft.content || '') !== committedContent) {
      this.saveDraft(noteId, title, existingDraft.content || '', note.folder || 'Notes');
    }
    if (this.currentNoteId === noteId) this.editorRevision += 1;
    return true;
  }

  createNewNote(folder = this.currentFolder) {
    const targetFolder = this.resolveFolderName(folder);
    const note = {
      id: makeLocalNoteId(),
      title: '',
      folder: targetFolder,
      updated: now(),
      hasContent: true,
      content: '',
      isLocalOnly: true
    };
    this.notes.push(note);
    this.upsertLocalNote(note);
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

  deleteNotes(noteIds, confirmDelete = (message) => globalThis.confirm(message)) {
    if (this.isKeyMigrationRunning || this.changeKeyBusy) return false;
    const uniqueIds = [...new Set(noteIds || [])];
    const notesToDelete = uniqueIds
      .map((noteId) => this.notes.find((note) => note.id === noteId))
      .filter(Boolean);
    if (!notesToDelete.length) {
      this.closeContextMenu();
      return false;
    }

    const draftCount = notesToDelete.filter((note) => this.hasDraft(note.id)).length;
    const message = notesToDelete.length === 1
      ? `Delete "${this.getDisplayTitle(notesToDelete[0]) || '[untitled]'}"? This cannot be undone.`
      : `Delete ${notesToDelete.length} selected notes? This cannot be undone.${
          draftCount ? ` ${draftCount} ${draftCount === 1 ? 'has' : 'have'} unsaved changes.` : ''
        }`;
    if (!confirmDelete(message)) return false;

    const deletedIds = new Set(notesToDelete.map((note) => note.id));
    const sourceFolders = new Set(notesToDelete.map((note) => note.folder || 'Notes'));
    const currentWasDeleted = deletedIds.has(this.currentNoteId);
    this.notes = this.notes.filter((note) => !deletedIds.has(note.id));
    if (deletedIds.has(this.renamingNoteId)) this.cancelRename();

    notesToDelete.forEach((note) => {
      this.clearDraft(note.id);
      this.removeLocalNote(note.id);
      if (note.isLocalOnly && !this.activePushes.has(note.id)) {
        delete this.pendingPushes[note.id];
      } else {
        this.queueDelete(note.id);
      }
    });
    this.persistPendingPushes();
    sourceFolders.forEach((folder) => this.rememberFolderIfEmpty(folder));
    deletedIds.forEach((noteId) => this.selectedNoteIds.delete(noteId));
    const remainingSelectedIds = this.getSelectedNoteIds();
    if (deletedIds.has(this.selectionAnchorId)) {
      this.selectionAnchorId = remainingSelectedIds[0] || null;
    }
    if (deletedIds.has(this.focusedNoteId)) {
      this.focusedNoteId = remainingSelectedIds[0] || null;
    }
    this.draggedNoteIds = this.draggedNoteIds.filter((noteId) => !deletedIds.has(noteId));
    if (!this.draggedNoteIds.length) this.dragOverFolder = null;
    this.closeContextMenu();

    if (currentWasDeleted) {
      this.resetOpenNote();
      const fallbackId = remainingSelectedIds[0];
      if (fallbackId) {
        this.focusedNoteId = fallbackId;
        this.openNote(fallbackId);
      } else if ((globalThis.window?.innerWidth ?? 1024) <= 768) {
        this.detailOpen = false;
      }
    }
    return true;
  }

  async queueNoteFolderUpdate(noteId, folder, options = {}) {
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) return false;
    const requestedFolder = String(folder ?? '').trim();
    const targetFolder = options.exactFolderName
      ? (requestedFolder || 'Notes')
      : this.resolveFolderName(requestedFolder);
    if (note.folder === targetFolder) return true;

    if (note.isLocalOnly || this.pendingPushes[noteId]) {
      return this.moveNoteToFolder(noteId, targetFolder, options);
    }

    const sourceFolder = note.folder || 'Notes';
    note.folder = targetFolder;
    note.updated = now();
    if (this.drafts[noteId]) {
      this.drafts[noteId].folder = targetFolder;
      this.persistDrafts();
    }
    this.pendingPushes[noteId] = {
      id: makeQueueId(),
      action: 'update',
      noteId,
      folder: targetFolder,
      syncContent: false,
      syncFolder: true,
      queuedAt: now()
    };
    this.persistPendingPushes();
    this.flushNotePush(noteId);
    this.markFolderBacked(targetFolder);
    this.rememberFolderIfEmpty(sourceFolder);
    return true;
  }

  async moveNoteToFolder(noteId, folder, options = {}) {
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) return false;
    if (this.isKeyMigrationRunning) {
      alert('Wait for the encryption key change to finish before moving a note.');
      return false;
    }
    if (this.activeDirectMoveNoteIds.has(noteId)) {
      alert('This note is already being moved. Wait for that move to finish.');
      return false;
    }

    const sourceFolder = note.folder || 'Notes';
    const requestedFolder = String(folder ?? '').trim();
    const targetFolder = options.exactFolderName
      ? (requestedFolder || 'Notes')
      : this.resolveFolderName(requestedFolder);
    if (sourceFolder === targetFolder) return true;
    if (note.isLocalOnly) {
      note.folder = targetFolder;
      note.updated = now();
      this.upsertLocalNote(note);
      if (this.drafts[noteId]) {
        this.drafts[noteId].folder = targetFolder;
        this.persistDrafts();
      }
      if (this.pendingPushes[noteId]?.action === 'create') {
        this.pendingPushes[noteId].folder = targetFolder;
        this.persistPendingPushes();
      }
      this.markFolderBacked(targetFolder);
      this.rememberFolderIfEmpty(sourceFolder);
      return true;
    }

    const pending = this.pendingPushes[noteId];
    if (pending && pending.action !== 'delete') {
      const activePushId = this.activePushIds.get(noteId);
      const contentCoveredBy = activePushId === pending.id && pending.syncContent !== false
        ? activePushId
        : pending.contentCoveredBy;
      note.folder = targetFolder;
      note.updated = now();
      const queuedMove = {
        ...pending,
        id: makeQueueId(),
        folder: targetFolder,
        syncContent: pending.syncContent !== false,
        syncFolder: true,
        queuedAt: now()
      };
      if (contentCoveredBy) queuedMove.contentCoveredBy = contentCoveredBy;
      else delete queuedMove.contentCoveredBy;
      this.pendingPushes[noteId] = queuedMove;
      if (this.drafts[noteId]) {
        this.drafts[noteId].folder = targetFolder;
        this.persistDrafts();
      }
      this.persistPendingPushes();
      this.flushNotePush(noteId);
      this.markFolderBacked(targetFolder);
      this.rememberFolderIfEmpty(sourceFolder);
      return true;
    }

    const moveId = makeQueueId();
    this.activeDirectMoves.add(moveId);
    this.activeDirectMoveNoteIds.add(noteId);
    try {
      const updated = await this.pb.collection('jnote').update(noteId, {
        folder: await this.encryptString(targetFolder)
      });
      const liveNote = this.notes.find((candidate) => candidate.id === noteId);
      if (!liveNote) return true;
      liveNote.folder = targetFolder;
      liveNote.updated = updated.updated;
      if (this.drafts[noteId]) {
        this.drafts[noteId].folder = targetFolder;
        this.persistDrafts();
      }
      this.markFolderBacked(targetFolder);
      this.rememberFolderIfEmpty(sourceFolder);
      return true;
    } catch (error) {
      console.error('Error moving note:', error);
      alert('Failed to move note');
      return false;
    } finally {
      this.activeDirectMoves.delete(moveId);
      this.activeDirectMoveNoteIds.delete(noteId);
    }
  }

  async moveNotesToFolder(noteIds, folder) {
    const uniqueIds = [...new Set(noteIds || [])]
      .filter((noteId) => this.notes.some((note) => note.id === noteId));
    if (!uniqueIds.length) return false;
    if (uniqueIds.some((noteId) => this.activeDirectMoveNoteIds.has(noteId))) {
      alert('One or more selected notes are already being moved. Wait for that move to finish.');
      return false;
    }
    const targetFolder = this.resolveFolderName(folder);
    const moveCandidateIds = new Set(uniqueIds.filter((noteId) => (
      this.notes.find((note) => note.id === noteId)?.folder !== targetFolder
    )));
    const hasMove = moveCandidateIds.size > 0;
    const results = await Promise.all(
      uniqueIds.map((noteId) => this.moveNoteToFolder(noteId, targetFolder))
    );
    if (hasMove) {
      const movedIds = uniqueIds.filter((noteId, index) => (
        moveCandidateIds.has(noteId) && results[index] === true
      ));
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
      event.dataTransfer.setData('text/plain', `${noteIds.length} JNote ${noteIds.length === 1 ? 'note' : 'notes'}`);
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
    const noteIds = mode === 'move'
      ? this.getActionNoteIds(noteId)
      : (noteId ? [noteId] : []);
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

  fetchOwnedRemoteNoteRecords() {
    return this.pb.collection('jnote').getFullList({
      sort: '-updated',
      filter: this.getOwnedNotesFilter()
    });
  }

  fetchNoteContentRecords(noteId) {
    return this.pb.collection('jnote_content').getFullList({
      sort: 'created',
      filter: `note = "${escapePocketBaseFilterValue(noteId)}"`
    });
  }

  async decryptStoredField(value, state = this.encryptionState) {
    if (isEncryptedEnvelopeString(value)) return decryptStringWithState(value, state);
    return String(value ?? '');
  }

  async buildPlaintextExport() {
    if (!this.encryptionState) throw new Error('Notes are locked.');

    const remoteNotes = await this.fetchOwnedRemoteNoteRecords();
    const remoteNoteIds = new Set(remoteNotes.map((note) => note.id));
    const notes = [];

    for (const note of remoteNotes) {
      const versions = await this.fetchNoteContentRecords(note.id);
      notes.push({
        id: note.id,
        source: 'cloud',
        title: await this.decryptStoredField(note.title),
        folder: await this.decryptStoredField(note.folder),
        deleted: Boolean(note.deleted),
        created: note.created || null,
        updated: note.updated || null,
        versions: await Promise.all(versions.map(async (version) => ({
          id: version.id,
          created: version.created || null,
          updated: version.updated || null,
          title: await this.decryptStoredField(version.title),
          content: await this.decryptStoredField(version.content)
        })))
      });
    }

    Object.values(this.localNotes)
      .filter((note) => !remoteNoteIds.has(note.id))
      .forEach((note) => {
        notes.push({
          id: note.id,
          source: 'local',
          title: note.title || '',
          folder: note.folder || 'Notes',
          deleted: false,
          created: null,
          updated: note.updated || null,
          versions: [{
            id: `${note.id}-local-current`,
            created: null,
            updated: note.updated || null,
            title: note.title || '',
            content: note.content || ''
          }]
        });
      });

    return {
      format: 'jnote.plaintext-export',
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now(),
      notes,
      localChanges: {
        drafts: Object.entries(this.drafts).map(([noteId, draft]) => ({
          noteId,
          title: draft.title || '',
          content: draft.content || '',
          folder: draft.folder || 'Notes',
          updatedAt: draft.updatedAt || null
        })),
        pendingPushes: Object.values(this.pendingPushes).map((push) => ({
          action: push.action,
          noteId: push.noteId,
          title: push.title || '',
          content: push.content || '',
          folder: push.folder || 'Notes',
          queuedAt: push.queuedAt || null
        }))
      },
      settings: {
        customCss: this.readCustomCss()
      }
    };
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
      console.error('Could not export notes:', error);
      alert('Could not export notes. Check your connection and try again.');
      return false;
    } finally {
      this.exportBusy = false;
    }
  }

  async verifyStateMatchesUnlockedKey(candidateState) {
    const challenge = `${Date.now()}-${randomBase64(32)}`;
    const encryptedChallenge = await encryptStringWithState(challenge, this.encryptionState);
    const decryptedChallenge = await decryptStringWithState(encryptedChallenge, candidateState);
    if (decryptedChallenge !== challenge) throw new Error('Current key could not be verified.');
  }

  async getVerifiedCurrentKeyState(passphrase) {
    if (!this.encryptionState?.metadata) throw new Error('Notes are locked.');

    const metadata = this.encryptionState.metadata;
    const candidateState = {
      key: await deriveEncryptionKey(passphrase, metadata),
      metadata
    };
    await this.validateEncryptionKey(candidateState);
    await this.verifyStateMatchesUnlockedKey(candidateState);
    return candidateState;
  }

  async buildKeyMigrationPlan(oldState, newState) {
    const noteRecords = await this.fetchOwnedRemoteNoteRecords();
    const noteUpdates = [];
    const contentUpdates = [];

    for (const note of noteRecords) {
      const title = await this.decryptStoredField(note.title, oldState);
      const folder = await this.decryptStoredField(note.folder, oldState);
      noteUpdates.push({
        id: note.id,
        oldPayload: { title: note.title, folder: note.folder },
        newPayload: {
          title: await encryptStringWithState(title, newState),
          folder: await encryptStringWithState(folder, newState)
        }
      });

      const versions = await this.fetchNoteContentRecords(note.id);
      for (const version of versions) {
        const versionTitle = await this.decryptStoredField(version.title, oldState);
        const versionContent = await this.decryptStoredField(version.content, oldState);
        contentUpdates.push({
          id: version.id,
          oldPayload: { title: version.title, content: version.content },
          newPayload: {
            title: await encryptStringWithState(versionTitle, newState),
            content: await encryptStringWithState(versionContent, newState)
          }
        });
      }
    }

    return { noteUpdates, contentUpdates };
  }

  async restoreKeyMigrationPlan(plan) {
    const failures = [];

    for (const update of plan.noteUpdates) {
      try {
        await this.pb.collection('jnote').update(update.id, update.oldPayload);
      } catch (error) {
        failures.push({ collection: 'jnote', id: update.id, error });
      }
    }

    for (const update of plan.contentUpdates) {
      try {
        await this.pb.collection('jnote_content').update(update.id, update.oldPayload);
      } catch (error) {
        failures.push({ collection: 'jnote_content', id: update.id, error });
      }
    }
    return failures;
  }

  isJnoteContentUpdatePermissionError(error) {
    const message = String(error?.message || error?.response?.message || error?.data?.message || '');
    return error?.status === 403 && message.includes('Only superusers can perform this action');
  }

  createJnoteContentUpdatePermissionError(cause) {
    const error = new Error(
      'The server is blocking note-version re-encryption. Update permission is required on '
      + 'jnote_content records before the decryption key can be changed.'
    );
    error.code = 'JNOTE_CONTENT_UPDATE_FORBIDDEN';
    error.cause = cause;
    return error;
  }

  async applyKeyMigrationPlan(plan, onStatus = () => {}) {
    const total = plan.noteUpdates.length + plan.contentUpdates.length;
    const applied = { noteUpdates: [], contentUpdates: [] };
    let completed = 0;

    try {
      for (const update of plan.contentUpdates) {
        await this.pb.collection('jnote_content').update(update.id, update.newPayload);
        applied.contentUpdates.push(update);
        completed += 1;
        onStatus(`Re-encrypting cloud data... ${completed}/${total}`);
      }

      for (const update of plan.noteUpdates) {
        await this.pb.collection('jnote').update(update.id, update.newPayload);
        applied.noteUpdates.push(update);
        completed += 1;
        onStatus(`Re-encrypting cloud data... ${completed}/${total}`);
      }
    } catch (error) {
      if (
        applied.noteUpdates.length === 0
        && applied.contentUpdates.length === 0
        && this.isJnoteContentUpdatePermissionError(error)
      ) {
        throw this.createJnoteContentUpdatePermissionError(error);
      }

      onStatus('Migration failed. Restoring previous encryption...');
      const rollbackFailures = await this.restoreKeyMigrationPlan(applied);
      if (rollbackFailures.length > 0) {
        const rollbackError = new Error(
          'Key change failed and automatic rollback could not finish. Keep this app open and try again.'
        );
        rollbackError.cause = error;
        rollbackError.rollbackFailures = rollbackFailures;
        throw rollbackError;
      }

      const restoredError = new Error('Key change failed. Notes were restored to the previous key.');
      restoredError.cause = error;
      throw restoredError;
    }
  }

  async saveLocalStoresWithState(state) {
    this.invalidateEncryptedObjectStorePersists();
    await this.saveEncryptedObjectStoreNow(DRAFTS_STORAGE_KEY, this.drafts, state);
    await this.saveEncryptedObjectStoreNow(LOCAL_NOTES_STORAGE_KEY, this.localNotes, state);
    await this.saveEncryptedObjectStoreNow(PENDING_PUSHES_STORAGE_KEY, this.pendingPushes, state);
  }

  getRawEncryptedObjectStoreBackup() {
    return this.getEncryptedObjectStoreKeys().map((storageKey) => {
      const scopedStorageKey = this.getUserScopedStorageKey(storageKey);
      return { scopedStorageKey, value: localStorage.getItem(scopedStorageKey) };
    });
  }

  restoreRawEncryptedObjectStoreBackup(backup) {
    backup.forEach((item) => {
      try {
        if (item.value === null) localStorage.removeItem(item.scopedStorageKey);
        else localStorage.setItem(item.scopedStorageKey, item.value);
      } catch (error) {
        console.warn('Could not restore encrypted local store backup:', error);
      }
    });
  }

  async changeDecryptionKey(currentPassphrase, newPassphrase, onStatus = () => {}) {
    if (!this.encryptionState) throw new Error('Unlock notes before changing the key.');
    if (this.activePushes.size > 0 || this.activeDirectMoves.size > 0) {
      throw new Error('Wait for the current cloud write to finish, then try again.');
    }

    this.isKeyMigrationRunning = true;
    try {
      onStatus('Verifying current key...');
      const oldState = await this.getVerifiedCurrentKeyState(currentPassphrase);
      const rememberDevice = Boolean(this.getRememberedDeviceKeyRecord());
      const newMetadata = createEncryptionMetadata();
      const newState = {
        key: await deriveEncryptionKey(newPassphrase, newMetadata, { extractable: rememberDevice }),
        metadata: newMetadata
      };

      onStatus('Preparing encrypted records...');
      const plan = await this.buildKeyMigrationPlan(oldState, newState);
      onStatus('Re-encrypting cloud data...');
      await this.applyKeyMigrationPlan(plan, onStatus);

      onStatus('Saving encrypted local data...');
      const localStoreBackup = this.getRawEncryptedObjectStoreBackup();
      try {
        await this.saveLocalStoresWithState(newState);
      } catch (error) {
        this.restoreRawEncryptedObjectStoreBackup(localStoreBackup);
        onStatus('Local save failed. Restoring previous encryption...');
        const rollbackFailures = await this.restoreKeyMigrationPlan(plan);
        if (rollbackFailures.length > 0) {
          const rollbackError = new Error(
            'Key change failed and automatic rollback could not finish. Keep this app open and try again.'
          );
          rollbackError.cause = error;
          rollbackError.rollbackFailures = rollbackFailures;
          throw rollbackError;
        }

        const restoredError = new Error('Key change failed. Notes were restored to the previous key.');
        restoredError.cause = error;
        throw restoredError;
      }

      this.encryptionState = newState;
      this.saveEncryptionMetadata(newMetadata);
      if (rememberDevice) await this.rememberCurrentDeviceKey();
      else this.forgetRememberedDeviceKey();

      onStatus('Reloading notes...');
      try {
        await this.loadNotes();
      } catch (error) {
        console.warn('Key changed, but notes could not be reloaded immediately:', error);
      }
    } finally {
      this.isKeyMigrationRunning = false;
    }

    this.flushPendingPushes();
  }

  getKeyChangeFailureMessage(error) {
    if (error?.code === 'JNOTE_CONTENT_UPDATE_FORBIDDEN') {
      return 'Server permission needed: jnote_content records cannot be updated by this user, so note '
        + 'history cannot be re-encrypted. Add an update rule for owned note versions, then try again.';
    }
    if (error?.rollbackFailures?.length) {
      return 'Key change failed and automatic rollback could not finish. Keep this app open and try again.';
    }
    return error?.message || 'Could not change the key. Your notes are still using the previous key.';
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
      console.error('Could not change decryption key:', error);
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

  forgetThisDevice() {
    this.forgetRememberedDeviceKey();
    this.settingsOpen = false;
    alert('This browser will ask for your encryption passphrase next time.');
  }

  beforeUnloadMessage() {
    if (this.isKeyMigrationRunning) {
      return 'Your notes are being re-encrypted. Do not close the app yet.';
    }
    if (this.hasUnfinishedPushes()) {
      return 'Your latest commit is still pushing to the cloud.';
    }
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
      this.renamingFolder
      && this.folderRenameDraftValue.trim()
      && this.folderRenameDraftValue.trim() !== this.renamingFolder
    ) {
      return 'A folder rename is still being edited.';
    }
    return '';
  }

  destroy() {
    this.noteLoadRequest += 1;
    this.pushRetryTimers.forEach((timer) => clearTimeout(timer));
    this.pushRetryTimers.clear();
    this.initialized = false;
  }
}

export const jnote = new JNoteState();
