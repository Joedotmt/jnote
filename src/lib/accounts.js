// Account configuration and session-path selection.
//
// JNote never signs anyone in itself. The account site is always the sign-in page; all
// that changes by origin is how the session travels back:
//   bridge   - a hidden iframe on the account site, same-site origins only
//   redirect - the account site puts it in the URL fragment on the way back
// An origin the account site does not serve cannot sign in at all, and says so.

const DEFAULT_POCKETBASE_URL = 'https://joemt.fly.dev';
const DEFAULT_ACCOUNTS_ORIGIN = 'https://accounts.joe.mt';

// Vite inlines this object at build time; it is undefined when the module runs under Node.
const buildEnv = import.meta.env || {};

function runtimeConfig() {
  return (typeof window === 'undefined' ? null : window.JNOTE_CONFIG) || {};
}

/** The PocketBase instance JNote reads and writes notes through. */
export function pocketbaseUrl() {
  return runtimeConfig().pocketbaseUrl
    || buildEnv.VITE_POCKETBASE_URL
    || DEFAULT_POCKETBASE_URL;
}

/** The account site that owns the session. */
export function accountsOrigin() {
  return runtimeConfig().accountsOrigin
    || buildEnv.VITE_ACCOUNTS_ORIGIN
    || DEFAULT_ACCOUNTS_ORIGIN;
}

/**
 * Whether the account bridge serves this origin. The bridge reads its session from the
 * account site's own storage, which browsers partition by top-level site, so it only
 * ever answers same-site callers.
 */
export function isAccountsBridgeAvailable() {
  if (typeof window === 'undefined') return false;
  const accounts = window.JoeAccounts;
  if (!accounts?.AuthStore || typeof accounts.getSession !== 'function') return false;
  // A current account script says outright which path this origin is on. Probing
  // loginUrl cannot tell them apart, since it succeeds for handoff origins too.
  if (typeof accounts.canBridge === 'function') return accounts.canBridge();
  // An older one only reveals it by throwing for an origin it does not serve.
  try {
    accounts.loginUrl(window.location.href);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Whether the account site hands this origin a session through the redirect fragment.
 * This is the cross-site path: the account site stays the sign-in page, but the session
 * comes back in the URL because an iframe here would only see partitioned storage.
 */
export function isAccountsHandoffAvailable() {
  if (typeof window === 'undefined') return false;
  const accounts = window.JoeAccounts;
  if (typeof accounts?.canHandoff !== 'function') return false;
  return accounts.canHandoff();
}

/** The session the account site just handed over, readable once. '' when there is none. */
export function takeAccountsHandoffToken() {
  if (typeof window === 'undefined') return '';
  try {
    return window.JoeAccounts?.takeHandoffToken?.() || '';
  } catch (error) {
    console.warn('Could not read the handed-over session:', error);
    return '';
  }
}

/** Resolves once the optional account script has loaded, or immediately when it is absent. */
export async function whenAccountsScriptSettled() {
  if (typeof window === 'undefined') return false;
  try {
    await window.__joeAccountsReady;
  } catch (error) {
    console.warn('Could not load the account script:', error);
  }
  return isAccountsBridgeAvailable() || isAccountsHandoffAvailable();
}

/** A sign-in link back to this exact page, or '' when no account-site path applies. */
export function accountsLoginUrl(returnTo) {
  // Both paths sign in at the account site; only the way back differs.
  if (!isAccountsBridgeAvailable() && !isAccountsHandoffAvailable()) return '';
  try {
    return window.JoeAccounts.loginUrl(returnTo);
  } catch (error) {
    return '';
  }
}
