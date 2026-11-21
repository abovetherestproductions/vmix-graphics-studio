const test = require('node:test');
const assert = require('node:assert/strict');

const { frenchLevelStyle } = require('../normalizers/french-style');
const json = require('../normalizers/skate-canada-json');
const api = require('../normalizers/skate-canada-new-api');

test('Hommes and Femmes take a lower-case plural level', () => {
  assert.equal(frenchLevelStyle('Hommes Pré-novice'), 'Hommes pré-novices');
  assert.equal(frenchLevelStyle('Femmes Novice'), 'Femmes novices');
  assert.equal(frenchLevelStyle('Femmes Junior'), 'Femmes juniors');
  assert.equal(frenchLevelStyle('Hommes Senior'), 'Hommes seniors');
});

test('Danse sur glace, couple and synchro take a lower-case singular level', () => {
  assert.equal(frenchLevelStyle('Danse sur glace Pré-novice'), 'Danse sur glace pré-novice');
  assert.equal(frenchLevelStyle('Patinage en couple Senior'), 'Patinage en couple senior');
  assert.equal(frenchLevelStyle('Patinage synchronisé Intermédiaire'), 'Patinage synchronisé intermédiaire');
  assert.equal(frenchLevelStyle('Patinage synchronisé Ouvert'), 'Patinage synchronisé ouvert');
});

test('the rule is idempotent and keeps what follows the level', () => {
  assert.equal(frenchLevelStyle('Femmes seniors'), 'Femmes seniors');
  assert.equal(frenchLevelStyle('Danse sur glace junior'), 'Danse sur glace junior');
  assert.equal(frenchLevelStyle('Femmes Pré-novice Groupe A'), 'Femmes pré-novices Groupe A');
});

test('anything else is returned untouched', () => {
  assert.equal(frenchLevelStyle('Pré-juvénile'), 'Pré-juvénile');
  assert.equal(frenchLevelStyle('Juvénile'), 'Juvénile');
  assert.equal(frenchLevelStyle('Senior Women'), 'Senior Women');
  assert.equal(frenchLevelStyle('Hommes'), 'Hommes');
  assert.equal(frenchLevelStyle(''), '');
  assert.equal(frenchLevelStyle(undefined), undefined);
});

test('the live-feed path reorders and then applies the glossary form', () => {
  assert.equal(json.enrichFrCategory('Pre-Novice Women', 'Pré-novice Femmes'), 'Femmes pré-novices');
  assert.equal(json.enrichFrCategory('Senior Ice Dance', 'Danse sur glace Senior'), 'Danse sur glace senior');
});

test('the API path applies the glossary form to the category it is sent', () => {
  const dto = { categoryFrenchDescription: 'Femmes Senior', disciplineName: 'Singles', disciplineFrenchName: 'Patinage en simple' };
  assert.equal(api.catFr(dto), 'Femmes seniors');
});

test('a bare level with the discipline added after a dash puts the discipline first', () => {
  assert.equal(frenchLevelStyle('Pré-novice — Danse sur glace'), 'Danse sur glace pré-novice');
  assert.equal(frenchLevelStyle('Novice — Patinage en couple'), 'Patinage en couple novice');
  assert.equal(frenchLevelStyle('Senior — Patinage synchronisé'), 'Patinage synchronisé senior');
  // Levels the glossary does not cover, and qualified names, keep their form.
  assert.equal(frenchLevelStyle('Juvénile — Danse sur glace'), 'Juvénile — Danse sur glace');
  assert.equal(frenchLevelStyle('Novice Solo — Danse sur glace'), 'Novice Solo — Danse sur glace');
});
