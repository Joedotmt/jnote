const KEYBOARD_VIEWPORT_THRESHOLD = 120;

export function isEditableElement(element) {
  if (!element || element === document.body) return false;

  return element.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    || Boolean(element.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

export function bindAppViewportSize() {
  let stableViewport = { width: window.innerWidth, height: window.innerHeight };
  let lastEditableFocusAt = 0;
  const delayedTasks = new Set();

  function sync(options = {}) {
    const force = options.force === true;
    const visualViewport = window.visualViewport;
    const width = Math.round(window.innerWidth);
    const height = Math.round(window.innerHeight);
    const visualHeight = Math.round(visualViewport?.height || height);
    const visualOffsetTop = Math.round(visualViewport?.offsetTop || 0);
    const widthChanged = Math.abs(width - stableViewport.width) > 40;
    const recentEditableFocus = Date.now() - lastEditableFocusAt < 800;
    const keyboardShrink = Math.max(stableViewport.height - visualHeight, stableViewport.height - height);
    const keyboardLikely = !widthChanged
      && keyboardShrink > KEYBOARD_VIEWPORT_THRESHOLD
      && (isEditableElement(document.activeElement) || recentEditableFocus);

    if (force || !keyboardLikely) {
      stableViewport = { width, height };
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    }

    const keyboardInset = keyboardLikely
      ? Math.max(0, Math.round(stableViewport.height - visualHeight - visualOffsetTop))
      : 0;

    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
  }

  function keyboardSizedViewport() {
    const visualHeight = Math.round(window.visualViewport?.height || window.innerHeight);
    const shrink = Math.max(stableViewport.height - visualHeight, stableViewport.height - window.innerHeight);
    return shrink > KEYBOARD_VIEWPORT_THRESHOLD;
  }

  function later(callback, delay) {
    const timer = window.setTimeout(() => {
      delayedTasks.delete(timer);
      callback();
    }, delay);
    delayedTasks.add(timer);
  }

  const onResize = () => sync();
  const onOrientationChange = () => later(() => sync({ force: true }), 300);
  const onViewportChange = () => sync();
  const onFocusIn = (event) => {
    if (isEditableElement(event.target)) lastEditableFocusAt = Date.now();
    sync();
  };
  const onFocusOut = () => {
    lastEditableFocusAt = Date.now();
    later(() => {
      sync({
        force: !isEditableElement(document.activeElement) && !keyboardSizedViewport()
      });
    }, 500);
  };

  sync({ force: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onOrientationChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('scroll', onViewportChange);
  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('focusout', onFocusOut, true);

  return () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientationChange);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('focusout', onFocusOut, true);
    delayedTasks.forEach(clearTimeout);
  };
}
