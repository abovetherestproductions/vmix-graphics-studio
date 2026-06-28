const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRecordingRepairService } = require('../src/modules/recordingRepairService');

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-repair-service-'));
  const reviewFolder = path.join(rootDir, 'review');
  const logFolder = path.join(rootDir, 'logs');
  fs.mkdirSync(reviewFolder);
  fs.mkdirSync(logFolder);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const logger = { entries: [], log(action, details) { this.entries.push({ action, details }); } };
  const settings = {
    localRecordingSorter: {
      needsReviewFolder: reviewFolder,
      filenameFormat: '{skaterName}.mp4',
    },
  };
  return {
    rootDir,
    reviewFolder,
    logger,
    service: createRecordingRepairService({
      rootDir,
      getSettings: () => settings,
      logger,
    }),
  };
}

function writeSessionLog(rootDir, fileTime, skaterName) {
  const startedAt = new Date(fileTime - 300000).toISOString();
  const stoppedAt = new Date(fileTime).toISOString();
  const lines = [
    {
      at: startedAt,
      action: 'recording started',
      details: {
        sessionId: 'session-1',
        startSnapshot: { skaterName, categoryName: 'Test Category' },
        filePlan: {
          snapshot: { skaterName, categoryName: 'Test Category' },
          finalFileName: `${skaterName}.mp4`,
        },
      },
    },
    {
      at: stoppedAt,
      action: 'recording stopped',
      details: { sessionId: 'session-1' },
    },
  ];
  fs.writeFileSync(
    path.join(rootDir, 'logs', 'recording-actions.log'),
    `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
  );
}

test('scan previews and apply performs a server-side repair', (t) => {
  const { rootDir, reviewFolder, service } = fixture(t);
  const fileTime = Date.now() - 1000;
  const source = path.join(reviewFolder, 'Wrong Name.mp4');
  fs.writeFileSync(source, 'video');
  fs.utimesSync(source, fileTime / 1000, fileTime / 1000);
  writeSessionLog(rootDir, fileTime, 'Correct Name');

  const scan = service.scan();
  assert.equal(scan.eligibleChanges, 1);
  assert.equal(fs.existsSync(source), true);

  const result = service.apply(scan.token);
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(path.join(reviewFolder, 'Correct Name.mp4')), true);
});

test('apply rejects a stale proposal when a source changes', (t) => {
  const { rootDir, reviewFolder, service } = fixture(t);
  const fileTime = Date.now() - 1000;
  const source = path.join(reviewFolder, 'Wrong Name.mp4');
  fs.writeFileSync(source, 'video');
  fs.utimesSync(source, fileTime / 1000, fileTime / 1000);
  writeSessionLog(rootDir, fileTime, 'Correct Name');

  const scan = service.scan();
  fs.appendFileSync(source, 'changed');
  assert.throws(() => service.apply(scan.token), /changed after the scan/);
});
