// Swipe-to-dismiss for the mobile slide-in panels.
//
// The decision helpers are independent of the DOM so they can be tested directly; the
// `swipeDismiss` action wires them to touch events on a panel and moves the panel with
// the finger. It only ever hands the final decision back to the app through onDismiss:
// the panel's own `.open` class still drives the slide-out, so the CSS transition picks
// up from wherever the finger let go.

const DECIDE_DISTANCE = 12; // px of movement before a touch is judged
const DOMINANCE = 1.4; // horizontal travel must beat vertical by this factor
const EDGE_ZONE = 40; // px from the panel's leading edge that counts as an edge start
const DISMISS_FRACTION = 0.3; // of the panel width
const DISMISS_VELOCITY = 0.45; // px per ms

/**
 * Judges a touch from its first meaningful movement. `direction` is the way the panel
 * leaves the screen: 'right' for the note pane docked right, 'left' for the folder
 * drawer docked left.
 * @returns {'wait' | 'scroll' | 'swipe'}
 */
export function classifyMovement(dx, dy, direction) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < DECIDE_DISTANCE && ay < DECIDE_DISTANCE) return 'wait';
  if (ax < ay * DOMINANCE) return 'scroll';
  const towardsExit = direction === 'right' ? dx > 0 : dx < 0;
  return towardsExit ? 'swipe' : 'scroll';
}

/** The offset to show while dragging: only movement towards the exit, never past rest. */
export function dragOffset(dx, direction) {
  return direction === 'right' ? Math.max(0, dx) : Math.min(0, dx);
}

/** Whether a swipe let go after `travelled` px at `speed` px/ms (towards the exit) closes. */
export function shouldDismiss(travelled, speed, width) {
  return travelled >= width * DISMISS_FRACTION || speed >= DISMISS_VELOCITY;
}

/**
 * Whether a touch at `x` (relative to the panel's left) starts on the edge the panel
 * slides back towards. Used to keep drags inside text as text gestures.
 */
export function startsOnEdge(x, width, direction) {
  return direction === 'right' ? x <= EDGE_ZONE : x >= width - EDGE_ZONE;
}

function ownsHorizontalScroll(target, root) {
  for (let node = target; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

/**
 * Svelte action. `params`: { direction: 'left' | 'right', onDismiss, enabled? } where
 * `enabled` may be a boolean or a function read at touch start.
 */
export function swipeDismiss(node, params) {
  let options = params;
  let phase = 'idle'; // 'idle' | 'pending' | 'dragging' | 'rejected'
  let start = null;
  let offset = 0;
  let speed = 0;
  let lastOffset = 0;
  let lastTime = 0;

  const isEnabled = () => (
    typeof options.enabled === 'function' ? options.enabled() : options.enabled !== false
  );

  function reset() {
    phase = 'idle';
    start = null;
    offset = 0;
    speed = 0;
  }

  function onTouchStart(event) {
    if (!isEnabled() || event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof Element) || ownsHorizontalScroll(target, node)) return;

    const touch = event.touches[0];
    const rect = node.getBoundingClientRect();
    const editable = target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
    const editing = Boolean(editable) && editable.contains(document.activeElement);
    const selecting = document.getSelection()?.isCollapsed === false;
    // Mid-edit, a drag across the text is for selecting it; only an edge swipe closes.
    if ((editing || selecting) && !startsOnEdge(touch.clientX - rect.left, rect.width, options.direction)) {
      return;
    }

    start = { x: touch.clientX, y: touch.clientY, width: rect.width };
    phase = 'pending';
    offset = 0;
    speed = 0;
    lastOffset = 0;
    lastTime = event.timeStamp;
  }

  function onTouchMove(event) {
    if (phase === 'idle' || phase === 'rejected' || !start) return;
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

    if (phase === 'pending') {
      const verdict = classifyMovement(dx, dy, options.direction);
      if (verdict === 'wait') return;
      if (verdict === 'scroll') {
        phase = 'rejected';
        return;
      }
      phase = 'dragging';
      node.style.transition = 'none';
    }

    // The gesture is ours from here on; the page must not scroll under it.
    event.preventDefault();
    offset = dragOffset(dx, options.direction);
    const elapsed = event.timeStamp - lastTime;
    if (elapsed > 0) {
      const instant = (Math.abs(offset) - Math.abs(lastOffset)) / elapsed;
      speed = speed === 0 ? instant : speed * 0.6 + instant * 0.4;
    }
    lastOffset = offset;
    lastTime = event.timeStamp;
    node.style.transform = `translateX(${offset}px)`;
  }

  function onTouchEnd() {
    if (phase !== 'dragging' || !start) {
      reset();
      return;
    }
    // Hand the panel back to its stylesheet in the same frame as the decision, so the
    // slide-out (or snap-back) transition starts from where the finger let go.
    node.style.transition = '';
    node.style.transform = '';
    const dismiss = shouldDismiss(Math.abs(offset), Math.max(0, speed), start.width);
    reset();
    if (dismiss) options.onDismiss?.();
  }

  function onTouchCancel() {
    if (phase === 'dragging') {
      node.style.transition = '';
      node.style.transform = '';
    }
    reset();
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd, { passive: true });
  node.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    update(next) {
      options = next;
    },
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchCancel);
      node.style.transition = '';
      node.style.transform = '';
    }
  };
}
