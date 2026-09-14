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
- Keep `src/lib/accounts.js` free of Svelte and safe to import under plain Node.
- Do not hardcode the PocketBase or account-site URL outside `src/lib/accounts.js`.
- The account site is the only sign-in page. Never add a credential form or an in-app identity-provider picker to JNote.
- Prefer the bridge where it applies, then the account site's redirect handoff. An origin the account site does not serve cannot sign in, and should say so rather than offering an alternative.
- A handed-over token must be read once and stripped from the URL before any app code runs, and confirmed with `authRefresh` before it is trusted.
- `accountsOrigins` in `src/app.html` must stay in step with the account site's `BRIDGE_ORIGINS` + `HANDOFF_ORIGINS`.
- Call `authWithOAuth2` from a non-async handler so Safari does not block the popup.
- Only access `window`, `document`, `localStorage`, or authenticated PocketBase data from client lifecycle code or user-triggered methods.
- Mobile panel history lives only in `+page.svelte`, through `pushState`/`replaceState` from `$app/navigation` and `page.state`; never call `history.pushState` directly, it fights the SvelteKit router.
- Keep `src/lib/search.js` pure and DOM-free. `computeVisibleNotes()` defines the one list the pane renders, whether searching or browsing a folder; `visibleNotes` is its reactive view and `getVisibleNoteIds()` its live one. Anything that walks the list must go through one of those rather than refilter `notes` by folder.
- Keep `src/lib/swipe.js` decision helpers pure and DOM-free; only the `swipeDismiss` action touches elements.
- The service worker caches the app shell only. Never let it intercept the PocketBase server or the account site (`src/lib/serviceWorkerRules.js`); a stale note or session is worse than none.
- Keep `interactive-widget=resizes-content` in `src/app.html`. Under `resizes-visual` or `overlays-content` the layout viewport stays full height, Chrome pans the visual viewport to reach the caret, and the top of a fixed pane ends up off-screen with nothing to scroll it back. Size mobile fixed panes with `top: var(--keyboard-visual-top)` and `bottom: var(--keyboard-overlay-inset)`, never a fixed `height`.
