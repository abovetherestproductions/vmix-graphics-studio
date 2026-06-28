const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const {
  buildFinalFileName,
  sanitizeFileName,
} = require('./recordingFiles');

function parseActionLog(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return {
          action: 'invalid log line',
          at: null,
          details: { lineNumber: index + 1, error: err.message },
        };
      }
    });
}

function buildRecordingSessions(entries) {
  const sessions = new Map();

  for (const entry of entries) {
    const details = entry.details || {};
    const sessionId = details.sessionId || details.session?.sessionId;
    if (!sessionId) continue;

    const session = sessions.get(sessionId) || { sessionId };
    if (entry.action === 'recording started') {
      session.startedAt = entry.at;
      session.startSnapshot = details.startSnapshot || details.session?.startSnapshot || null;
      session.filePlan = details.filePlan || details.session?.filePlan || null;
    } else if (entry.action === 'recording stopped') {
      session.stoppedAt = entry.at;
      session.stopSnapshot = details.stopSnapshot || null;
      session.rawFilePath = details.rawFilePath || session.rawFilePath;
    } else if (entry.action === 'raw MP4 detected') {
      session.rawFilePath = details.rawFilePath || session.rawFilePath;
    } else if (entry.action === 'final MP4 path') {
      session.finalFilePath = details.finalFilePath || session.finalFilePath;
      session.status = details.status || session.status;
    }
    sessions.set(sessionId, session);
  }

  return Array.from(sessions.values())
    .map(session => {
      const snapshot = session.filePlan?.snapshot
        || session.startSnapshot
        || session.stopSnapshot
        || {};
      const expectedFileName = session.filePlan?.finalFileName
        || (snapshot.skaterName ? `${sanitizeFileName(snapshot.skaterName)}.mp4` : '');
      return {
        ...session,
        snapshot,
        expectedFileName,
        matchTimeMs: Date.parse(session.stoppedAt || session.startedAt || ''),
      };
    })
    .filter(session => session.expectedFileName && Number.isFinite(session.matchTimeMs))
    .sort((a, b) => a.matchTimeMs - b.matchTimeMs);
}

function listMp4Files(folder) {
  const output = [];

  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
        const stat = fs.statSync(filePath);
        output.push({
          filePath,
          fileName: entry.name,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
  }

  visit(folder);
  return output.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function confidenceForDelta(deltaMs) {
  if (deltaMs <= 2 * 60 * 1000) return 'high';
  if (deltaMs <= 10 * 60 * 1000) return 'medium';
  return 'low';
}

function matchFilesToSessions(files, sessions, options = {}) {
  const windowMs = options.windowMs || 30 * 60 * 1000;
  const edges = [];

  files.forEach((file, fileIndex) => {
    sessions.forEach((session, sessionIndex) => {
      const deltaMs = Math.abs(file.mtimeMs - session.matchTimeMs);
      if (deltaMs <= windowMs) edges.push({ fileIndex, sessionIndex, deltaMs });
    });
  });

  edges.sort((a, b) => a.deltaMs - b.deltaMs);
  const usedFiles = new Set();
  const usedSessions = new Set();
  const matches = [];

  for (const edge of edges) {
    if (usedFiles.has(edge.fileIndex) || usedSessions.has(edge.sessionIndex)) continue;
    usedFiles.add(edge.fileIndex);
    usedSessions.add(edge.sessionIndex);
    matches.push({
      file: files[edge.fileIndex],
      session: sessions[edge.sessionIndex],
      deltaMs: edge.deltaMs,
      confidence: confidenceForDelta(edge.deltaMs),
      reason: 'recording log timestamp',
    });
  }

  return {
    matches: matches.sort((a, b) => a.file.mtimeMs - b.file.mtimeMs),
    unmatchedFiles: files.filter((_file, index) => !usedFiles.has(index)),
    unmatchedSessions: sessions.filter((_session, index) => !usedSessions.has(index)),
  };
}

function normalizeSegment(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function readStartOrderRows(csvText, options = {}) {
  const records = parse(String(csvText || '').replace(/^\uFEFF/, ''), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  const requestedSegment = normalizeSegment(options.segment);
  return records
    .filter(row => row.Skater && (!requestedSegment || normalizeSegment(row.SegmentName) === requestedSegment))
    .map(row => ({
      skaterName: String(row.Skater).trim(),
      segmentName: String(row.SegmentName || '').trim(),
      position: Number(row.Position) || null,
      club: String(row.Club || '').trim(),
    }));
}

function matchFilesToStartOrder(files, rows) {
  if (files.length !== rows.length) {
    return {
      matches: [],
      unmatchedFiles: files,
      unmatchedRows: rows,
      error: `File count (${files.length}) does not match start-order count (${rows.length}).`,
    };
  }

  return {
    matches: files.map((file, index) => ({
      file,
      row: rows[index],
      confidence: 'high',
      reason: 'chronological file order and start-order CSV',
    })),
    unmatchedFiles: [],
    unmatchedRows: [],
    error: null,
  };
}

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function addSuffix(filePath, number) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name} (${number})${parsed.ext}`);
}

function reserveAvailableTarget(desiredPath, sourcePaths, reservedTargets) {
  let candidate = desiredPath;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const key = pathKey(candidate);
    const occupiedByUnrelatedFile = fs.existsSync(candidate) && !sourcePaths.has(key);
    if (!occupiedByUnrelatedFile && !reservedTargets.has(key)) {
      reservedTargets.add(key);
      return candidate;
    }
    candidate = addSuffix(desiredPath, suffix);
  }
  throw new Error(`Could not reserve a target filename for ${desiredPath}`);
}

function buildRepairPlan(matches, options = {}) {
  const settings = options.settings || {};
  const moveToCategoryFolders = options.moveToCategoryFolders === true;
  const includeLowConfidence = options.includeLowConfidence === true;
  const sourcePaths = new Set(matches.map(match => pathKey(match.file.filePath)));
  const reservedTargets = new Set();

  return matches.map(match => {
    const snapshot = match.session?.snapshot || {
      skaterName: match.row?.skaterName,
      club: match.row?.club,
      segmentName: match.row?.segmentName,
    };
    const expectedFileName = match.session?.expectedFileName
      || buildFinalFileName(snapshot, settings);
    const desiredFolder = moveToCategoryFolders && match.session?.filePlan?.finalFolder
      ? match.session.filePlan.finalFolder
      : path.dirname(match.file.filePath);
    const desiredPath = path.join(desiredFolder, expectedFileName);
    const targetPath = reserveAvailableTarget(desiredPath, sourcePaths, reservedTargets);
    const confidence = match.confidence || 'high';
    const eligible = confidence !== 'low' || includeLowConfidence;

    return {
      sourcePath: match.file.filePath,
      targetPath,
      expectedFileName,
      confidence,
      eligible,
      reason: match.reason,
      deltaMs: match.deltaMs ?? null,
      sessionId: match.session?.sessionId || null,
      sourceMtimeMs: match.file.mtimeMs ?? null,
      sourceSize: match.file.size ?? null,
      noChange: pathKey(match.file.filePath) === pathKey(targetPath),
    };
  });
}

function applyRepairPlan(plan) {
  const changes = plan.filter(item => item.eligible && !item.noChange);
  const staged = [];

  try {
    for (const item of changes) {
      const tempPath = path.join(
        path.dirname(item.sourcePath),
        `.recording-repair-${crypto.randomUUID()}${path.extname(item.sourcePath)}`,
      );
      fs.renameSync(item.sourcePath, tempPath);
      staged.push({ ...item, tempPath });
    }
  } catch (err) {
    for (const item of staged.reverse()) {
      if (fs.existsSync(item.tempPath) && !fs.existsSync(item.sourcePath)) {
        fs.renameSync(item.tempPath, item.sourcePath);
      }
    }
    throw err;
  }

  const completed = [];
  try {
    for (const item of staged) {
      fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
      fs.renameSync(item.tempPath, item.targetPath);
      completed.push(item);
    }
  } catch (err) {
    for (const item of completed.reverse()) {
      if (fs.existsSync(item.targetPath) && !fs.existsSync(item.sourcePath)) {
        fs.renameSync(item.targetPath, item.sourcePath);
      }
    }
    for (const item of staged) {
      if (fs.existsSync(item.tempPath) && !fs.existsSync(item.sourcePath)) {
        fs.renameSync(item.tempPath, item.sourcePath);
      }
    }
    throw err;
  }

  return completed;
}

module.exports = {
  applyRepairPlan,
  buildRecordingSessions,
  buildRepairPlan,
  confidenceForDelta,
  listMp4Files,
  matchFilesToSessions,
  matchFilesToStartOrder,
  parseActionLog,
  readStartOrderRows,
};
