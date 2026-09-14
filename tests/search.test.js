import assert from 'node:assert/strict';
import test from 'node:test';

import { matchNote, normalizeText, searchNotes, searchTerms } from '../src/lib/search.js';

const notes = [
  { id: 'a', title: 'Shopping list', folder: 'Home', content: 'milk\neggs' },
  { id: 'b', title: 'Meeting notes', folder: 'Work', content: 'discussed the shopping app' },
  { id: 'c', title: 'Café ideas', folder: 'Home', content: '' },
  { id: 'd', title: 'Untitled', folder: 'Work', content: undefined }
];

test('a query is split into lower-cased, accent-free terms', () => {
  assert.deepEqual(searchTerms('  Café  IDEAS '), ['cafe', 'ideas']);
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(searchTerms('   '), []);
  assert.equal(normalizeText('Ħaż-Żebbuġ'), 'haz-zebbug');
});

test('a title match outranks a content match', () => {
  assert.equal(matchNote(notes[0], ['shopping']), 'title');
  assert.equal(matchNote(notes[1], ['shopping']), 'content');
  assert.equal(matchNote(notes[2], ['shopping']), '');
});

test('every term must be found, but each may land in a different field', () => {
  assert.equal(matchNote(notes[0], ['shopping', 'milk']), 'content');
  assert.equal(matchNote(notes[0], ['shopping', 'bread']), '');
  // The folder counts too.
  assert.equal(matchNote(notes[1], ['work', 'meeting']), 'content');
});

test('accents and case do not get in the way', () => {
  assert.equal(matchNote(notes[2], searchTerms('cafe')), 'title');
  assert.equal(matchNote(notes[2], searchTerms('CAFÉ')), 'title');
});

test('an empty query returns the notes untouched', () => {
  assert.equal(searchNotes(notes, ''), notes);
  assert.equal(searchNotes(notes, '   '), notes);
});

test('results put title matches first and keep arrival order within each group', () => {
  assert.deepEqual(searchNotes(notes, 'shopping').map((note) => note.id), ['a', 'b']);
  assert.deepEqual(searchNotes(notes, 'home').map((note) => note.id), ['a', 'c']);
  assert.deepEqual(searchNotes(notes, 'nothing here'), []);
});

test('missing content is treated as empty, not as an error', () => {
  assert.equal(matchNote(notes[3], ['untitled']), 'title');
  assert.equal(matchNote(notes[3], ['anything']), '');
});

test('the reader can substitute what the user currently sees for what is saved', () => {
  const drafts = { a: { title: 'Groceries' } };
  const read = (note) => ({ ...note, title: drafts[note.id]?.title ?? note.title });
  assert.deepEqual(searchNotes(notes, 'groceries', read).map((note) => note.id), ['a']);
  assert.deepEqual(searchNotes(notes, 'shopping list', read).map((note) => note.id), []);
});
