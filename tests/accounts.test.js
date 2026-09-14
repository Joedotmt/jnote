import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountsLoginUrl,
  accountsOrigin,
  isAccountsBridgeAvailable,
  isAccountsHandoffAvailable,
  pocketbaseUrl
} from '../src/lib/accounts.js';

// A stand-in for the account site's client.js, which throws rather than returning a
// falsy value when the current origin is not one it serves.
function fakeBridge(allowedOrigins) {
  return {
    AuthStore: class {},
    getSession: async () => null,
    loginUrl(destination) {
      const url = new URL(destination);
      if (!allowedOrigins.includes(url.origin)) {
        throw new TypeError('Return URL must be on https://joe.mt or https://notes.joe.mt.');
      }
      return `https://accounts.joe.mt/?redirect=${encodeURIComponent(url.href)}`;
    }
  };
}

function withBrowser({ href, origin, bridge }, run) {
  const previous = globalThis.window;
  globalThis.window = { location: { href, origin } };
  if (bridge) globalThis.window.JoeAccounts = bridge;
  try {
    return run();
  } finally {
    globalThis.window = previous;
  }
}

// The current account script reports its own routing instead of being probed.
function fakeRoutingBridge(bridgeOrigins, handoffOrigins, origin) {
  return {
    ...fakeBridge([...bridgeOrigins, ...handoffOrigins]),
    canBridge: () => bridgeOrigins.includes(origin),
    canHandoff: () => handoffOrigins.includes(origin)
  };
}

const JOE_ORIGINS = ['https://joe.mt', 'https://notes.joe.mt'];
const DEV_ORIGINS = ['http://localhost:5173'];

test('the bridge is unavailable when its script never loaded', () => {
  withBrowser({ href: 'http://localhost:5173/', origin: 'http://localhost:5173' }, () => {
    assert.equal(isAccountsBridgeAvailable(), false);
    assert.equal(accountsLoginUrl('http://localhost:5173/'), '');
  });
});

test('the bridge is unavailable on an origin it refuses to return to', () => {
  withBrowser(
    {
      href: 'http://localhost:5173/',
      origin: 'http://localhost:5173',
      bridge: fakeBridge(JOE_ORIGINS)
    },
    () => {
      assert.equal(isAccountsBridgeAvailable(), false);
      assert.equal(accountsLoginUrl('http://localhost:5173/'), '');
    }
  );
});

test('the bridge is used on an origin it serves', () => {
  const href = 'https://notes.joe.mt/';
  withBrowser({ href, origin: 'https://notes.joe.mt', bridge: fakeBridge(JOE_ORIGINS) }, () => {
    assert.equal(isAccountsBridgeAvailable(), true);
    assert.equal(
      accountsLoginUrl(href),
      `https://accounts.joe.mt/?redirect=${encodeURIComponent(href)}`
    );
  });
});

test('a handoff origin is not mistaken for a bridge origin', () => {
  // loginUrl now succeeds on a handoff origin, so only canBridge() separates the two.
  const origin = 'http://localhost:5173';
  withBrowser(
    {
      href: `${origin}/`,
      origin,
      bridge: fakeRoutingBridge(JOE_ORIGINS, DEV_ORIGINS, origin)
    },
    () => {
      assert.equal(isAccountsBridgeAvailable(), false);
      assert.equal(isAccountsHandoffAvailable(), true);
      // The account site is still the sign-in page from here.
      assert.equal(
        accountsLoginUrl(`${origin}/`),
        `https://accounts.joe.mt/?redirect=${encodeURIComponent(`${origin}/`)}`
      );
    }
  );
});

test('a bridge origin still prefers the bridge', () => {
  const origin = 'https://notes.joe.mt';
  withBrowser(
    { href: `${origin}/`, origin, bridge: fakeRoutingBridge(JOE_ORIGINS, DEV_ORIGINS, origin) },
    () => {
      assert.equal(isAccountsBridgeAvailable(), true);
      assert.equal(isAccountsHandoffAvailable(), false);
    }
  );
});

test('the configured defaults are what JNote talks to', () => {
  assert.equal(pocketbaseUrl(), 'https://joemt.fly.dev');
  assert.equal(accountsOrigin(), 'https://accounts.joe.mt');
});
