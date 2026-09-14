const KEYBOARD_VIEWPORT_THRESHOLD = 120;
const CARET_VIEWPORT_GAP = 24;

export function getVerticalRevealDelta(rect, bounds, gap = CARET_VIEWPORT_GAP) {
  if (!rect || !bounds || bounds.bottom <= bounds.top) return 0;

  const safeGap = Math.min(Math.max(0, gap), (bounds.bottom - bounds.top) / 2);
  const visibleTop = bounds.top + safeGap;
  const visibleBottom = bounds.bottom - safeGap;

  if (rect.bottom > visibleBottom) return rect.bottom - visibleBottom;
  if (rect.top < visibleTop) return rect.top - visibleTop;
  return 0;
}

export function getKeyboardInsets(stableHeight, layoutHeight, visualHeight, visualOffsetTop = 0) {
  return {
    stable: Math.max(0, Math.round(stableHeight - visualHeight - visualOffsetTop)),
    overlay: Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop))
  };
}

export function isEditableElement(element) {
  if (!element || element === document.body) return false;

  return element.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    || Boolean(element.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

export function bindAppViewportSize() {
  let stableViewport = { width: window.innerWidth, height: window.innerHeight };
  let lastEditableFocusAt = 0;
  let keyboardLikely = false;
  let caretRevealFrame = 0;
  const delayedTasks = new Set();

  function getCaretRect(range) {
    let rect = range.getBoundingClientRect();
    if (rect && (rect.width || rect.height || rect.top || rect.bottom)) return rect;

    if (range.collapsed && range.startContainer?.nodeType === 3 && range.startOffset > 0) {
      const previousCharacter = range.cloneRange();
      previousCharacter.setStart(range.startContainer, range.startOffset - 1);
      rect = previousCharacter.getBoundingClientRect();
    }

    return rect && (rect.width || rect.height || rect.top || rect.bottom) ? rect : null;
  }

  function revealActiveCaret() {
    caretRevealFrame = 0;
    if (!keyboardLikely) return;

    const editable = document.activeElement;
    const scrollContainer = editable?.closest?.('#note-detail');
    const selection = window.getSelection?.();
    if (!scrollContainer || !selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (!range.collapsed || !editable.contains?.(range.commonAncestorContainer)) return;

    const caretRect = getCaretRect(range);
    if (!caretRect) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const toolbarBottom = scrollContainer
      .querySelector('.note-actions')
      ?.getBoundingClientRect().bottom || 0;
    const visualViewport = window.visualViewport;
    const viewportTop = visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (visualViewport?.height || window.innerHeight);
    const delta = getVerticalRevealDelta(caretRect, {
      top: Math.max(containerRect.top, viewportTop, toolbarBottom),
      bottom: Math.min(containerRect.bottom, viewportBottom)
    });

    if (delta) scrollContainer.scrollTop += delta;
  }

  function scheduleCaretReveal() {
    if (caretRevealFrame) return;
    caretRevealFrame = window.requestAnimationFrame(revealActiveCaret);
  }

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
    keyboardLikely = !widthChanged
      && keyboardShrink > KEYBOARD_VIEWPORT_THRESHOLD
      && (isEditableElement(document.activeElement) || recentEditableFocus);

    if (force || !keyboardLikely) {
      stableViewport = { width, height };
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    }

    const keyboardInsets = keyboardLikely
      ? getKeyboardInsets(stableViewport.height, height, visualHeight, visualOffsetTop)
      : { stable: 0, overlay: 0 };
    // A WebView may resize its layout viewport as well. Fixed panels only need the
    // portion that still overlays that layout viewport, not the full stable inset.
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInsets.stable}px`);
    document.documentElement.style.setProperty('--keyboard-overlay-inset', `${keyboardInsets.overlay}px`);
    if (keyboardLikely) scheduleCaretReveal();
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
  const onInput = (event) => {
    if (keyboardLikely && isEditableElement(event.target)) scheduleCaretReveal();
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
  window.addEventListener('input', onInput, true);

  return () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientationChange);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('input', onInput, true);
    if (caretRevealFrame) window.cancelAnimationFrame(caretRevealFrame);
    delayedTasks.forEach(clearTimeout);
  };
}
