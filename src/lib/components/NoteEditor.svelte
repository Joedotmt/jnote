<script>
  import { untrack } from 'svelte';

  let { app, note } = $props();

  const initialValue = untrack(() => {
    const value = app.getEditorValue(note);
    return {
      title: String(value.title ?? ''),
      content: String(value.content ?? '')
    };
  });
  let titleElement;
  let contentElement;

  function getEditableText(element, options = {}) {
    if (!element) return '';
    const text = (element.innerText ?? element.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n');
    if (options.trim) return text.trim();
    return text.trim() ? text : '';
  }

  function readEditor() {
    return {
      title: getEditableText(titleElement, { trim: true }),
      content: getEditableText(contentElement)
    };
  }

  function persistDraft() {
    const value = readEditor();
    app.updateDraft(note.id, value.title, value.content);
  }

  function commit() {
    const value = readEditor();
    app.commitNote(note.id, value.title, value.content);
  }

  function handleTitleKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    contentElement?.focus();
  }

  function handlePlainTextPaste(event, element) {
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    const selection = window.getSelection();
    if (!selection) return;

    let range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !element.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }

    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text
    }));
  }
</script>

<div class="note-actions">
  <button
    class="btn-secondary ripple"
    class:hide={!app.hasDraft(note.id)}
    id="btn-revert"
    type="button"
    onclick={() => app.revertNoteDraft(note.id)}
  >
    Revert Changes
  </button>
  <button
    class="btn-primary ripple"
    id="btn-save"
    type="button"
    disabled={!app.canCommit(note.id)}
    onclick={commit}
  >
    Commit
  </button>
  <button
    class="btn-secondary ripple"
    id="btn-move"
    type="button"
    onclick={() => app.openFolderModal(note.id)}
  >
    Move
  </button>
  <button
    class="btn-secondary ripple"
    id="btn-delete"
    type="button"
    onclick={() => app.deleteNote(note.id)}
  >
    Delete
  </button>
</div>

<div
  bind:this={titleElement}
  contenteditable="plaintext-only"
  role="textbox"
  tabindex="0"
  aria-label="Note title"
  aria-multiline="false"
  placeholder="Title"
  class="note-title"
  id="edit-title"
  oninput={persistDraft}
  onkeydown={handleTitleKeydown}
  onpaste={(event) => handlePlainTextPaste(event, titleElement)}
>{initialValue.title}</div>

<div
  bind:this={contentElement}
  contenteditable="plaintext-only"
  role="textbox"
  tabindex="0"
  aria-label="Note content"
  aria-multiline="true"
  placeholder="Take a note..."
  class="note-detail-content editable"
  id="edit-content"
  oninput={persistDraft}
  onpaste={(event) => handlePlainTextPaste(event, contentElement)}
>{initialValue.content}</div>
