# JNote contributor guidance

## Required validation

Run `npm run check`, `npm test`, and `npm run build` after application changes.

## Preserve stored data

- Do not change the AES-GCM/PBKDF2 envelope in `src/lib/crypto.js` without a backward-compatible migration.
- Do not rename the `jnote.*.v1` storage keys or stop scoping encrypted stores by PocketBase user ID.
- A committed note update must continue creating a `jnote_content` history record.
- Deletes remain soft deletes on the `jnote` record.
- Keep the pending-create ID reconciliation and encrypted-store sequence protection intact.

## Preserve customization

Users can save arbitrary Custom CSS. Treat the existing IDs and classes in `src/lib/components/` as public API, and keep `style.css` global.

## Architecture

- Put UI behavior in the smallest relevant Svelte component.
- Put shared reactive state and workflows in `src/lib/jnote.svelte.js`.
- Keep cryptographic primitives independent of Svelte so they remain directly testable.
- Only access `window`, `document`, `localStorage`, or authenticated PocketBase data from client lifecycle code or user-triggered methods.
