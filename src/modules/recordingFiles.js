const fs = require('fs');
const path = require('path');

const ILLEGAL_WINDOWS_CHARS = /[\\/:*?"<>|]/g;

function pathApiFor(basePath) {
  return /^[A-Za-z]:[\\/]/.test(String(basePath || '')) || /^\\\\/.test(String(basePath || ''))
    ? path.win32
    : path;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(value) {
  const cleaned = String(value || '')
    .replace(ILLEGAL_WINDOWS_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Unknown';
}

function sanitizeFolderName(value) {
  return sanitizeFileName(value);
}

function padStartOrder(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(num).padStart(3, '0');
}

function applyTemplate(format, snapshot = {}) {
  return String(format || '')
    .replace(/\{eventName\}/g, sanitizeFileName(snapshot.eventName || ''))
    .replace(/\{categoryName\}/g, sanitizeFileName(snapshot.categoryName || ''))
    .replace(/\{segmentName\}/g, sanitizeFileName(snapshot.segmentName || ''))
    .replace(/\{segmentNumber\}/g, sanitizeFileName(snapshot.segmentNumber || ''))
    .replace(/\{startOrder\}/g, padStartOrder(snapshot.startOrder) || '000')
    .replace(/\{skaterName\}/g, sanitizeFileName(snapshot.skaterName || 'Unknown Skater'))
    .replace(/\{club\}/g, sanitizeFileName(snapshot.club || 'Unknown Club'));
}

function hasSkaterMetadata(snapshot = {}) {
  return !!(snapshot.skaterName && snapshot.categoryName);
}

function buildFinalFileName(snapshot, settings) {
  const sorter = settings.localRecordingSorter || {};
  const format = sorter.filenameFormat || '{skaterName}.mp4';
  let fileName = applyTemplate(format, snapshot);
  if (!/\.mp4$/i.test(fileName)) fileName += '.mp4';
  return sanitizeFileName(fileName).replace(/\.mp4$/i, '') + '.mp4';
}

function buildNeedsReviewFileName(snapshot = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const skater = snapshot.skaterName ? ` - ${sanitizeFileName(snapshot.skaterName)}` : '';
  return `Recording ${stamp}${skater}.mp4`;
}

function buildCategoryFolder(snapshot, settings) {
  const sorter = settings.localRecordingSorter || {};
  const root = sorter.outputRootFolder || 'D:\\SkatingVideos';
  const category = sanitizeFolderName(snapshot.categoryName || 'Unknown Category');
  const rawSeg = (snapshot.segmentName || '').replace(/\s+program$/i, '').trim();
  const segment = rawSeg ? sanitizeFolderName(rawSeg) : '';
  const folderName = segment ? `${category} ${segment}` : category;
  return pathApiFor(root).join(root, folderName);
}

function preventOverwriteByAddingSuffix(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const pathApi = pathApiFor(filePath);
  const parsed = pathApi.parse(filePath);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = pathApi.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find available filename for ${filePath}`);
}

function findNewestMp4Since(folder, timestamp) {
  if (!folder || !fs.existsSync(folder)) {
    return { filePath: null, candidates: [], warning: `Recording folder does not exist: ${folder}` };
  }
  const pathApi = pathApiFor(folder);
  const sinceMs = new Date(timestamp).getTime();
  const candidates = fs.readdirSync(folder)
    .filter(name => /\.mp4$/i.test(name))
    .map(name => {
      const filePath = pathApi.join(folder, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
    })
    .filter(item => Math.max(item.mtimeMs, item.ctimeMs) >= sinceMs - 5000)
    .sort((a, b) => Math.max(b.mtimeMs, b.ctimeMs) - Math.max(a.mtimeMs, a.ctimeMs));

  return {
    filePath: candidates[0]?.filePath || null,
    candidates,
    warning: candidates.length > 1 ? 'Multiple possible MP4 files were found; selected the newest one.' : null,
  };
}

async function waitForRecordingFile({ folder, timestamp, expectedFilePath }, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const intervalMs = options.intervalMs || 1000;
  const started = Date.now();
  let latest = { filePath: null, candidates: [], warning: null };

  while (Date.now() - started < timeoutMs) {
    if (expectedFilePath && fs.existsSync(expectedFilePath)) {
      return { filePath: expectedFilePath, candidates: [], warning: null };
    }

    if (!expectedFilePath) {
      latest = findNewestMp4Since(folder, timestamp);
      if (latest.filePath) return latest;
    }

    await sleep(intervalMs);
  }

  const target = expectedFilePath || folder;
  return {
    ...latest,
    warning: expectedFilePath
      ? `Recording file did not appear within ${timeoutMs}ms: ${target}`
      : latest.warning || `No MP4 appeared in the recording folder within ${timeoutMs}ms: ${target}`,
  };
}

async function isFileLocked(filePath) {
  try {
    const handle = await fs.promises.open(filePath, 'r+');
    await handle.close();
    return false;
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return true;
    if (err.code === 'ENOENT') return true;
    return false;
  }
}

async function waitForFileToFinalize(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  const intervalMs = options.intervalMs || 1000;
  const stableChecksNeeded = options.stableChecksNeeded || 3;
  const started = Date.now();
  let lastSize = -1;
  let stableChecks = 0;

  while (Date.now() - started < timeoutMs) {
    if (!fs.existsSync(filePath)) {
      await sleep(intervalMs);
      continue;
    }
    const stat = fs.statSync(filePath);
    const locked = await isFileLocked(filePath);
    if (stat.size > 0 && stat.size === lastSize && !locked) stableChecks += 1;
    else stableChecks = 0;
    lastSize = stat.size;
    if (stableChecks >= stableChecksNeeded) {
      return { finalized: true, size: stat.size };
    }
    await sleep(intervalMs);
  }

  return { finalized: false, warning: `MP4 did not finalize within ${timeoutMs}ms.` };
}

function moveRecordingToFinalFolder(rawFilePath, finalFolder, finalFileName, settings) {
  fs.mkdirSync(finalFolder, { recursive: true });
  const desired = pathApiFor(finalFolder).join(finalFolder, finalFileName);
  const finalPath = settings.safety?.preventOverwrite === false
    ? desired
    : preventOverwriteByAddingSuffix(desired);
  try {
    fs.renameSync(rawFilePath, finalPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(rawFilePath, finalPath, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(rawFilePath);
  }
  return finalPath;
}

function testFolderAccess(folderPath) {
  try {
    if (!folderPath) return { success: false, message: 'Folder path is blank.' };
    fs.mkdirSync(folderPath, { recursive: true });
    fs.accessSync(folderPath, fs.constants.R_OK | fs.constants.W_OK);
    return { success: true, folderPath };
  } catch (err) {
    return { success: false, folderPath, error: err.message };
  }
}

function previewLocalFilename(snapshot, settings) {
  const folder = hasSkaterMetadata(snapshot)
    ? buildCategoryFolder(snapshot, settings)
    : settings.localRecordingSorter?.needsReviewFolder;
  const fileName = hasSkaterMetadata(snapshot)
    ? buildFinalFileName(snapshot, settings)
    : buildNeedsReviewFileName(snapshot);
  return pathApiFor(folder).join(folder, fileName);
}

module.exports = {
  findNewestMp4Since,
  waitForRecordingFile,
  waitForFileToFinalize,
  isFileLocked,
  sanitizeFileName,
  sanitizeFolderName,
  buildFinalFileName,
  buildNeedsReviewFileName,
  buildCategoryFolder,
  moveRecordingToFinalFolder,
  preventOverwriteByAddingSuffix,
  hasSkaterMetadata,
  testFolderAccess,
  previewLocalFilename,
};
