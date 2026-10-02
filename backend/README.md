# JNote v2 backend

This directory is the reproducible backend package. It extends the existing PocketBase instance without replacing the `users` collection or the account service. Client protocol is 2. The live `joemt` server remains on **PocketBase 0.28.2**; integration and cutover suites pass against its exact binary and the SHA-256-verified **0.40.3** development binary. No server version upgrade was performed.

## Install and test

```sh
npm run backend:install
POCKETBASE_BIN="$PWD/backend/.bin/pocketbase" npm run test:backend
POCKETBASE_BIN="$PWD/backend/.bin/pocketbase" npm run test:cutover
```

The installer verifies SHA-256 digests from the [official immutable release](https://github.com/pocketbase/pocketbase/releases/tag/v0.40.3). The tests use new temporary databases, two test identities, and no production credentials. Schema auto-generation is disabled. Source hooks are `pb_hooks/`; the non-destructive schema migration is `pb_migrations/1790899200_jnote_v2.js`. A legacy schema is refused by the migration.

For a fresh development instance:

```sh
JNOTE_HOOKS_DIR="$PWD/backend/pb_hooks" backend/.bin/pocketbase serve --automigrate=false \
  --dir=backend/pb_data --hooksDir=backend/pb_hooks --migrationsDir=backend/pb_migrations
```

## API and encryption

All private requests require a refreshed `users` authentication token and protocol 2. Mutations require the current epoch and a UUID operation ID. Request fingerprints and receipts persist for the dataset lifetime. Duplicate requests return the receipt; altered requests with the same operation ID return 409. Generic collection reads/writes are locked. Superusers retain administrative access.

| Endpoint under `/api/jnote/v2/` | Method | Contract                                                                                            |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `bootstrap`                     | GET    | Protocol/minimum client, epoch, vault header, consistent checkpoint; absence of a vault means setup |
| `vault`                         | POST   | Revision-checked setup/rewrap of the vault header                                                   |
| `commit`                        | POST   | Logical UUID note ID; create/update/delete; base/new revision; atomic history/head/change/receipt   |
| `object`                        | POST   | Individual encrypted folder, placement, or settings; revision checks                                |
| `changes`                       | GET    | Owner/epoch cursor; at most 100 changes; checkpoint committed locally with objects                  |
| `content`                       | GET    | Owner-scoped logical note and optional exact revision; paginated history ordered by sequence        |
| `share-list`                    | GET    | Owner-only publication management, pages of 100                                                     |
| `share`                         | POST   | Publish/republish/disable with publication base revision and operation receipt                      |
| `public/{shareId}`              | GET    | Anonymous exact enabled/unexpired lookup; ciphertext and publication revision only, no-store        |

409 is a revision/epoch conflict, 410 requires rebuilding the feed from cursor zero, 426 requires a client update, 401/403 deny authentication/ownership, and 404 hides unavailable objects/publications. Change records are retained for the dataset lifetime, so cursor recovery rebuilds heads while preserving local drafts, histories and outbox. Polling prompts incremental fetching every ten seconds; it avoids decrypting the cache on unchanged polls. The client uses a renewable IndexedDB sync lease; server receipts remain authoritative when tabs race or a leader is suspended.

The exact fields, unique indexes, generic API rules and a dedicated public limiter table (hashed client IP, minute bucket, count; expired buckets removed) are specified in `pb_hooks/schema.js`. History uniqueness covers owner/epoch/revision and owner/epoch/operation; note uniqueness covers owner/epoch/logical ID. Mutation callbacks use the transaction app exclusively. Private bodies/publications are limited by a 3 MB request limit; summaries have a smaller ciphertext limit. Operational relationships, counts, timestamps, revisions, deletion/expiry and ownership remain visible metadata.

AES-256-GCM envelopes are `{v:2, alg:"A256GCM", iv, ct}`, using canonical unpadded base64url, a fresh 12-byte nonce, and deterministic JSON-array AAD: `["jnote.v2", purpose, owner, epoch, immutableId, revision, generation]`. Wrapper purposes also bind scheme, recipient kind and recipient ID. Password wrappers use PBKDF2-SHA-256, 310,000 iterations and a 16-byte salt. Independent random vault, per-note and per-link keys separate password changes, histories and publications. Wrappers currently accept only implemented owner-vault/password/device AES schemes. Future recipient schemes are rejected until implemented.

Public publications bind `public-publication/public/publication-v2/shareId/publicationRevision/1`; they expose only committed title/body. Private placement, drafts, history and note keys are excluded. The owner copy of each share key is wrapped by the vault. Rewrapping a password leaves note/history/publication ciphertext unchanged. A nonextractable device key in IndexedDB protects remembrance; it does not protect against malicious same-origin scripts.

## One-time production cutover

The approved production cutover **completed on 2026-10-01 at 23:36:47 UTC**; its receipt is recorded below. For any other instance, resolve its binary/version, data directory, instance identity and every approved JNote owner before using this command. A later reset on this instance requires separate tooling and authorization. Retain the user's existing export. Take an available filesystem snapshot. Install the JNote hook files alongside the existing account-service hooks first, with the old migration directory still in use. Confirm that the new request guards deny legacy JNote writes while account authentication remains available. Do not install the v2 migration into an active legacy server before cutover: it deliberately refuses that schema. Do not run a whole-database wipe or replace account-service hooks.

Run the custom command against the verified existing data directory. `JNOTE_INSTANCE` must match the resolved configuration. Substitute the actual values; the command is intentionally explicit and does not run during deploy or startup.

```sh
JNOTE_INSTANCE='<verified-instance>' backend/.bin/pocketbase jnote-cutover \
  '<verified-instance>' '<comma-separated-approved-owner-ids>' '<fresh-uuid-epoch>' \
  --automigrate=false --dir='<verified-existing-pb-data-directory>' \
  --hooksDir=backend/pb_hooks --migrationsDir=backend/pb_migrations
```

The command refuses a wrong instance, absent/unapproved owners, unknown JNote collections, unrelated collections referencing JNote, and stale epochs. The account service may contain additional users; no user is deleted or changed. Owner validation runs before closing collection rules. It closes legacy generic rules before deleting allowlisted JNote records in dependency order, rebuilds the emptied schema transactionally, and records the epoch/reset receipt. It preserves users and unrelated collections. A same-target rerun after completion never deletes newly created v2 data. Any later reset requires separate tooling and authorization. If the command fails, keep JNote writes blocked; inspect and rerun the same target rather than inventing a new epoch. Account-service users and endpoints stay outside the reset. The serving process may still cache old collection definitions, so the hook-level guards are required in addition to persisted rules.

After the reset, install the v2 migration and reload the existing account-enabled server with the combined hooks/migrations and `--automigrate=false`, deploy the compatible client, and verify bootstrap/fresh encryption setup, commit/reopen/history, password rewrap, offline restart/reconnect, search, and logged-out public links. Old direct writes stay locked. Old local note/key/draft/queue entries are retired by exact key; Custom CSS and other account/browser storage are preserved. Old v2 namespaces are retained in their own epoch and never replayed into another one.

## Production receipt and hook deployment

- Backend app: `joemt`; machine: `d8d9236f55d398`; region: `fra`; data: `/app/pb_data`.
- Existing image: `registry.fly.io/joemt:deployment-01KATKQ6A5SA593XM5XXE1M42J`; binary: PocketBase `0.28.2`.
- Volume snapshot before reset: `vs_wAPlV5OP26JUpO4G5Kz0` on `vol_vly16n7mdo7n0wp4`. Fly retains this snapshot for five days; it is a short-term rollback point.
- Approved JNote owners: `21w6a92teb66h0p`, `m0lorl6com1t9h3`, `qn41hkrnb79xhjz`. The live owner count differed from the initial plan; the user explicitly approved resetting all three owners' JNote records.
- Cleared legacy records: 83 notes and 142 history records.
- Dataset epoch: `2c336885-3ba9-4f1c-b8a3-316feee40b35`.
- Completion: `2026-10-01T23:36:47.372Z`. The active `jnote_control.resetReceipt` includes the same owners, epoch and completion time.
- Hash audits confirmed all 11 `users`, all 12 non-JNote collection schemas/records, and backend settings were unchanged. The original image, VM, startup configuration, volume and network service were retained.

The authoritative JNote source is this package. The existing image has no account-service hook files. Five JNote hook files and the v2 migration are installed through Fly Machine `files` configuration, so they are injected again on machine startup. The original migration placeholder is preserved. `JNOTE_INSTANCE=joemt` is the only added backend environment variable. No superuser credentials or production session tokens were exported.

For future scoped hook updates on this already-cut-over instance:

```sh
node scripts/deploy-jnote-hooks.mjs joemt d8d9236f55d398 ready
```

The helper preserves the existing image and volume and **never runs the reset command**. A `ready` deployment runs the read-only `jnote-check` command; the generic PocketBase health endpoint alone cannot verify that JNote's active control record exists. For an uncut-over legacy instance, install `guards` first; use `ready` only after the approved cutover. Custom nonstandard layouts on PocketBase 0.28 must set `JNOTE_HOOKS_DIR` for the migration's schema import.

On 2026-10-02 the signed-in bootstrap returned 404 because the active control record was absent, although all nine v2 collections were present. All encrypted JNote collections were empty. Only the control record was restored at `2026-10-02T00:30:49Z`, using the original epoch and reset receipt above; no further reset was run. Readiness passed again after a normal machine restart, and subsequent live bootstrap requests returned 200 with vault/note/history creation visible in record counts. Missing control now returns 503 rather than an object-not-found response.

If verified metadata is lost again, do not rerun cutover or invent another epoch. `jnote-restore-control <instance> <original-epoch> <original-completion-time> <approved-owner-list>` restores that one record only when all encrypted JNote collections are empty and have the v2 schema. It refuses a wrong instance, conflicting control or any existing encrypted data. A same-target rerun preserves the existing control and data. For nonempty datasets, recover the control from a verified backup. Use the existing data directory and `--automigrate=false` with every maintenance command.

The frontend is GitHub Pages at https://notes.joe.mt, an origin the account site already allows. Browser session-bridge, fresh vault setup and remembered-device reload checks use disposable users with every backend request routed to a temporary PocketBase instance; no production user token is needed. Backend health and denied anonymous/generic access are verified. Full browser acceptance and performance comparison remain separate from these focused regression checks; see the execution runbook.
