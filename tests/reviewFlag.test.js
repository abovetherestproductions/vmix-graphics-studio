const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../normalizers/skate-canada-new-api');

const element = (order, code, extra = {}) => ({
  order, code, base_value: 1.1, goe_score: 1.2, goe_trimmed_mean: 0.1, subElements: [], official_goe_scores: [], ...extra,
});

test('an element the panel has flagged for review is marked reviewing', () => {
  const payload = api.normalizeElements(
    [element(1, '3Lz', { review_flag: true }), element(2, '2A', { review_flag: false }), element(3, 'FCSp3')],
    { competitorName: 'A Skater' }, {}, {}, null, {}
  );
  assert.deepEqual(payload.data.elements.map(e => e.reviewing), [true, false, false]);
});

test('only a real true counts, so a stray string or 1 does not light the dot', () => {
  const payload = api.normalizeElements(
    [element(1, '1A', { review_flag: 'true' }), element(2, '2A', { review_flag: 1 })],
    { competitorName: 'A Skater' }, {}, {}, null, {}
  );
  assert.deepEqual(payload.data.elements.map(e => e.reviewing), [false, false]);
});
