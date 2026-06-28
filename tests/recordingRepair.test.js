const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyRepairPlan,
  buildRecordingSessions,
  buildRepairPlan,
  matchFilesToSessions,
  matchFilesToStartOrder,
  parseActionLog,
  readStartOrderRows,
} = require('../src/modules/recordingRepair');

test('buildRecordingSessions reconstructs the intended filename from the action log', () => {
  const text = [
    JSON.stringify({
      at: '2026-06-12T16:00:00.000Z',
      action: 'recording started',
      details: {
        sessionId: 'session-1',
        startSnapshot: { skaterName: 'Alexis Chan', categoryName: 'Pre-Novice Women' },
        filePlan: {
          snapshot: { skaterName: 'Alexis Chan', categoryName: 'Pre-Novice Women' },
          finalFileName: 'Alexis Chan.mp4',
        },
      },
    }),
    JSON.stringify({
      at: '2026-06-12T16:05:00.000Z',
      action: 'recording stopped',
      details: { sessionId: 'session-1' },
    }),
  ].join('\n');

  const sessions = buildRecordingSessions(parseActionLog(text));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].expectedFileName, 'Alexis Chan.mp4');
  assert.equal(sessions[0].matchTimeMs, Date.parse('2026-06-12T16:05:00.000Z'));
});

test('matchFilesToSessions uses finalized file time and reports confidence', () => {
  const files = [
    { filePath: '/review/wrong.mp4', mtimeMs: Date.parse('2026-06-12T16:05:20.000Z') },
  ];
  const sessions = [
    {
      sessionId: 'session-1',
      expectedFileName: 'Correct.mp4',
      matchTimeMs: Date.parse('2026-06-12T16:05:00.000Z'),
    },
  ];
  const result = matchFilesToSessions(files, sessions);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].confidence, 'high');
  assert.equal(result.matches[0].deltaMs, 20000);
});

test('start-order matching refuses a count mismatch', () => {
  const result = matchFilesToStartOrder(
    [{ filePath: '/review/one.mp4', mtimeMs: 1 }],
    [{ skaterName: 'One' }, { skaterName: 'Two' }],
  );
  assert.match(result.error, /does not match/);
  assert.equal(result.matches.length, 0);
});

test('readStartOrderRows supports the Skate Canada CSV format and segment filter', () => {
  const csv = [
    'SegmentName,Position,Skater,Club',
    'Women - Free Program,1,First Skater,Club A',
    'Men - Free Program,1,Other Skater,Club B',
  ].join('\n');
  const rows = readStartOrderRows(csv, { segment: 'Women - Free Program' });
  assert.deepEqual(rows, [{
    skaterName: 'First Skater',
    segmentName: 'Women - Free Program',
    position: 1,
    club: 'Club A',
  }]);
});

test('applyRepairPlan safely handles filenames that swap places', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-repair-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const first = path.join(folder, 'First.mp4');
  const second = path.join(folder, 'Second.mp4');
  fs.writeFileSync(first, 'first-video');
  fs.writeFileSync(second, 'second-video');

  const matches = [
    {
      file: { filePath: first },
      row: { skaterName: 'Second' },
      confidence: 'high',
      reason: 'test',
    },
    {
      file: { filePath: second },
      row: { skaterName: 'First' },
      confidence: 'high',
      reason: 'test',
    },
  ];
  const plan = buildRepairPlan(matches, {
    settings: { localRecordingSorter: { filenameFormat: '{skaterName}.mp4' } },
  });

  applyRepairPlan(plan);
  assert.equal(fs.readFileSync(first, 'utf8'), 'second-video');
  assert.equal(fs.readFileSync(second, 'utf8'), 'first-video');
  assert.equal(fs.readdirSync(folder).filter(name => name.startsWith('.recording-repair-')).length, 0);
});
