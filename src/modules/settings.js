const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  vmix: {
    vmixHost: process.env.VMIX_HOST || '127.0.0.1',
    vmixPort: Number(process.env.VMIX_PORT) || 8088,
    vmixRecordingFolder: 'C:\\vMixRecordings',
    defaultBrowserInputName: 'GFX',
    defaultOverlayNumber: 1,
    overlayOutDelayMs: 900,
    graphicOverlays: {},
  },
  localRecordingSorter: {
    // C: because most production machines are single-drive. Operators with a
    // dedicated media drive change these in Production Control; the folders
    // are created on demand, so no drive needs to exist up front.
    outputRootFolder: 'C:\\SkatingVideos',
    needsReviewFolder: 'C:\\SkatingVideos\\_Needs Review',
    createCategoryFoldersAutomatically: true,
    filenameFormat: '{skaterName}.mp4',
    categoryRecordingFilenameFormat: '{eventName} - {categoryName} - Segment {segmentNumber}.mp4',
    metadataSource: 'manual-skater',
  },
  dailymotion: {
    dailymotionEnabled: false,
    dailymotionLiveVideoId: '',
    dailymotionVodTitleFormat: '{eventName} - {categoryName}',
    dailymotionVodDescriptionFormat: '',
    dailymotionAccountLabel: '',
  },
  safety: {
    preferStopSnapshotForFileNaming: false,
    captureStartSnapshotForAudit: true,
    moveUncertainFilesToNeedsReview: true,
    writeActionLog: true,
    preventOverwrite: true,
  },
};

function mergeDeep(base, incoming) {
  if (!incoming || typeof incoming !== 'object') return { ...base };
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function createSettingsService(rootDir) {
  const configDir = path.join(rootDir, 'config');
  const settingsPath = path.join(configDir, 'settings.json');

  function ensureSettingsFile() {
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    }
  }

  function readSettings() {
    ensureSettingsFile();
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return mergeDeep(DEFAULT_SETTINGS, raw);
    } catch {
      return mergeDeep(DEFAULT_SETTINGS, {});
    }
  }

  function writeSettings(incoming) {
    const merged = mergeDeep(readSettings(), incoming || {});
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  function getPublicSettings() {
    return readSettings();
  }

  function validateSettings(settings = readSettings()) {
    const warnings = [];
    if (!settings.vmix?.vmixHost) warnings.push('vMix host is missing.');
    if (!settings.vmix?.vmixPort) warnings.push('vMix port is missing.');
    if (!settings.vmix?.vmixRecordingFolder) warnings.push('vMix recording folder is missing.');
    if (!settings.localRecordingSorter?.outputRootFolder) warnings.push('Output root folder is missing.');
    if (!settings.localRecordingSorter?.needsReviewFolder) warnings.push('Needs Review folder is missing.');
    if (settings.dailymotion?.dailymotionEnabled && !settings.dailymotion?.dailymotionLiveVideoId) {
      warnings.push('Dailymotion is enabled but live video ID is missing.');
    }
    if (settings.dailymotion?.dailymotionEnabled && !process.env.DAILYMOTION_ACCESS_TOKEN) {
      warnings.push('Dailymotion is enabled but DAILYMOTION_ACCESS_TOKEN is missing.');
    }
    return warnings;
  }

  ensureSettingsFile();
  return { settingsPath, readSettings, writeSettings, getPublicSettings, validateSettings };
}

module.exports = { DEFAULT_SETTINGS, createSettingsService, mergeDeep };
