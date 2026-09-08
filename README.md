# JNote

JNote is a client-side encrypted notes app built with Svelte 5 and SvelteKit. Notes are encrypted in the browser and synchronized with the existing PocketBase backend.

## Development

```sh
npm install
npm run dev
```

Before committing a change, run:

```sh
npm run check
npm test
npm run build
```

## Project structure

- `src/routes/+page.svelte` composes the application and owns browser lifecycle listeners.
- `src/lib/components/` contains the folders, notes, editor, menus, and settings UI.
- `src/lib/jnote.svelte.js` owns reactive application state and coordinates persistence and sync.
- `src/lib/crypto.js` contains the encryption-format primitives.
- `src/lib/viewport.js` handles mobile keyboard viewport sizing.
- `style.css` remains global so existing user-supplied Custom CSS selectors continue to work.

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` checks, tests, builds, and publishes the static `build/` output. In the repository's **Settings → Pages**, select **GitHub Actions** as the publishing source.

The workflow gets the correct base path from GitHub Pages, so both project Pages URLs and configured custom domains are supported.

## Compatibility contracts

The PocketBase collections, encrypted envelope format, local-storage keys, and public DOM IDs/classes are backward-compatible with the original app. Treat changes to these as data migrations rather than routine refactors.
