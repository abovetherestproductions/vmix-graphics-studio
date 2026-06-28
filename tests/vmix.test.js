const test = require('node:test');
const assert = require('node:assert/strict');

const { tagAttribute, textTag } = require('../src/modules/vmix');

test('textTag reads tags without attributes', () => {
  assert.equal(textTag('<vmix><recording>False</recording></vmix>', 'recording'), 'False');
});

test('textTag reads vMix 28 recording tags with attributes', () => {
  const xml = '<vmix><recording duration="325" filename1="C:\\vMixRecordings\\clip.mp4">True</recording></vmix>';
  assert.equal(textTag(xml, 'recording'), 'True');
});

test('tagAttribute reads the active vMix recording filename', () => {
  const xml = '<vmix><recording duration="325" filename1="C:\\vMixRecordings\\clip.mp4">True</recording></vmix>';
  assert.equal(tagAttribute(xml, 'recording', 'filename1'), 'C:\\vMixRecordings\\clip.mp4');
});
