import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMovement, dragOffset, shouldDismiss, startsOnEdge } from '../src/lib/swipe.js';

test('a touch is not judged until it has moved far enough', () => {
  assert.equal(classifyMovement(5, 3, 'right'), 'wait');
  assert.equal(classifyMovement(-8, 8, 'left'), 'wait');
});

test('mostly vertical movement is left to scrolling', () => {
  assert.equal(classifyMovement(10, 40, 'right'), 'scroll');
  assert.equal(classifyMovement(-15, -30, 'left'), 'scroll');
  // Not horizontal enough to be sure.
  assert.equal(classifyMovement(20, 18, 'right'), 'scroll');
});

test('horizontal movement towards the exit is a swipe, away from it is not', () => {
  // The note pane leaves to the right.
  assert.equal(classifyMovement(30, 4, 'right'), 'swipe');
  assert.equal(classifyMovement(-30, 4, 'right'), 'scroll');
  // The folder drawer leaves to the left.
  assert.equal(classifyMovement(-30, 4, 'left'), 'swipe');
  assert.equal(classifyMovement(30, 4, 'left'), 'scroll');
});

test('the panel follows the finger only towards its exit and never past rest', () => {
  assert.equal(dragOffset(120, 'right'), 120);
  assert.equal(dragOffset(-50, 'right'), 0);
  assert.equal(dragOffset(-120, 'left'), -120);
  assert.equal(dragOffset(50, 'left'), 0);
});

test('a long drag dismisses regardless of speed', () => {
  assert.equal(shouldDismiss(150, 0, 400), true);
  assert.equal(shouldDismiss(119, 0, 400), false);
});

test('a quick flick dismisses regardless of distance', () => {
  assert.equal(shouldDismiss(30, 0.6, 400), true);
  assert.equal(shouldDismiss(30, 0.2, 400), false);
});

test('an edge start is judged against the edge the panel slides back towards', () => {
  // The note pane slides back to the right, so its leading edge is the left.
  assert.equal(startsOnEdge(10, 400, 'right'), true);
  assert.equal(startsOnEdge(200, 400, 'right'), false);
  // The folder drawer slides back to the left, so its leading edge is the right.
  assert.equal(startsOnEdge(390, 300, 'left'), true);
  assert.equal(startsOnEdge(100, 300, 'left'), false);
});
