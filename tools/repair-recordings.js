#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  applyRepairPlan,
  buildRecordingSessions,
  buildRepairPlan,
  listMp4Files,
  matchFilesToSessions,
  matchFilesToStartOrder,
  parseActionLog,
  readStartOrderRows,
} = require('../src/modules/recordingRepair');

const ROOT_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (['apply', 'help', 'include-low', 'move'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function usage() {
  console.log(`
Recording repair utility

Dry-run from the recording action log:
  npm run recordings:repair -- --folder "C:\\SkatingVideos\\_Needs Review"

Dry-run from a saved Skate Canada start-order CSV:
  npm run recordings:repair -- --folder "C:\\SkatingVideos\\_Needs Review\\Category" --start-order "C:\\path\\StartOrder.csv" --segment "Pre-Novice Women - Free Program"

Options:
  --apply                 Perform eligible renames after showing the plan
  --include-low           Allow low-confidence log matches
  --log PATH              Action log path (default: logs/recording-actions.log)
  --move                  Move log matches to their original category folders
  --start-order PATH      Match chronological files to a start-order CSV
  --segment NAME          Limit the CSV to one exact SegmentName
  --window-minutes N      Maximum log timestamp difference (default: 30)
`);
}

function formatDelta(deltaMs) {
  if (deltaMs == null) return '-';
  return `${Math.round(deltaMs / 1000)}s`;
}

function printPlan(plan) {
  if (!plan.length) {
    console.log('No safe repair matches were found.');
    return;
  }

  console.log('\nProposed recording repairs:\n');
  plan.forEach((item, index) => {
    const action = item.noChange ? 'OK' : item.eligible ? 'RENAME' : 'REVIEW';
    console.log(`${String(index + 1).padStart(3)}. [${action}] [${item.confidence}] ${path.basename(item.sourcePath)}`);
    if (!item.noChange) console.log(`     -> ${path.basename(item.targetPath)}`);
    console.log(`     ${item.reason}; timestamp difference ${formatDelta(item.deltaMs)}`);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const settingsPath = path.join(ROOT_DIR, 'config', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const folder = path.resolve(args.folder || settings.localRecordingSorter?.needsReviewFolder || '');
  if (!folder || !fs.existsSync(folder)) {
    throw new Error(`Review folder does not exist: ${folder || '(blank)'}`);
  }

  const files = listMp4Files(folder);
  let result;
  if (args['start-order']) {
    const rows = readStartOrderRows(fs.readFileSync(path.resolve(args['start-order']), 'utf8'), {
      segment: args.segment,
    });
    result = matchFilesToStartOrder(files, rows);
    if (result.error) throw new Error(`${result.error} No files were changed.`);
  } else {
    const logPath = path.resolve(args.log || path.join(ROOT_DIR, 'logs', 'recording-actions.log'));
    const sessions = buildRecordingSessions(parseActionLog(fs.readFileSync(logPath, 'utf8')));
    result = matchFilesToSessions(files, sessions, {
      windowMs: Number(args['window-minutes'] || 30) * 60 * 1000,
    });
  }

  const plan = buildRepairPlan(result.matches, {
    settings,
    includeLowConfidence: args['include-low'] === true,
    moveToCategoryFolders: args.move === true,
  });
  printPlan(plan);

  console.log(`\nMatched: ${plan.length}/${files.length}`);
  console.log(`Eligible changes: ${plan.filter(item => item.eligible && !item.noChange).length}`);
  console.log(`Needs review: ${plan.filter(item => !item.eligible).length + (result.unmatchedFiles?.length || 0)}`);

  if (!args.apply) {
    console.log('\nDry run only. Add --apply after reviewing the mapping.');
    return;
  }

  const completed = applyRepairPlan(plan);
  console.log(`\nApplied ${completed.length} collision-safe rename${completed.length === 1 ? '' : 's'}.`);
}

try {
  main();
} catch (err) {
  console.error(`Recording repair stopped: ${err.message}`);
  process.exitCode = 1;
}
