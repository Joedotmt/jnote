import assert from 'node:assert/strict';
import test from 'node:test';

import { getKeyboardInsets, getVerticalRevealDelta } from '../src/lib/viewport.js';

test('keyboard insets distinguish an overlay from an already resized layout viewport', () => {
  assert.deepEqual(getKeyboardInsets(800, 800, 500), {
    stable: 300,
    overlay: 300
  });
  assert.deepEqual(getKeyboardInsets(800, 500, 500), {
    stable: 300,
    overlay: 0
  });
});

test('keyboard insets account for a panned visual viewport', () => {
  assert.deepEqual(getKeyboardInsets(800, 800, 500, 75), {
    stable: 225,
    overlay: 225
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
