// Note search. Pure and DOM-free so it can be tested directly; the store feeds it the
// notes and the UI shows what comes back.
//
// Titles are always searchable. Content is only searchable for notes whose text is
// already in memory (the open note, drafts, local notes): note bodies live in separate
// history records fetched one note at a time, so an all-notes content search would be a
// request per note per keystroke.

/**
 * Lower-cases and strips accents, so "Café" matches "cafe" and "Żebbuġ" matches
 * "zebbug". Maltese ħ (U+0127) is its own letter with no decomposition, so it is
 * folded by hand.
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u0127/g, 'h');
}

/** Splits a query into the terms a note must contain. '' and whitespace give none. */
export function searchTerms(query) {
  return normalizeText(query).split(/\s+/).filter(Boolean);
}

/**
 * Where a note matches: 'title' when every term is in the title, 'content' when the
 * terms are only all found across title, folder and content, or '' for no match.
 * Each term may match in any field; a note titled "Shopping" with "milk" in its body
 * matches "shopping milk".
 */
export function matchNote({ title, folder, content }, terms) {
  if (!terms.length) return '';
  const normalizedTitle = normalizeText(title);
  if (terms.every((term) => normalizedTitle.includes(term))) return 'title';
  const everything = `${normalizedTitle}\n${normalizeText(folder)}\n${normalizeText(content)}`;
  return terms.every((term) => everything.includes(term)) ? 'content' : '';
}

/**
 * Filters and orders notes for a query: title matches first, then the rest, each group
 * keeping the order it arrived in (the store keeps notes newest first).
 * `read` maps a note to { title, folder, content } so the store can substitute the
 * draft text a user is looking at over what is saved.
 */
export function searchNotes(notes, query, read = (note) => note) {
  const terms = searchTerms(query);
  if (!terms.length) return notes;
  const titleMatches = [];
  const contentMatches = [];
  for (const note of notes) {
    const where = matchNote(read(note), terms);
    if (where === 'title') titleMatches.push(note);
    else if (where === 'content') contentMatches.push(note);
  }
  return [...titleMatches, ...contentMatches];
}
