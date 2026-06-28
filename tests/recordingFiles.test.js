const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { waitForRecordingFile } = require('../src/modules/recordingFiles');

test('waitForRecordingFile waits for the exact vMix filename', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vmix-recording-'));
  const filePath = path.join(folder, 'delayed.mp4');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));

  setTimeout(() => fs.writeFileSync(filePath, 'video'), 30);
  const found = await waitForRecordingFile({
    folder,
    timestamp: new Date().toISOString(),
    expectedFilePath: filePath,
  }, {
    timeoutMs: 500,
    intervalMs: 10,
  });

  assert.equal(found.filePath, filePath);
  assert.equal(found.warning, null);
});

test('waitForRecordingFile reports an exact-path timeout', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vmix-recording-'));
  const filePath = path.join(folder, 'missing.mp4');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));

  const found = await waitForRecordingFile({
    folder,
    timestamp: new Date().toISOString(),
    expectedFilePath: filePath,
  }, {
    timeoutMs: 30,
    intervalMs: 10,
  });

  assert.equal(found.filePath, null);
  assert.match(found.warning, /Recording file did not appear/);
});
