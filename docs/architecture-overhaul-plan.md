**JNote overhaul: Codex implementation runbook**

Audience: the Codex agent implementing this work. Follow the decisions, task order, and acceptance checks below. Update task status and record concrete discoveries in this document as implementation proceeds.

Current request: update this document only. Do not modify application behavior, provision collections, delete records, or deploy during this documentation task. When the user subsequently asks to implement this plan, execute it within the authorization recorded below.

**1. User decisions and authorization**

- The user is the only current JNote user and has exported all their notes.
- The user explicitly permits deleting all existing `jnote` and `jnote_content` records for this overhaul, including histories and soft-deleted records. This is a one-time hard reset. Routine deletion in the rebuilt application must still be a soft delete.
- The user permits creating new JNote collections and redesigning JNote schemas as needed. Reuse `jnote` and `jnote_content` and add the supporting collections below.
- Use a clean v2 start. Do not build ciphertext migration, mixed v1/v2 operation, legacy password/key conversion, or legacy note-store import.
- This instruction overrides the legacy-data compatibility requirements in `AGENTS.md` for this reset. Ongoing history, soft-delete, account-scoping, sync correctness, Custom CSS, routing, and account-service requirements remain.
- On the later implementation request, do not ask again whether old notes may be erased or required JNote collections created. Resolve the target server and collection identities from actual configuration before the already-authorized reset.
- This authorization concerns JNote. Do not delete account-service users, sessions, authentication configuration, unrelated collections, the exported file, or Custom CSS. Never perform a whole-database wipe.
- Do not automatically restore exported notes. A bulk importer is outside this release; retain export capability for new notes.
- Implement encrypted public links now. Prepare the encryption architecture for account sharing, but do not implement account invitations, recipient discovery/key exchange, or collaboration.

**2. Fixed scope and boundaries**

Deliver fast cached startup, deliberate offline/local-vault states, encrypted IndexedDB persistence, independent note keys, small encrypted server objects, ordered durable commits, atomic history writes, revision conflicts, incremental sync, consistent search of downloaded current bodies, encrypted personal organization/settings, inexpensive encryption-password changes, and read-only public snapshots with expiry, revocation, and manual republication.

Defer account sharing, public editing, automatic live publication, password-protected public links, real-time collaboration, and recovery-key UI. Reserve versioned wrapper extension points for account sharing/recovery; do not generate unused identity keys or ship unfinished controls.

Keep SvelteKit, Svelte 5, PocketBase, and the current account-site sign-in model. Preserve existing private-app DOM IDs/classes, global `style.css`, and unrelated mobile behavior.

| Location | Responsibility |
| --- | --- |
| `src/lib/jnote.svelte.js` | Shared reactive state; unlock/session, editor, commit, conflict, and publication workflows |
| `src/lib/crypto.js` | New versioned crypto primitives; no Svelte, DOM, storage, or PocketBase |
| `src/lib/vault.js` | Vault/note/share key operations and serialization |
| `src/lib/localDb.js` | User/epoch-scoped IndexedDB stores and local transactions |
| `src/lib/sync.js` | Nonreactive outbox/transport helpers coordinated by `JNoteState` |
| `src/lib/publicSharing.js` | Snapshot encryption, owner management wrappers, publication transport |
| `src/lib/accounts.js` | Account bridge/handoff and centralized server/account URLs; plain-Node safe |
| `src/lib/search.js` | Pure search/index decision helpers |
| `src/routes/+page.svelte` | Private-app lifecycle and SvelteKit mobile-panel history |
| `src/routes/s/[shareId]/+page.svelte` | Minimal public viewer, without private-app initialization |
| Authoritative server project | Reproducible schema, custom endpoints, authorization, transactions, and cutover tooling |

Find the authoritative server source before editing backend code. If none exists, add a reproducible backend package here rather than relying on undocumented dashboard configuration. Inspect the deployed PocketBase version before choosing hook/API syntax. If actual credentials/access are unavailable, finish independent code/tests/build and report the specific missing access; do not pretend backend changes happened.

**3. Crypto and key decisions**

Active storage after reset is v2 only. Reject legacy/unknown payloads with an update/reset-required error; never fall back to plaintext. The old plaintext export is a standalone file, not an active legacy store.

| Key | Decision |
| --- | --- |
| Unlock key | Local PBKDF2-SHA-256 from encryption passphrase, random 16-byte salt, initially 310,000 iterations |
| Account vault key | Random 256-bit AES key; encrypted by unlock key; independent of passphrase |
| Note key | Independent random 256-bit AES key per note/key generation; owner copy wrapped by vault key |
| Public-share key | Independent random 256-bit AES key per link; encrypts a separate publication |
| Device key | Non-extractable AES wrapping key in IndexedDB protecting a remembered local vault-key copy; verify browser support |
| Future recipient/recovery keys | Wrapper extension point only; no identity/invitation/recovery implementation now |

Use AES-256-GCM with a fresh random 12-byte nonce for every encryption. Never derive note keys from passwords or IDs. Do not lower password derivation cost for startup speed. Remembered devices use protected local key material without repeating PBKDF2.

Specify canonical authenticated additional data: deterministic JSON arrays containing format, purpose, owner/scope, dataset epoch, immutable object ID, revision ID, and key generation as applicable. Test distinct contexts for vault/key wrappers, note summaries, histories, drafts/outbox, personal objects, and public publications. Ciphertext must fail authentication when transplanted to another identity or object purpose. This does not by itself prevent replay of an entire old state; revisions/checkpoints provide the initial stale-state check.

Use secure random UUIDs for logical note IDs, revisions, and operation IDs. Logical note identity exists before offline creation and is independent of PocketBase IDs. Preserve local-to-server ID reconciliation across drafts, queue entries, selection, and editor state.

Wrappers carry version, scheme, protected key ID/generation, recipient kind/ID, scope, and ciphertext. Implement owner-vault note grants now. Reserve future recipient-public-key wrappers without accepting unimplemented schemes. Adding a future recipient wrapper must not require rewriting note ciphertext.

Encryption-password change stages a new wrapper of the same vault key under a new salt/derived key, commits it using revision checks and an operation ID, and recovers interruption using the operation receipt. Never make both local and remote key wrappers unusable on failure. Note/history ciphertext stays unchanged. Rotation after compromise is a separate operation; rewrapping does not erase exposed keys or old backups.

Keep raw key bytes short-lived. IndexedDB/non-extractable keys do not prevent malicious same-origin scripts from using accessible key material; do not claim otherwise.

**4. Server model and API contracts**

Keep the authentication collection unchanged and retain owner scoping even with one real user. Use a second test identity to verify isolation.

| Collection | Required logical fields/purpose |
| --- | --- |
| `jnote_vaults` | Unique owner, epoch, format/minimum client, wrapped vault key/KDF parameters, vault revision, change sequence |
| `jnote` | Owner, epoch, unique logical note ID, head revision, key generation, encrypted summary, soft-delete marker |
| `jnote_content` | Owner/note reference, epoch, unique revision ID, parent revision, operation ID, key generation, encrypted title/body |
| `jnote_key_grants` | Owner/note/epoch/generation, wrapper scheme, recipient kind/ID, wrapped key |
| `jnote_private_objects` | Owner, epoch, opaque object ID/type, revision, encrypted folder/placement/preferences |
| `jnote_operations` | Owner/epoch, unique operation ID, request fingerprint, resulting IDs/revisions/receipt |
| `jnote_changes` | Owner/epoch, unique monotonic sequence, object/type/revision or deletion marker |
| `jnote_public_shares` | Owner/epoch, random share ID, source note/revision, publication revision, expiry, enabled flag, ciphertext, owner-wrapped share key |

Use individual encrypted folder/placement/settings records, not one large account manifest. Summaries are separate from history bodies for quick list loading. Folder placement is personal and excluded from sharing. Synchronize arbitrary Custom CSS without breaking current private-app selector behavior.

Persist operation receipts for the dataset lifetime. Reject reuse of an operation ID with different request contents. Define server indexes/uniqueness constraints, not only client checks.

Implement a versioned JNote API namespace with these operations:

- Authenticated bootstrap: protocol/minimum client, server dataset epoch, vault header, current owner metadata/checkpoint. No vault means encryption setup regardless of obsolete `is_jnote_key_set`.
- Authenticated vault create/rewrap: unique transactional setup or idempotent revision-checked wrapper replacement; encrypted key material only.
- Authenticated commit: note create/update/delete, base revision and epoch checks, atomic history/head/change/receipt, generated-ID reconciliation.
- Authenticated personal-object mutation: idempotent revision-checked encrypted organization/settings edits.
- Authenticated changes/content: paginated change cursor, owner-scoped current/history ciphertext.
- Authenticated share create/update/disable/list: owner management with operation/publication revisions.
- Anonymous share read: exact enabled/unexpired publication lookup; no enumeration, history, management wrappers, owner profiles, or anonymous writes.

Explicitly validate authentication, ownership, epoch, action, format, referenced records, size limits, base revision, and operation uniqueness in custom handlers. Close generic write paths that bypass these checks. Collection rules do not replace authorization inside custom handlers.

Encrypt private app content and organization. Operational metadata still includes identities, ownership, sizes, counts/relationships, revisions, timing, deletion markers, and expiry. Account-service profile data stays outside this redesign.

**5. Local persistence, startup, and sync**

Use IndexedDB scoped by user ID and dataset epoch. Persist encrypted summaries, downloaded bodies/history, drafts, an ordered outbox, personal objects, key wrappers, checkpoints, and publication work. Keep decrypted data/search indexes in memory while unlocked; encrypt any persisted index. Never log titles, snippets, plaintext, or secrets.

Local commit: snapshot content, encrypt, then atomically store its committed revision, remove the corresponding draft, and append durable outbox work. Report local success only after the transaction succeeds. Retain every explicit content commit and per-note order. Coalesce draft saves separately and preserve encryption sequence guards.

Server commit: authenticate, validate owner/epoch, detect duplicate operation, compare base revision, then atomically write `jnote_content`, note head, change sequence, and receipt. Initial note/history creation is also atomic. Folder-only edits do not produce fake content commits. Routine deletes set `jnote.deleted` and disable its public shares transactionally.

A stale base produces a conflict, not silent overwrite or endless retry. Retain encrypted local content and offer comparison, merge/recommit, or conflict copy. Preserve dependent offline commits during resolution. Use one sync leader/database lease across tabs; server idempotency remains authoritative.

Fetch changes through a monotonic cursor, apply data/checkpoint in one local transaction, and catch up after reconnect. Realtime only prompts cursor fetching. Specify consistent initial bootstrap and expired-cursor recovery; resync preserves current-epoch drafts/outbox. Hydrate current bodies in bounded background batches; fetch old history on demand.

Separate vault locked/setup/unlocked state from cloud checking/online/offline/signed-out/unsupported state. A known remembered account can unlock its cache while cloud checks run. First sign-in still uses the account site. Upload only after validated authentication. On account change stop old sync, preserve encrypted work, clear plaintext/index/key references, and select the new namespace.

Render cached summaries and local overlays before remote retrieval. Prioritize selected/recent bodies. Show actual unlock/download/offline/sync/conflict/persistence-error states instead of one broad unlocking message. Handle quota failures/eviction visibly; do not mark failed writes durable. Lock discards plaintext; forget-device removes its remembered wrapper/key. Preserve current-epoch unsynced work unless explicitly discarded.

Search all downloaded current bodies, independent of which notes were opened. Update for drafts/commits/incoming changes/deletions; show incomplete coverage during first hydration. Keep `search.js` pure and all list navigation through `computeVisibleNotes`, `visibleNotes`, or `getVisibleNoteIds`.

**6. Public-link implementation**

Use `https://notes.joe.mt/s/<share-id>#<share-key>` with deployment/base-path awareness. Generate independent 32-byte random ID/key values encoded as URL-safe base64. Never expose the private note key or vault key.

Encrypt only the selected committed title/body as a separate publication. Exclude private folders, drafts, old history, and private keys. Store an owner-vault-wrapped share key so another unlocked owner device can reconstruct/manage links. Never send the raw share key to the server.

Ship read-only snapshots, create/copy/manage, optional expiry, disable, and manual republication. Republishing creates a new publication revision and nonce; replacing a link creates a new ID/key. Multiple links remain independent. Automatic live publication is deferred.

Build a minimal viewer/shell without account bootstrap, remembered vaults, user Custom CSS, or third-party JavaScript. Select public bootstrap in `src/app.html`/layout before such scripts run. Consume/validate the fragment early, hold it in memory, and strip it before later scripts. Keep share parsing separate from account `joe_session` handoff and keep later navigation compatible with SvelteKit. Reload after removal requires the original full link; do not silently persist the secret to hide that behavior.

Render text safely, self-host viewer assets, apply CSP, and return public ciphertext with no-store caching. Keep PocketBase/account traffic outside the service worker. Do not leak secrets/plaintext through API parameters, logs, telemetry, page titles, or previews. Handle missing/bad keys, unavailable/expired/disabled links, network errors, and decryption errors without exposing private note/owner details. Rate-limit public lookups.

Verify direct navigation/refresh, trailing slashes, GitHub Pages fallback, custom domain, and repository base paths. Public viewing needs no account. Revocation stops future downloads but cannot recall received copies. The full link can be forwarded or retained by the chat/email service where it is pasted.

**7. Execution checklist, in dependency order**

1. [ ] Inspect working-tree changes and guidance; locate server source/access/version/schema/rules and the sole owner ID. Preserve unrelated work.
2. [ ] Collect a short startup baseline on available browsers. Use generated small/large libraries; do not spend a phase rebuilding the old app for elaborate benchmarking.
3. [ ] Specify v2 envelopes/AAD/wrappers, IDs/revisions/epochs, local states, endpoints/indexes/errors in schema/code fixtures. Record resolved details here.
4. [ ] Implement/test pure crypto/vault helpers: note/share isolation, wrappers, passphrase rewrap, and device remembrance.
5. [ ] Implement/test transactional local storage, drafts/outbox, sequence protection, restart/epoch/account isolation, and multi-tab coordination.
6. [ ] Implement/test schema, custom authenticated mutations, receipts/conflicts, bootstrap/content/change feed, and epoch guards against a disposable database.
7. [ ] Wire `JNoteState` to the new helpers; remove legacy active reads/writes/queue coalescing. Preserve UI, reconciliation, history, and routine soft deletes.
8. [ ] Implement cached startup, offline/error states, lock/forget-device, password change, and current-body hydration. Validate keys through the vault wrapper, not a remote sample note.
9. [ ] Implement encrypted organization/settings, preserve existing Custom CSS, update export for new notes, and complete local search/coverage.
10. [ ] Implement snapshot publishing/management endpoints and `/s/[shareId]` viewer, including expiry, manual republishing, independent disable, and source-note deletion.
11. [ ] Run focused integration/security-boundary tests and required app checks. Build the release and prepare the concrete reset against the actual server before deleting production data.
12. [ ] On the later implementation/deployment request, perform the authorized cutover below when access is available; verify live private app and logged-out public viewing.
13. [ ] Update README/runbook with actual backend location, format/API decisions, epoch/reset receipt, completed checks, and live evidence. Report exact remaining blockers without marking unfinished work complete.

Build the target once against clean test data. Do not ship interim v1 enhancements or implement old ciphertext/history conversion.

**8. One-time fresh-start cutover**

Write a scoped rerunnable reset script/command. It must identify the configured PocketBase instance, sole owner, allowlisted JNote collections, and target epoch. Do not perform broad deletions from memory.

1. Put JNote writes into maintenance mode and disable legacy direct-write rules before deleting anything. Leave the account service available. Old tabs/installed app versions must not resurrect notes.
2. Ensure target code/schema/reset tooling passed disposable-database checks. Preserve the user's export. Take an available server snapshot if straightforward, but do not make an additional note export/migration a prerequisite after the user's explicit export/reset authorization.
3. Hard-delete old `jnote_content`, then `jnote` records in dependency order. Clear only known JNote support/test data involved in this cutover. Preserve users/unrelated collections. Redesign the emptied schemas and create supporting collections/indexes/rules.
4. Set a fresh random dataset epoch and minimum protocol in server JNote control/configuration state, discoverable before a vault exists. Store the same epoch in the vault at setup. Do not use old note samples or account key flags for setup detection.
5. Deploy/enable v2 endpoints and compatible client. Restore only the new authorized mutation paths. Legacy writes remain blocked.
6. New-client startup retires explicit known legacy note/draft/push/encryption-metadata/remembered-key storage entries for this user. Do not import, replay, or rewrap them. Preserve `jnote.customCss.v1` and unrelated account/browser storage. Never call blanket `localStorage.clear()`.
7. If a v2 cache has a different epoch, stop its uploader and retire that namespace. Require fresh bootstrap/setup/unlock; never retag old outbox work into the new epoch. This also protects devices offline during any later reset.
8. Show fresh encryption setup, create the vault/password wrapper through the new workflow, and verify live note commit/reopen, passphrase change, search, offline restart/reconnect, and public links.

Reject a wrong instance/owner, unexpected collection, or stale epoch. A pre-use rerun converges on the same empty target epoch. Record completion so ordinary redeployment cannot wipe newly created v2 data. Any later wipe needs a separate explicit reset invocation/epoch; this authorization is not an evergreen erase-on-deploy policy.

After new data exists, fix defects forward. Do not silently restore old snapshots over new notes. No mixed-format rollout, migration lease, legacy history conversion, or migration rollback window is required.

**9. Acceptance checks**

- Crypto: wrong keys/password, tampering, unknown formats, swapped identity/purpose, fresh nonces, independent note/share keys, wrappers, and password change leaving note/history ciphertext unchanged.
- Local: encrypted-at-rest inspection, failed transaction/quota, asynchronous sequencing, restart with drafts/outbox, preservation of every explicit commit, tab concurrency, account/epoch isolation.
- Server: atomic note/history, failed-write rollback, retry after timeout/success, reused operation ID with different request rejected, stale-revision conflicts, forged ownership, client minimum, stale epoch, direct-write bypass denied.
- Sync: ordered offline commits, reconnect, atomic checkpoint application, consistent bootstrap, expired cursor recovery, create/upload moves, reconciliation, soft deletes across devices.
- Cutover: only allowlisted JNote records removed; users/export/CSS survive; old work cannot resurrect notes; offline old devices are rejected; redeployment does not reset again.
- Search/settings/export: results independent of opened notes, coverage state, draft/update/delete reflection, persisted empty folders/settings, CSS compatibility, new-note history export.
- Public: logged-out access, key absent from network/logs, no private key/history/folder access, wrong/missing key states, expiry/disable, independent links, safe rendering, manual republication, delete disabling shares, hosting/base-path behavior.
- UI: available desktop/mobile browsers, fresh/remembered/offline startup, account switch/lock, keyboard/pane behavior, public private-app selectors.

After application changes run `npm run check`, `npm test`, and `npm run build`, plus meaningful backend/browser integration checks above. Compare warm startup with the baseline and report measurements/limits; fresh downloads and passphrase derivation still take time.

Completion requires client, backend, cutover, and links working together. If real access is unavailable, finish code/tests/build and state the exact outstanding deployment step. Never fabricate deletion or live-test success.

**10. Remaining contributor contracts**

Keep URLs centralized in plain-Node-safe `accounts.js`; preserve bridge preference, account-site-only sign-in, unsupported origins, allowlist alignment, early one-time token stripping, `authRefresh`, and non-async OAuth popup handlers where applicable. Browser/authenticated accesses stay in lifecycle/user-triggered methods.

Keep shared workflows in `jnote.svelte.js`, local UI behavior in components, crypto/search/swipe helpers pure, and the list definition centralized. Keep mobile panel history in `+page.svelte` through SvelteKit navigation/page state. Preserve `interactive-widget=resizes-content`, keyboard pane top/bottom variables, global CSS, and existing private-app IDs/classes.

The authorized reset permits removing obsolete v1 crypto/store readers and using new v2 storage names. New stores remain user/epoch scoped. Sequence protection and pending-create reconciliation still apply to the replacement design. The service worker caches the app shell only and never intercepts account/PocketBase responses.

**11. Future account-sharing extension contract**

Owner wrappers and note payload encryption are independent. A later verified recipient-public-key wrapper can grant one note without rewriting its ciphertext. Note key generations support excluding earlier history and rotating future access.

Do not implement recipient keys/invites now. Later work must cover authenticated key discovery, fingerprints/key changes, permissions on every endpoint, signed collaborative authorship as required, access-change sync, and rotation. Decryption access is not permission to upload; revocation cannot erase prior knowledge. Private folder placement remains personal.

**12. Execution notes to fill during implementation**

- Status: ready for implementation; this document edit performs no app/backend reset.
- Authoritative backend/version/access: discover in task 1.
- Deployment instance/sole owner: resolve from configuration and authenticated administrative inspection.
- Final envelope/AAD/API/index decisions: record from implemented code/schema fixtures.
- Dataset epoch/reset receipt: record after actual cutover only.
- Validation/build/live tests: record actual outcomes as work completes.

Reference documentation: [PocketBase transactions](https://pocketbase.io/docs/js-database/), [access rules](https://pocketbase.io/docs/api-rules-and-filters/), [realtime](https://pocketbase.io/docs/api-realtime/), [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), and [URL fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment). Check deployed server compatibility before implementation.
