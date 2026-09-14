import assert from 'node:assert/strict';
import test from 'node:test';

import { getKeyboardInsets, getVerticalRevealDelta } from '../src/lib/viewport.js';

test('keyboard insets distinguish an overlay from an already resized layout viewport', () => {
  // Layout viewport left full height: the keyboard overlays 300px of it.
  assert.deepEqual(getKeyboardInsets(800, 800, 500), {
    stable: 300,
    overlay: 300,
    visualTop: 0
  });
  // Layout viewport shrunk with the keyboard (resizes-content): nothing left to overlay.
  assert.deepEqual(getKeyboardInsets(800, 500, 500), {
    stable: 300,
    overlay: 0,
    visualTop: 0
  });
});

test('keyboard insets account for a panned visual viewport', () => {
  // The browser scrolled the visual viewport 75px down to reach the caret. A fixed pane
  // pinned top: 75px / bottom: 225px then covers exactly the visible 500px.
  assert.deepEqual(getKeyboardInsets(800, 800, 500, 75), {
    stable: 225,
    overlay: 225,
    visualTop: 75
  });
});

test('caret reveal scrolls down when typing below the visible keyboard edge', () => {
  assert.equal(
    getVerticalRevealDelta(
      { top: 486, bottom: 510 },
      { top: 50, bottom: 500 }
    ),
    34
  );
});

test('caret reveal leaves a caret inside the safe viewport unchanged', () => {
  assert.equal(
    getVerticalRevealDelta(
      { top: 420, bottom: 444 },
      { top: 50, bottom: 500 }
    ),
    0
  );
});

test('caret reveal can scroll back up to a caret above the visible editor', () => {
  assert.equal(
    getVerticalRevealDelta(
      { top: 54, bottom: 78 },
      { top: 50, bottom: 500 }
    ),
    -20
  );
});
