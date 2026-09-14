# JNote

JNote is a client-side encrypted notes app built with Svelte 5 and SvelteKit. Notes are encrypted in the browser and synchronized with the existing PocketBase backend.

## Signing in

The sign-in page is always the account site. JNote never asks for a credential
itself: it sends you to `accounts.joe.mt` and you come straight back signed in.
Only the way the session travels back differs by origin, and
`src/lib/accounts.js` picks:

| Mode | Where | How the session comes back |
| --- | --- | --- |
| `bridge` | `joe.mt`, `notes.joe.mt` | Hidden `accounts.joe.mt/bridge/` iframe. Token held in memory only. |
| `redirect` | Any other origin the account site serves, `localhost` included | The account site appends `#joe_session=<token>` to the return URL. |
| `unsupported` | An origin the account site does not serve | Sign-in is impossible; the unlock screen says so. |

`bridge` is preferred wherever it works, because no token touches a URL. It only
works same-site: the iframe reads the account site's own local storage, and
browsers partition third-party storage by top-level site, so a cross-site iframe
sees an empty store and reports a signed-out user. `notes.joe.mt` works because it
is the same site as `accounts.joe.mt`.

`redirect` is the cross-site path. A fragment never reaches a server, stays out of
`Referer`, and never lands in an access log. `client.js` strips it with
`history.replaceState` as it loads, before any app code runs, and offers it once;
JNote then calls `authRefresh()`, which fetches the record and confirms the server
still accepts the token. The session then persists here, since re-asking the
account site costs a full round trip, and **Settings → Sign out** clears both.

Adding an origin means three lists, which must stay in step: `BRIDGE_ORIGINS` or
`HANDOFF_ORIGINS` in the account site's `session.js`, the matching list in its
`client.js`, and `accountsOrigins` in `src/app.html`.

## Configuration

| Setting | Build-time env | Runtime override | Default |
| --- | --- | --- | --- |
| PocketBase instance | `VITE_POCKETBASE_URL` | `window.JNOTE_CONFIG.pocketbaseUrl` | `https://joemt.fly.dev` |
| Account site | `VITE_ACCOUNTS_ORIGIN` | `window.JNOTE_CONFIG.accountsOrigin` | `https://accounts.joe.mt` |
| Origins the account site serves | — | `window.JNOTE_CONFIG.accountsOrigins` | `joe.mt`, `notes.joe.mt`, `localhost:5173/4173`, `127.0.0.1:5173/4173` |

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
- `src/lib/crypto.js` contains the encryption-format primitives.
- `src/lib/viewport.js` handles mobile keyboard viewport sizing. The viewport meta uses `interactive-widget=resizes-content`, so on Chrome the layout viewport shrinks with the keyboard and the fixed mobile panes, sized `top`/`bottom`, match the visible area. Browsers that ignore that hint pan the visual viewport to the caret instead; `--keyboard-visual-top` and `--keyboard-overlay-inset` pin the panes to wherever it lands.
- `src/lib/search.js` filters and ranks notes for the search field; pure and tested. Titles are searched across every folder; note bodies only when already in memory, since they live in separate history records fetched one note at a time.
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
which is pure and tested.

The worker never intercepts requests to the PocketBase server or the account site:
notes and the session always come live, so a stale copy can never be shown as
current. That also sets the limit of offline use today — the app shell loads, but
checking the account needs a connection, and the unlock screen says so. SvelteKit
registers the worker only in production builds, never under `npm run dev`.

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` checks, tests, builds, and publishes the static `build/` output. In the repository's **Settings → Pages**, select **GitHub Actions** as the publishing source.

The workflow gets the correct base path from GitHub Pages, so both project Pages URLs and configured custom domains are supported.

## Compatibility contracts

The PocketBase collections, encrypted envelope format, local-storage keys, and public DOM IDs/classes are backward-compatible with the original app. Treat changes to these as data migrations rather than routine refactors.
