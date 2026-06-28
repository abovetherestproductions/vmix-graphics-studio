const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  applyRepairPlan,
  buildRecordingSessions,
  buildRepairPlan,
  listMp4Files,
  matchFilesToSessions,
  parseActionLog,
} = require('./recordingRepair');

function createRecordingRepairService({ rootDir, getSettings, logger }) {
  const logPath = path.join(rootDir, 'logs', 'recording-actions.log');
  let pending = null;

  function publicItem(item, reviewFolder) {
    return {
      source: path.relative(reviewFolder, item.sourcePath) || path.basename(item.sourcePath),
      target: path.relative(reviewFolder, item.targetPath) || path.basename(item.targetPath),
      confidence: item.confidence,
      eligible: item.eligible,
      noChange: item.noChange,
      reason: item.reason,
      timestampDifferenceSeconds: item.deltaMs == null ? null : Math.round(item.deltaMs / 1000),
    };
  }

  function scan() {
    const settings = getSettings();
    const reviewFolder = settings.localRecordingSorter?.needsReviewFolder;
    if (!reviewFolder || !fs.existsSync(reviewFolder)) {
      throw new Error(`Needs Review folder does not exist: ${reviewFolder || '(blank)'}`);
    }
    if (!fs.existsSync(logPath)) {
      throw new Error(`Recording action log does not exist: ${logPath}`);
    }

    const reviewFiles = listMp4Files(reviewFolder);
    const sessions = buildRecordingSessions(parseActionLog(fs.readFileSync(logPath, 'utf8')));
    const result = matchFilesToSessions(reviewFiles, sessions);
    const plan = buildRepairPlan(result.matches, { settings });
    const token = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    pending = { token, createdAt, reviewFolder, plan };

    const changes = plan.filter(item => item.eligible && !item.noChange);
    const held = plan.filter(item => !item.eligible);
    const response = {
      success: true,
      token,
      createdAt,
      reviewFolder,
      totalFiles: reviewFiles.length,
      matched: plan.length,
      eligibleChanges: changes.length,
      alreadyCorrect: plan.filter(item => item.noChange).length,
      needsReview: held.length + result.unmatchedFiles.length,
      items: plan.map(item => publicItem(item, reviewFolder)),
      unmatchedFiles: result.unmatchedFiles.map(file => path.relative(reviewFolder, file.filePath)),
    };
    logger.log('recording repair scanned', {
      reviewFolder,
      totalFiles: response.totalFiles,
      matched: response.matched,
      eligibleChanges: response.eligibleChanges,
      needsReview: response.needsReview,
    });
    return response;
  }

  function validatePendingPlan(token) {
    if (!pending || token !== pending.token) {
      throw new Error('This repair proposal is no longer current. Scan again before applying.');
    }

    const sourcePaths = new Set(pending.plan.map(item => path.resolve(item.sourcePath)));
    for (const item of pending.plan.filter(entry => entry.eligible && !entry.noChange)) {
      if (!fs.existsSync(item.sourcePath)) {
        throw new Error(`A source file changed after the scan: ${path.basename(item.sourcePath)}. Scan again.`);
      }
      const stat = fs.statSync(item.sourcePath);
      if (
        (item.sourceSize != null && stat.size !== item.sourceSize)
        || (item.sourceMtimeMs != null && Math.abs(stat.mtimeMs - item.sourceMtimeMs) > 1)
      ) {
        throw new Error(`A source file changed after the scan: ${path.basename(item.sourcePath)}. Scan again.`);
      }
      if (fs.existsSync(item.targetPath) && !sourcePaths.has(path.resolve(item.targetPath))) {
        throw new Error(`A destination file appeared after the scan: ${path.basename(item.targetPath)}. Scan again.`);
      }
    }
  }

  function apply(token) {
    validatePendingPlan(token);
    const proposal = pending;
    pending = null;
    const completed = applyRepairPlan(proposal.plan);
    logger.log('recording repair applied', {
      reviewFolder: proposal.reviewFolder,
      renamed: completed.map(item => ({
        from: path.basename(item.sourcePath),
        to: path.basename(item.targetPath),
        confidence: item.confidence,
      })),
    });
    return {
      success: true,
      reviewFolder: proposal.reviewFolder,
      renamed: completed.length,
      items: completed.map(item => ({
        source: path.relative(proposal.reviewFolder, item.sourcePath),
        target: path.relative(proposal.reviewFolder, item.targetPath),
      })),
      message: `Applied ${completed.length} recording filename repair${completed.length === 1 ? '' : 's'}.`,
    };
  }

  return { scan, apply };
}

module.exports = { createRecordingRepairService };
