# JNote

JNote is a client-side encrypted notes app built with Svelte 5 and SvelteKit. Notes are encrypted in the browser, cached in user/epoch-scoped IndexedDB, and synchronized through revision-checked PocketBase endpoints. The frontend is deployed on GitHub Pages at https://notes.joe.mt and uses the existing `joemt` PocketBase database. The JNote-only production reset is complete, and the existing account site already serves this origin.

## Signing in

The sign-in page is always the account site. JNote never asks for a credential
itself: it sends you to `accounts.joe.mt` and you come straight back signed in.
Only the way the session travels back differs by origin, and
`src/lib/accounts.js` picks:

| Mode          | Where                                                          | How the session comes back                                          |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `bridge`      | `joe.mt`, `notes.joe.mt`                                       | Hidden `accounts.joe.mt/bridge/` iframe. Token held in memory only. |
| `redirect`    | Any other origin the account site serves, `localhost` included | The account site appends `#joe_session=<token>` to the return URL.  |
| `unsupported` | An origin the account site does not serve                      | Sign-in is impossible; the unlock screen says so.                   |

`bridge` is preferred wherever it works, because no token touches a URL. It only
works same-site: the iframe reads the account site's own local storage, and
browsers partition third-party storage by top-level site, so a cross-site iframe
sees an empty store and reports a signed-out user. `notes.joe.mt` works because it
is the same site as `accounts.joe.mt`.

`redirect` is the cross-site path. A fragment never reaches a server, stays out of
`Referer`, and never lands in an access log. `client.js` strips it with
`history.replaceState` as it loads, before any app code runs, and offers it once; JNote also strips a handoff in its first inline bootstrap before loading external assets;
JNote then calls `authRefresh()`, which fetches the record and confirms the server
still accepts the token. The session then persists here, since re-asking the
account site costs a full round trip, and **Settings → Sign out** clears both.

Adding an origin means three lists, which must stay in step: `BRIDGE_ORIGINS` or
`HANDOFF_ORIGINS` in the account site's `session.js`, the matching list in its
`client.js`, and `accountsOrigins` in `src/app.html`.

## Configuration

| Setting                         | Build-time env         | Runtime override                      | Default                                                                |
| ------------------------------- | ---------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| PocketBase instance             | `VITE_POCKETBASE_URL`  | `window.JNOTE_CONFIG.pocketbaseUrl`   | `https://joemt.fly.dev`                                                |
| Account site                    | `VITE_ACCOUNTS_ORIGIN` | `window.JNOTE_CONFIG.accountsOrigin`  | `https://accounts.joe.mt`                                              |
| Origins the account site serves | —                      | `window.JNOTE_CONFIG.accountsOrigins` | `joe.mt`, `notes.joe.mt`, `localhost:5173/4173`, `127.0.0.1:5173/4173` |

Copy `.env.example` to `.env` to set the build-time values. The runtime overrides
live in the inline script at the top of `src/app.html`, which survives into
`build/index.html`, so an already-deployed copy can be repointed by editing that
one block. JNote requests the account script only from an origin on
`accountsOrigins`, so a deployment elsewhere never loads it.

## Development

```sh
npm install
npm run dev
```

`npm run dev` serves `http://localhost:5173`, which is on the account site's
`HANDOFF_ORIGINS`, so sign-in works there through the real `accounts.joe.mt` page:
you get redirected out and redirected back. Use port `5173` or `4173`; another
port has to be added to all three lists above.

## Self-hosting

Run your own PocketBase and your own copy of the account site, then point JNote at
both with `VITE_POCKETBASE_URL` and `VITE_ACCOUNTS_ORIGIN` (or the `JNOTE_CONFIG`
block in `src/app.html`), and list your JNote origin on your account site. Serve
the built `build/` directory from any host.

A self-hosted JNote cannot use `accounts.joe.mt`: that site issues sessions only
for its own server and only to origins it lists, which is what stops any site that
embeds it from collecting a session.

## Project structure

- `src/routes/+page.svelte` composes the application and owns browser lifecycle listeners.
- `src/lib/components/` contains the folders, notes, editor, menus, and settings UI.
- `src/lib/jnote.svelte.js` owns reactive application state and coordinates persistence and sync.
- `src/lib/accounts.js` resolves the account site and server, and picks the session path.
- `src/lib/crypto.js` contains the pure v2 encryption primitives; `vault.js` handles versioned key wrappers.
- `src/lib/localDb.js` stores encrypted notes, drafts, histories, personal objects and durable ordered outbox work in transactional IndexedDB.
- `src/lib/sync.js` handles authenticated transport, operation receipts and the renewable sync lease.
- `src/lib/publicSharing.js` encrypts independent read-only snapshots; `/s/[shareId]` has a minimal viewer.
- `backend/` holds the reproducible PocketBase schema, endpoints, scoped cutover command and deployment instructions. See [backend/README.md](backend/README.md).
- `src/lib/viewport.js` handles mobile keyboard viewport sizing. The viewport meta uses `interactive-widget=resizes-content`, so on Chrome the layout viewport shrinks with the keyboard and the fixed mobile panes, sized `top`/`bottom`, match the visible area. Browsers that ignore that hint pan the visual viewport to the caret instead; `--keyboard-visual-top` and `--keyboard-overlay-inset` pin the panes to wherever it lands.
- `src/lib/search.js` filters and ranks notes for the search field; pure and tested. Titles and all downloaded current bodies are searched across every folder. Bodies hydrate in background batches; incomplete coverage is shown until downloads finish.
- `src/lib/swipe.js` is the swipe-to-dismiss gesture for the mobile note pane and folder drawer; its decision helpers are pure and tested.

On mobile, an open note pane or folder drawer also gets a history entry through
SvelteKit's shallow routing (`+page.svelte`), so the system back button closes the
panel and shows the list instead of leaving the app. Closing from the UI pops that
entry again, so history always matches what is on screen.

- `style.css` remains global so existing user-supplied Custom CSS selectors continue to work.

## Installing as an app

JNote is a PWA. `src/routes/manifest.webmanifest/+server.js` generates the manifest
at build time so its `start_url`, `scope` and icon paths follow the deployment's base
path, and `static/icons/` holds the icons (regular, maskable, and an Apple touch
icon). `src/service-worker.js` precaches the built app shell per version and caches
the BeerCSS and Google Fonts assets as they are fetched, so the app opens instantly
and still draws itself offline. Its rules live in `src/lib/serviceWorkerRules.js`,
which is pure and tested. Online page loads fetch the current HTML, including the
precached home page; offline loads use the current release's cached shell. A fully
installed update activates without waiting for every tab to close. The previous
release's immutable chunks remain available to open tabs, and unrelated caches
are preserved. Activation does not reload tabs or interrupt unsaved edits.

The worker never intercepts PocketBase/account requests or API paths, including anonymous public ciphertext. A remembered account can open its encrypted cache while cloud checks run. Cloud uploads require refreshed authentication and the current dataset epoch. Lock removes plaintext from memory; forgetting a device deletes its protected remembered copy without discarding durable work. Quota/persistence failures remain visible.

## Encryption and public links

A random account vault key wraps independent note keys. The passphrase derives only a vault-unlock key, so changing it replaces the vault wrapper and leaves histories unchanged. Remembered devices use a nonextractable device key held in IndexedDB. This does not prevent malicious scripts on the same origin from using accessible keys. Unknown/v1 payloads are rejected; this release has no legacy import or ciphertext migration.

Each explicit commit persists an encrypted history and ordered upload request atomically. Stale revisions preserve local work and open conflict review; note conflicts can be saved as independent copies with their dependent commits. Folder/settings edits use individual encrypted records and do not invent content history. Normal note deletion is soft and disables public links transactionally.

Public links publish the committed title/body as independent read-only snapshots, with optional expiry, disable and manual republication. Link keys live only in URL fragments and are removed before later scripts run. The viewer loads no account scripts, remembered vaults, third-party JavaScript or user Custom CSS. Reloading a stripped URL requires opening the original full link again. The full link can be forwarded, and revocation cannot recall already downloaded copies. Link paths respect the deployment base and static fallback.

## Validation

```sh
npm run check
npm test
npm run build
npm run backend:install
POCKETBASE_BIN="$PWD/backend/.bin/pocketbase" npm run test:backend
POCKETBASE_BIN="$PWD/backend/.bin/pocketbase" npm run test:cutover
npm run benchmark:cache
```

The backend suites use disposable databases and test two-account isolation, real database rollback, duplicate receipts, stale revisions/epochs, direct-write denial, expiry/republication/revocation, and safe cutover reruns. The cache benchmark uses generated data under Node/WebCrypto/fake-indexeddb, not a browser startup measurement. The production reset/deployment receipt and browser validation evidence are in [the execution runbook](docs/architecture-overhaul-plan.md).

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` checks, tests, builds, and publishes the static `build/` output. Production uses GitHub Actions as the Pages publishing source, with the custom domain `notes.joe.mt` and HTTPS enforced.

The workflow gets the correct base path from GitHub Pages, so both project Pages URLs and configured custom domains are supported.

## Compatibility contracts

The authorized one-time reset replaces v1 encrypted data with a fresh v2 dataset. Account-service users, Custom CSS, private-app DOM IDs/classes, mobile routing/keyboard behavior, and global `style.css` are preserved. This does not authorize future wipes on redeployment. See [the execution runbook](docs/architecture-overhaul-plan.md) and [backend instructions](backend/README.md).

## Optional Fly frontend

Production frontend releases use GitHub Pages. `fly.toml`, `Dockerfile`, and `Caddyfile` retain the optional static frontend packaging from the initial deployment. An alternate frontend origin must be explicitly allowed by its account site before it can sign in. Caddy serves SvelteKit's `404.html` fallback for public-link routes. The Docker build context includes only source/assets/configuration and excludes local credentials, data, and Git history.

```sh
fly deploy --ha=false
```

Backend JNote hooks remain on `joemt`, using its existing PocketBase **0.28.2** binary, image, 1 GB volume, account settings and users. See [backend/README.md](backend/README.md) for the verified reset receipt and scoped hook deployment. Old JNote records were deliberately reset; routine v2 deletes remain soft.
