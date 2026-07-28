const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const zlib        = require('zlib');
const express     = require('express');
const { WebSocketServer } = require('ws');
const chokidar    = require('chokidar');
const normalizers = require('./normalizers');
const sc          = require('./normalizers/skate-canada-json');
const csvAdapter  = require('./normalizers/csv-adapter');
const { loadEnvFile } = require('./src/modules/env');

loadEnvFile(__dirname);

const { createSettingsService } = require('./src/modules/settings');
const { createStateService } = require('./src/modules/state');
const { createVmixService } = require('./src/modules/vmix');
const { createActionLogger } = require('./src/modules/actionLogger');
const { createRecordingController } = require('./src/modules/recordingController');
const { createRecordingRepairService } = require('./src/modules/recordingRepairService');
const { createDailymotionService } = require('./src/modules/dailymotion');
const { registerProductionRoutes } = require('./src/modules/productionRoutes');
const { createMessagesService } = require('./src/modules/messages');
const { createManualSkatersService } = require('./src/modules/manualSkaters');
const { createSkaterExtrasService } = require('./src/modules/skaterExtras');
const { createScApiService }         = require('./src/modules/scApiService');
const { createVmixClient }           = require('./src/modules/vmixClient');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3012;

const DATA_DIR   = path.join(__dirname, 'public', 'data');
// Fresh clones don't have this folder (git ignores its contents) — create it
// so writeConfig/writeData never fail with ENOENT on a new install.
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Layered config: defaults (shipped) → style overrides → event state ──────
// Three files, one merged view. The layering is what makes `git pull` a safe
// update mechanism for installs out in the field:
//
//   style-defaults.json — TRACKED. The studio's look, shipped with every
//                         update. Nothing on a user's machine writes here, so
//                         it is never locally modified and a pull can always
//                         fast-forward it.
//   style-config.json   — IGNORED. Only the keys this machine has actually
//                         CHANGED from the defaults (a minimal diff). Untouched
//                         settings stay absent, so new studio defaults flow
//                         through on update while local tweaks survive.
//   event-state.json    — IGNORED. Machine-local event selection, workbook
//                         paths, and the API-derived names the poller rewrites
//                         every tick.
//   event-config.json   — IGNORED. Derived merged cache the graphics read.
//
// readConfig() deep-merges defaults ← overrides ← state into one object, so all
// downstream code is unchanged; writeConfig() routes each key back to its file.
const STYLE_DEFAULTS_FILE = path.join(DATA_DIR, 'style-defaults.json');
const STYLE_FILE  = path.join(DATA_DIR, 'style-config.json');
const STATE_FILE  = path.join(DATA_DIR, 'event-state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'event-config.json'); // legacy — migration source only
// Keys that live in event-state.json (machine-local). Everything else is style.
// The workbook groups are here because their paths point at files under
// uploads/ on THIS machine — shipping them to another install is meaningless
// and would dirty a tracked file on every upload.
const LOCAL_CONFIG_KEYS = new Set([
  'dataSource', 'machineName',
  'eventName', 'eventNameFr', 'eventLocation', 'eventLocationFr',
  'eventDate', 'eventDateFr', 'eventSubtitle', 'headerSubtitle', 'logoPath',
  'categoryName', 'categoryNameFr', 'segmentName', 'segmentNameFr', 'segmentNumber',
  'messages', 'manualSkaters', 'skaterExtras',
]);
const DEFAULT_CSV_FILES = {
  eventInfo: 'SC2_csslivetextEventInfo.csv',
  startOrder: 'SC2_csslivetextStartOrder.csv',
  currentSkater: 'SC2_csslivetextCurrentSkater.csv',
  scores: 'SC2_csslivetextScores.csv',
  ranking: 'SC2_csslivetextRanking.csv',
  officials: 'SC2_csslivetextOfficials.csv',
  liveElements: 'sc2_csslivescoring.csv',
};

// ── Known templates ────────────────────────────────────────────────────────
const TEMPLATES = [
  'starting-order',
  'scoring',
  'lower-third',
  'standings',
  'officials',
  'elements',
  'messages',
  'manual-skater',
  'interview',
  'clock',
  'time-of-day',
  'skater-profile',
  'rankings',
];

// In-memory cache for full ranking data (used for page slicing)
const rankingsCache = { allRows: [], rowsPerPage: 6, pages: [], groupedPageMode: false };
const startOrderCache = { groups: [], sourcePath: null };
const previewStartOrderCache = new Map();
let startOrderGroupSelection = null;

/** Warm the rankings cache from the on-disk data file (called at startup and after data writes) */
function warmRankingsCache() {
  try {
    const fp = path.join(DATA_DIR, 'rankings.json');
    if (!fs.existsSync(fp)) return;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // Prefer allRows (full dataset); fall back to rows (current page) if allRows is absent/empty
    const src = d?.data?.allRows?.length ? d.data.allRows : d?.data?.rows;
    if (Array.isArray(src) && src.length > 0) {
      rankingsCache.allRows     = src;
      rankingsCache.rowsPerPage = d.data.rowsPerPage || rankingsCache.rowsPerPage;
    }
    rankingsCache.pages = Array.isArray(d?.data?.groupedPages) ? d.data.groupedPages : [];
    rankingsCache.groupedPageMode = !!d?.data?.groupedPageMode;
  } catch { /* ignore */ }
}
// Warm immediately so page controls work right after server restart
warmRankingsCache();

function warmStartOrderSelection() {
  try {
    const fp = path.join(DATA_DIR, 'starting-order.json');
    if (!fs.existsSync(fp)) return;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const group = Number(d?.data?.groupNumber);
    if (group >= 1) startOrderGroupSelection = group;
  } catch { /* ignore */ }
}
warmStartOrderSelection();

const graphicState = {};
TEMPLATES.forEach(t => { graphicState[t] = { visible: false, state: 'hidden' }; });

// On startup, force all graphic JSON files to hidden so server state matches
// a freshly-launched vMix (no overlays on-air). Without this, a previous
// session's `visible: true` state lingers on disk and causes Companion toggles
// to require two presses to re-sync.
TEMPLATES.forEach(t => {
  const fp = path.join(DATA_DIR, `${t}.json`);
  if (!fs.existsSync(fp)) return;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (data?.control?.visible) {
      data.control.visible = false;
      data.control.state = 'hidden';
      data.meta = data.meta || {};
      data.meta.revision = (data.meta.revision || 0) + 1;
      data.meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    }
  } catch { /* ignore corrupt files */ }
});

const settingsService = createSettingsService(__dirname);
const stateService = createStateService(__dirname, {
  // event/category/segment names live in the local state file now
  eventConfigPath: STATE_FILE,
  startingOrderPath: path.join(DATA_DIR, 'starting-order.json'),
  scoringPath: path.join(DATA_DIR, 'scoring.json'),
  manualSkaterPath: path.join(DATA_DIR, 'manual-skater.json'),
  settingsPath: path.join(__dirname, 'config', 'settings.json'),
});
const actionLogger = createActionLogger(__dirname, () => settingsService.readSettings());
const vmixService = createVmixService(() => settingsService.readSettings());
const recordingController = createRecordingController({
  getSettings: () => settingsService.readSettings(),
  stateService,
  vmixService,
  logger: actionLogger,
});
const recordingRepairService = createRecordingRepairService({
  rootDir: __dirname,
  getSettings: () => settingsService.readSettings(),
  logger: actionLogger,
});
const dailymotionService = createDailymotionService(
  () => settingsService.readSettings(),
  () => stateService.snapshot(),
  actionLogger
);

// ── Helpers ────────────────────────────────────────────────────────────────
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

// Layer `override` on top of `base`. Nested objects merge key-by-key so a
// machine that changed one theme colour keeps inheriting the rest; arrays are
// replaced wholesale (a partial array merge is never what you want here).
function deepMerge(base, override) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// Reduce a full style object to only what differs from the shipped defaults.
// This is what keeps updates non-destructive: anything the operator never
// touched is simply absent, so a new studio default reaches them untouched.
function diffFromDefaults(obj, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const d = isPlainObject(defaults) ? defaults[k] : undefined;
    if (isPlainObject(v) && isPlainObject(d)) {
      const sub = diffFromDefaults(v, d);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (!deepEqual(v, d)) {
      out[k] = v;
    }
  }
  return out;
}

function readStyleDefaults() { return readJsonSafe(STYLE_DEFAULTS_FILE); }

// Migration + self-healing normalisation. Runs on every boot and is idempotent.
// Handles, in order:
//   • Legacy install (event-config.json only) → derive overrides + state.
//   • A machine upgrading from the flat split, whose style-config.json holds a
//     FULL copy of the style → compact it to a minimal diff so future studio
//     defaults can reach it.
//   • Machine-local keys (workbook paths) previously filed under style → move
//     them into event-state.json where a pull can never touch them.
function migrateConfigIfNeeded() {
  const defaults = readStyleDefaults();
  try {
    let style = fs.existsSync(STYLE_FILE) ? readJsonSafe(STYLE_FILE) : null;
    let state = fs.existsSync(STATE_FILE) ? readJsonSafe(STATE_FILE) : null;

    // Legacy: derive whatever is missing from the old merged file.
    if ((style === null || state === null) && fs.existsSync(CONFIG_FILE)) {
      const split = splitConfig(readJsonSafe(CONFIG_FILE));
      if (style === null) style = split.style;
      if (state === null) state = split.state;
      console.log('[config] migrated legacy event-config.json');
    }
    if (style === null && state === null) return; // fresh install — pure defaults
    style = style || {};
    state = state || {};

    // Relocate machine-local keys that an older build filed under style.
    let moved = 0;
    for (const k of Object.keys(style)) {
      if (!LOCAL_CONFIG_KEYS.has(k)) continue;
      if (!(k in state)) state[k] = style[k];
      delete style[k];
      moved++;
    }
    if (moved) console.log(`[config] moved ${moved} machine-local key(s) into event-state.json`);

    // Compact the overrides to a minimal diff against the shipped defaults.
    const minimal = diffFromDefaults(style, defaults);
    if (!deepEqual(style, minimal)) {
      const dropped = Object.keys(style).length - Object.keys(minimal).length;
      if (dropped > 0) console.log(`[config] ${dropped} setting(s) now match the shipped defaults — inheriting them`);
    }
    fs.writeFileSync(STYLE_FILE, JSON.stringify(minimal, null, 2));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[config] migration failed:', e.message);
  }
}

// Partition a merged config object into its style and local-state halves.
function splitConfig(cfg) {
  const style = {}, state = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    (LOCAL_CONFIG_KEYS.has(k) ? state : style)[k] = v;
  }
  return { style, state };
}

function readConfig() {
  // defaults (shipped) ← style overrides (this machine) ← event state (local).
  // Style and state keys are disjoint by design, so state applies flat on top.
  return { ...deepMerge(readStyleDefaults(), readJsonSafe(STYLE_FILE)), ...readJsonSafe(STATE_FILE) };
}

migrateConfigIfNeeded();

// ── Config history (auto-backup) + presets ───────────────────────────────
// Every save to event-config.json drops a timestamped snapshot into
// config/history/, keeping the last MAX_BACKUPS. Operators can roll back to
// any snapshot from the operator UI. Presets are named, hand-saved bundles
// living in config/presets/ — same shape as event-config.json but loaded
// on demand.
const CONFIG_HISTORY_DIR = path.join(__dirname, 'config', 'history');
const PRESETS_DIR        = path.join(__dirname, 'config', 'presets');
const MAX_BACKUPS = 20;

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function backupConfigFile() {
  // Snapshot the MERGED config (style + state) so a restore brings back
  // everything. Skip empty configs — no point snapshotting nothing.
  const merged = readConfig();
  if (!merged || !Object.keys(merged).length) return;
  const raw = JSON.stringify(merged, null, 2);
  ensureDir(CONFIG_HISTORY_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(CONFIG_HISTORY_DIR, `event-config-${stamp}.json`);
  try { fs.writeFileSync(fp, raw); } catch { return; }
  // Prune oldest beyond MAX_BACKUPS.
  try {
    const files = fs.readdirSync(CONFIG_HISTORY_DIR)
      .filter(f => f.startsWith('event-config-') && f.endsWith('.json'))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(CONFIG_HISTORY_DIR, oldest));
    }
  } catch { /* ignore */ }
}

// Write the local sources of truth plus the derived merged cache that the
// graphics + file-watcher consume. style-defaults.json is read-only here — the
// studio ships it and nothing on this machine may dirty it, which is precisely
// what lets `git pull --ff-only` keep working forever. Only the diff against
// those defaults is persisted, so settings the operator never touched stay
// inherited rather than frozen at today's value.
function persistConfig(cfg, { skipStyle = false } = {}) {
  const { style, state } = splitConfig(cfg);
  if (!skipStyle) {
    const overrides = diffFromDefaults(style, readStyleDefaults());
    fs.writeFileSync(STYLE_FILE, JSON.stringify(overrides, null, 2));
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); // derived cache
}

function writeConfig(cfg) {
  // Snapshot the PREVIOUS state before overwriting, so the most-recent
  // backup is always "the config as it was just before this save".
  backupConfigFile();
  persistConfig(cfg);
  broadcast({ type: 'config-update' });
}

function listConfigBackups() {
  ensureDir(CONFIG_HISTORY_DIR);
  try {
    return fs.readdirSync(CONFIG_HISTORY_DIR)
      .filter(f => f.startsWith('event-config-') && f.endsWith('.json'))
      .sort()
      .reverse() // newest first
      .map(name => {
        const fp = path.join(CONFIG_HISTORY_DIR, name);
        const stat = fs.statSync(fp);
        return { name, savedAt: stat.mtime.toISOString(), size: stat.size };
      });
  } catch { return []; }
}

function safePresetName(raw) {
  // Strip path separators and anything that'd let a caller escape PRESETS_DIR.
  return String(raw || '').replace(/[\/\\:*?"<>|]/g, '').replace(/^\.+/, '').trim();
}

function listPresets() {
  ensureDir(PRESETS_DIR);
  try {
    return fs.readdirSync(PRESETS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(name => {
        const fp = path.join(PRESETS_DIR, name);
        const stat = fs.statSync(fp);
        return { name: name.replace(/\.json$/i, ''), savedAt: stat.mtime.toISOString(), size: stat.size };
      });
  } catch { return []; }
}

/** Read current broadcast language from config (default 'en') */
function readLang() {
  return readConfig().language || 'en';
}

function buildUrl(cfg, endpoint) {
  const ds = cfg.dataSource || {};
  const base = (ds.baseUrl || '').replace(/\/$/, '');
  const inst = ds.instance || '';
  const file = (ds.urls || {})[endpoint] || '';
  if (!base || !file) return null;
  return `${base}/${file}?instance=${inst}`;
}

function getDataSourceMode(cfg = readConfig()) {
  const mode = cfg.dataSource?.mode;
  if (mode === 'csv-folder') return 'csv-folder';
  if (mode === 'sc-api')     return 'sc-api';
  return 'live-json';
}

function getCsvSettings(cfg = readConfig()) {
  const csv = cfg.dataSource?.csv || {};
  const folderPath = csv.folderPath || path.join(__dirname, 'CSV Data');
  const pollIntervalMs = Math.max(500, Number(csv.pollIntervalMs) || 1000);
  return {
    folderPath,
    pollIntervalMs,
    files: Object.assign({}, DEFAULT_CSV_FILES, csv.files || {}),
  };
}

function resolveCsvFileFromFolder(folderPath, preferredFile, key) {
  if (!folderPath || !fs.existsSync(folderPath)) return null;

  const entries = fs.readdirSync(folderPath);
  const byLower = new Map(entries.map(name => [name.toLowerCase(), name]));
  const preferred = preferredFile ? byLower.get(String(preferredFile).toLowerCase()) : null;
  if (preferred) return path.resolve(folderPath, preferred);

  const patterns = {
    eventInfo: [/eventinfo/i],
    startOrder: [/startorder/i, /segentries/i],
    currentSkater: [/currentskater/i],
    scores: [/scores/i],
    ranking: [/ranking/i],
    officials: [/officials/i],
    liveElements: [/livescoring/i, /element/i],
  };

  const match = entries.find(name => (patterns[key] || []).some(re => re.test(name)));
  return match ? path.resolve(folderPath, match) : null;
}

function csvFilePath(cfg, key) {
  const csv = getCsvSettings(cfg);
  const file = csv.files[key];
  if (!file) return null;
  const preferredPath = path.resolve(csv.folderPath, file);
  if (fs.existsSync(preferredPath)) return preferredPath;
  return resolveCsvFileFromFolder(csv.folderPath, file, key);
}

function dataFilePath(template) {
  return path.join(DATA_DIR, `${template}.json`);
}

function readData(template) {
  const fp = dataFilePath(template);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeData(template, payload) {
  fs.writeFileSync(dataFilePath(template), JSON.stringify(payload, null, 2));
}

function sourceContextFromConfig(cfg = readConfig()) {
  return {
    eventName: cfg.eventName || '',
    eventNameFr: cfg.eventNameFr || '',
    eventLocation: cfg.eventLocation || '',
    eventLocationFr: cfg.eventLocationFr || '',
    eventDate: cfg.eventDate || '',
    eventDateFr: cfg.eventDateFr || '',
    categoryName: cfg.categoryName || '',
    categoryNameFr: cfg.categoryNameFr || '',
    segmentName: cfg.segmentName || '',
    segmentNameFr: cfg.segmentNameFr || '',
  };
}

function applyEventInfoPatch(info) {
  if (!info) return false;
  try {
    const cfg = readConfig();
    const before = JSON.stringify({
      eventName: cfg.eventName || '',
      eventNameFr: cfg.eventNameFr || '',
      eventLocation: cfg.eventLocation || '',
      eventLocationFr: cfg.eventLocationFr || '',
      eventDate: cfg.eventDate || '',
      eventDateFr: cfg.eventDateFr || '',
      categoryName: cfg.categoryName || '',
      categoryNameFr: cfg.categoryNameFr || '',
      segmentName: cfg.segmentName || '',
      segmentNameFr: cfg.segmentNameFr || '',
      logoPath: cfg.logoPath || '',
      eventSubtitle: cfg.eventSubtitle || '',
    });

    if (info.eventName) cfg.eventName = info.eventName;
    if (info.eventNameFr) cfg.eventNameFr = info.eventNameFr;
    if (info.eventLocation) cfg.eventLocation = info.eventLocation;
    if (info.eventLocationFr) cfg.eventLocationFr = info.eventLocationFr;
    if (info.eventDate) cfg.eventDate = info.eventDate;
    if (info.eventDateFr && info.eventDateFr !== '-') cfg.eventDateFr = info.eventDateFr;
    if (info.categoryName) cfg.categoryName = info.categoryName;
    if (info.categoryNameFr) cfg.categoryNameFr = info.categoryNameFr;
    if (info.segmentName) cfg.segmentName = info.segmentName;
    if (info.segmentNameFr) cfg.segmentNameFr = info.segmentNameFr;
    if (info.logoPath && !/^logo path$/i.test(info.logoPath)) cfg.logoPath = info.logoPath;
    if (info.eventSubtitle) cfg.eventSubtitle = info.eventSubtitle;

    const after = JSON.stringify({
      eventName: cfg.eventName || '',
      eventNameFr: cfg.eventNameFr || '',
      eventLocation: cfg.eventLocation || '',
      eventLocationFr: cfg.eventLocationFr || '',
      eventDate: cfg.eventDate || '',
      eventDateFr: cfg.eventDateFr || '',
      categoryName: cfg.categoryName || '',
      categoryNameFr: cfg.categoryNameFr || '',
      segmentName: cfg.segmentName || '',
      segmentNameFr: cfg.segmentNameFr || '',
      logoPath: cfg.logoPath || '',
      eventSubtitle: cfg.eventSubtitle || '',
    });

    if (before === after) return false;
    // Suppress the file-watcher config-update broadcast for this write —
    // applyEventInfoPatch runs on every sc-api poll and must not flood the
    // operator with config-update messages that race with language changes.
    // Only local-state keys change here, so the tracked style-config.json is
    // rewritten with identical content (harmless) while event-state.json +
    // the derived cache carry the churn. The watcher keys on the cache write.
    _silentConfigWriteCount++;
    persistConfig(cfg, { skipStyle: true });
    return true;
  } catch {
    return false;
  }
}

function broadcast(message) {
  const text = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(text);
  });
}

function mergeControl(template, controlOverride, dataOverride) {
  const current = readData(template) || {
    meta:    { template, revision: 0, updatedAt: new Date().toISOString() },
    control: { visible: false, state: 'hidden' },
    data:    {},
  };
  if (controlOverride) Object.assign(current.control, controlOverride);
  if (dataOverride)    Object.assign(current.data, dataOverride);
  current.meta.revision  = (current.meta.revision || 0) + 1;
  current.meta.updatedAt = new Date().toISOString();
  writeData(template, current);
  graphicState[template] = { visible: current.control.visible, state: current.control.state };
  broadcast({ type: 'update', template, payload: current });
  return current;
}

// ── Live Polling Service ───────────────────────────────────────────────────

const liveTimers = {};
let csvPollTimer = null;
// Generation counter — bumped every time polling stops. In-flight pollEndpoint
// calls capture the generation at start; if it changes before they resolve
// (e.g. because the user toggled polling off), the result/error is dropped
// silently instead of writing data or spamming the console. Without this,
// the 10s fetchJson timeout drains for ~10–15s after toggle-off, producing
// a flood of "[live-poll] xxx error: Timeout fetching …" lines.
let pollGeneration = 0;

// Tiny TTL cache for eventInfo.php — startOrder.php doesn't carry CategoryName,
// so we fetch it here and pass it into normalizeStartingOrder.
const _eventInfoCache = { at: 0, info: null };
async function fetchCategoryInfo(cfg) {
  const now = Date.now();
  if (_eventInfoCache.info && (now - _eventInfoCache.at) < 30000) {
    return _eventInfoCache.info;
  }
  const url = buildUrl(cfg, 'eventInfo');
  if (!url) return null;
  try {
    const raw   = await normalizers.fetchJson(url);
    const entry = Array.isArray(raw) ? raw[0] : raw;
    if (!entry) return null;
    const info = {
      en: String(entry.Category   || '').trim(),
      fr: String(entry.FRCategory || '').trim(),
      // Segment fields — eventInfo.php is inconsistent across SC competitions
      // about field naming, so try a few common variants and fall back to ''.
      segmentEn: String(entry.Segment || entry.SegmentName || entry.SegName || '').trim(),
      segmentFr: String(entry.FRSegment || entry.SegmentNameFr || entry.SegNameFr || '').trim(),
    };
    _eventInfoCache.at   = now;
    _eventInfoCache.info = info;
    applyEventInfoPatch({
      categoryName: info.en,
      categoryNameFr: info.fr,
      segmentName: info.segmentEn,
      segmentNameFr: info.segmentFr,
    });
    return info;
  } catch (err) {
    console.warn('[eventInfo] fetch failed:', err.message);
    return null;
  }
}

/**
 * Map of SC endpoint name → normalizer function → template name
 * endpoint: { normalizer, template, extraArgs }
 */
const LIVE_ENDPOINTS = {
  liveElements:    { fn: sc.normalizeLiveElements,  template: 'elements'                      },
  currentSkater:   { fn: sc.normalizeScoring,        template: 'scoring',    dualLt: true      },
  ranking:         { fn: null, template: null, dualRanking: true   }, // full rankings (ranking-seg.php)
  rankingContext:  { fn: null, template: null, dualStandings: true }, // rank6 standings (ranking.php)
  officials:       { fn: sc.normalizeOfficials,      template: 'officials'                     },
  startOrder:      { fn: null /* handled specially */, template: 'starting-order'               },
  // Event info: doesn't write a graphic data file — instead patches the
  // shared categoryName / segmentName fields in event-config.json, which
  // every header-using graphic re-resolves on the config-update broadcast.
  // Bypasses the 30s TTL cache used by on-demand callers so a polled
  // refresh always lands fresh data.
  eventInfo:       { fn: null, template: null, isEventInfo: true },
};

/** Preserve visible/state from current control so live polls don't hide a visible graphic */
function mergeControlState(payload, existing) {
  if (existing?.control?.visible !== undefined) {
    payload.control.visible = existing.control.visible;
    payload.control.state   = existing.control.visible ? 'animateUpdate' : existing.control.state;
  }
}

function normalizeLowerThirdFromScoring(scoringData, lang) {
  const existing = readData('lower-third');
  const groupNumber = scoringData.groupNumber ?? scoringData.group ?? null;
  return {
    meta:    { template: 'lower-third', revision: Date.now(), updatedAt: new Date().toISOString() },
    control: existing?.control || { visible: false, state: 'hidden' },
    data: {
      line1:       scoringData.name    || '',
      line2:       scoringData.club    || '',
      flagUrl:     scoringData.flagUrl || '',
      categoryName: scoringData.categoryName || scoringData.category || '',
      segmentName:  scoringData.segmentName || scoringData.segment || scoringData.segmentType || '',
      groupNumber,
      // logoUrl intentionally omitted — lower-third.js uses window.configLogoUrl as fallback
    },
  };
}

function normalizeLowerThirdFromCurrentSkaterCsv(currentSkaterPath, context, lang) {
  if (!currentSkaterPath || !fs.existsSync(currentSkaterPath)) return null;
  const currentPayload = normalizers.fromCsv(currentSkaterPath, 'scoring', { context, lang });
  return currentPayload?.data ? normalizeLowerThirdFromScoring(currentPayload.data, lang) : null;
}

/** Write + broadcast a single template, skipping if data unchanged */
function writeAndBroadcast(template, payload, { force = false } = {}) {
  const existing = readData(template);
  if (!force && JSON.stringify(payload.data) === JSON.stringify(existing?.data)) {
    if (existing?.control) {
      graphicState[template] = { visible: existing.control.visible, state: existing.control.state };
    }
    return existing; // no change
  }
  mergeControlState(payload, existing);
  payload.meta.revision = Date.now(); // ensure fresh revision on forced writes too
  writeData(template, payload);
  graphicState[template] = { visible: payload.control.visible, state: payload.control.state };
  broadcast({ type: 'update', template, payload });
}

const messagesService = createMessagesService({
  rootDir: __dirname,
  readConfig,
  writeConfig,
  readData,
  writeData,
  publish: payload => {
    graphicState.messages = { visible: payload.control?.visible, state: payload.control?.state };
    broadcast({ type: 'update', template: 'messages', payload });
  },
});

const manualSkatersService = createManualSkatersService({
  rootDir: __dirname,
  readConfig,
  writeConfig,
  readData,
  writeData,
  publish: payload => {
    graphicState['manual-skater'] = { visible: payload.control?.visible, state: payload.control?.state };
    broadcast({ type: 'update', template: 'manual-skater', payload });
  },
});

const skaterExtrasService = createSkaterExtrasService({
  rootDir: __dirname,
  readConfig,
});

// ── vMix auto-record ──────────────────────────────────────────────────────────

// Single source of truth for vMix host/port: settings.vmix.* (the same store
// Production Control's "vMix" panel edits, and vmixService already reads).
// Previously this read a separate autoRecord.vmixHost/vmixPort — consolidated
// so there's exactly one place to configure the vMix connection.
const vmixClient = createVmixClient({ getSettings: () => settingsService.readSettings() });

const autoRecordState = {
  countdownTimer:    null,   // setTimeout handle for auto-record countdown
  recording:         false,
  currentFilename:   null,
  currentName:       null,
  pendingName:       null,   // name during countdown
  pendingFilename:   null,   // filename during countdown
  preloadedName:     null,   // pre-positioned for manual StreamDeck start
  preloadedFilename: null,
  verifiedName:      null,   // confirmed by element tracker
  verifiedMatch:     null,   // true=correct, false=mismatch, null=unverified
};

function sanitizeFilename(str) {
  return (str || '').replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, ' ').trim();
}

function buildRecordingFilename(entry, segmentDto) {
  const name    = sanitizeFilename(entry?.competitorName || 'Unknown');
  const segCode = segmentDto?.segmentName
    ? segmentDto.segmentName.replace(/.*\b(SP|FS|RD|FD|SD|PD)\b.*/i, '$1').toUpperCase()
    : '';
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return [name, segCode, datePart].filter(Boolean).join(' - ');
}

function broadcastRecordingStatus(type, extra = {}) {
  const msg = JSON.stringify({ type, ...autoRecordState, ...extra });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function cancelRecordingCountdown(reason = 'cancelled') {
  if (autoRecordState.countdownTimer) {
    clearTimeout(autoRecordState.countdownTimer);
    autoRecordState.countdownTimer  = null;
    autoRecordState.pendingName     = null;
    autoRecordState.pendingFilename = null;
    broadcastRecordingStatus('recording-countdown-cancelled', { reason });
  }
}

// Called when onice changes to a new skater — used only to show "waiting for elements" state.
// Auto-record does NOT start here; it waits for onSkaterElementsReady for verified filename.
function onSkaterOnIce(entry, segmentDto, categoryDto) {
  const cfg = readConfig().autoRecord || {};
  autoRecordState.verifiedName  = null;
  autoRecordState.verifiedMatch = null;

  if (!cfg.enabled) return;

  // Show "waiting for element tracker confirmation" in the UI
  const filename = buildRecordingFilename(entry, segmentDto);
  autoRecordState.pendingName     = entry.competitorName || 'Unknown';
  autoRecordState.pendingFilename = filename;
  broadcastRecordingStatus('recording-awaiting-elements');
}

// Called once per skater after elements are successfully fetched — this is the verified signal.
// Cross-checks against the pre-loaded filename, then starts the countdown.
function onSkaterElementsReady(entry, segmentDto, categoryDto) {
  const cfg = readConfig().autoRecord || {};
  const name     = entry.competitorName || 'Unknown';
  const filename = buildRecordingFilename(entry, segmentDto);

  autoRecordState.verifiedName  = name;
  autoRecordState.verifiedMatch = autoRecordState.preloadedName
    ? autoRecordState.preloadedName.trim().toLowerCase() === name.trim().toLowerCase()
    : null;

  cancelRecordingCountdown('elements-ready');

  // Pre-loaded filename is now confirmed — update it to match elements data
  autoRecordState.preloadedName     = name;
  autoRecordState.preloadedFilename = filename;

  // Always push the correct filename to vMix now — covers the manual StreamDeck start case.
  // SetRecordingFilename sets the filename for the current or next recording.
  vmixClient.setFilename(filename).catch(e => console.warn('[autoRecord] setFilename error:', e.message));

  if (!cfg.enabled) {
    broadcastRecordingStatus('recording-filename-ready');
    return;
  }

  // If a recording is already running (operator started manually), verify and broadcast.
  if (autoRecordState.recording) {
    broadcastRecordingStatus('recording-verified');
    return;
  }

  const delayMs = Math.max(0, Number(cfg.delayMs) || 4000);
  autoRecordState.pendingName     = name;
  autoRecordState.pendingFilename = filename;
  broadcastRecordingStatus('recording-countdown', { delayMs });

  autoRecordState.countdownTimer = setTimeout(async () => {
    autoRecordState.countdownTimer = null;
    try {
      await vmixClient.startRecording(filename);
      autoRecordState.recording         = true;
      autoRecordState.currentFilename   = filename;
      autoRecordState.currentName       = name;
      autoRecordState.pendingName       = null;
      autoRecordState.pendingFilename   = null;
      autoRecordState.preloadedName     = null;
      autoRecordState.preloadedFilename = null;
      console.log(`[autoRecord] started: ${filename}`);
      broadcastRecordingStatus('recording-started');
    } catch (e) {
      console.warn('[autoRecord] start error:', e.message);
      broadcastRecordingStatus('recording-error', { error: e.message });
    }
  }, delayMs);
}

// Called when onice goes false. Pre-position the filename for the next skater in start order.
function onSkaterLeftIce(entries) {
  const cfg = readConfig().autoRecord || {};
  cancelRecordingCountdown('skater-left');
  autoRecordState.verifiedName  = null;
  autoRecordState.verifiedMatch = null;

  if (autoRecordState.recording) {
    vmixClient.stopRecording().catch(e => console.warn('[autoRecord] stop error:', e.message));
    const prev = autoRecordState.currentFilename;
    autoRecordState.recording       = false;
    autoRecordState.currentFilename = null;
    autoRecordState.currentName     = null;
    console.log(`[autoRecord] stopped: ${prev}`);
    broadcastRecordingStatus('recording-stopped', { stoppedFilename: prev });
  }

  // Pre-position filename for the next unscored skater so the operator's
  // StreamDeck start gets the right name even before onice is pushed.
  if (Array.isArray(entries) && entries.length) {
    const unscored = entries
      .filter(e => e.segmentRank == null && !e.onice)
      .sort((a, b) => {
        if ((a.warmUpGroup ?? 99) !== (b.warmUpGroup ?? 99)) return (a.warmUpGroup ?? 99) - (b.warmUpGroup ?? 99);
        return (a.sortOrder ?? 99) - (b.sortOrder ?? 99);
      });
    const next = unscored[0];
    if (next) {
      const name = next.competitorName || 'Unknown';
      // Build a partial filename — segment code comes from the live config
      const segCode = (() => {
        try {
          const segName = readConfig().dataSource?.scApi?.segmentName || '';
          return segName.replace(/.*\b(SP|FS|RD|FD|SD|PD)\b.*/i, '$1').toUpperCase() || '';
        } catch { return ''; }
      })();
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = [sanitizeFilename(name), segCode, datePart].filter(Boolean).join(' - ');

      autoRecordState.preloadedName     = name;
      autoRecordState.preloadedFilename = filename;

      // Push to vMix immediately — operator can start recording with StreamDeck right away.
      vmixClient.setFilename(filename).catch(e => console.warn('[autoRecord] preload setFilename:', e.message));
      console.log(`[autoRecord] pre-loaded filename: ${filename}`);
      broadcastRecordingStatus('recording-filename-preloaded');
    }
  }
}

const scApiService = createScApiService({
  getConfig:          readConfig,
  readData,
  writeAndBroadcast,
  applyEventInfoPatch,
  rankingsCache,
  logger: actionLogger,
  onSkaterOnIce,
  onSkaterLeftIce,
  onSkaterElementsReady,
});

function isSourcePollingActive() {
  return Object.keys(liveTimers).length > 0 || !!csvPollTimer || scApiService.isActive();
}

function sliceRankingsPage(payload, currentPage = 1) {
  if (payload?.data?.groupedPageMode && Array.isArray(payload?.data?.groupedPages)) {
    rankingsCache.pages = payload.data.groupedPages;
    rankingsCache.groupedPageMode = true;
    const pageCount = Math.max(1, rankingsCache.pages.length);
    const safePage = Math.min(Math.max(1, currentPage), pageCount);
    payload.data.page = safePage;
    payload.data.pageCount = pageCount;
    payload.data.rows = rankingsCache.pages[safePage - 1] || [];
    payload.data.rowCount = payload.data.rows.length;
    payload.data.rowsPerPage = payload.data.rows.length;
    delete payload.data.allRows;
    return payload;
  }
  if (!payload?.data?.allRows) return payload;
  rankingsCache.groupedPageMode = false;
  rankingsCache.pages = [];
  rankingsCache.allRows = payload.data.allRows;
  rankingsCache.rowsPerPage = payload.data.rowsPerPage || rankingsCache.rowsPerPage;

  const rpp = rankingsCache.rowsPerPage;
  const pageCount = Math.max(1, Math.ceil(rankingsCache.allRows.length / rpp));
  const safePage = Math.min(Math.max(1, currentPage), pageCount);
  const start = (safePage - 1) * rpp;

  payload.data.page = safePage;
  payload.data.pageCount = pageCount;
  payload.data.rows = rankingsCache.allRows.slice(start, start + rpp);
  payload.data.rowCount = payload.data.rows.length;
  return payload;
}

function ensureRankingsCacheLoaded() {
  if (rankingsCache.groupedPageMode && rankingsCache.pages.length) return;
  if (rankingsCache.allRows.length) return;
  warmRankingsCache();
  if (rankingsCache.groupedPageMode && rankingsCache.pages.length) return;
  if (rankingsCache.allRows.length) return;
  const existing = readData('rankings');
  if (Array.isArray(existing?.data?.groupedPages) && existing.data.groupedPages.length) {
    rankingsCache.pages = existing.data.groupedPages;
    rankingsCache.groupedPageMode = true;
    return;
  }
  const src = existing?.data?.allRows?.length ? existing.data.allRows : existing?.data?.rows;
  if (Array.isArray(src) && src.length > 0) rankingsCache.allRows = src;
}

function refreshStartOrderCache(cfg) {
  const filePath = csvFilePath(cfg, 'startOrder');
  if (!filePath || !fs.existsSync(filePath)) return false;
  startOrderCache.groups = csvAdapter.buildStartOrderGroups(filePath);
  startOrderCache.sourcePath = filePath;
  return startOrderCache.groups.length > 0;
}

function ensureStartOrderCacheLoaded(cfg) {
  if (startOrderCache.groups.length) return true;
  return refreshStartOrderCache(cfg);
}

function buildStartOrderPayloadFromCache(cfg, options = {}) {
  const requestedGroup = Number(options.group);
  const context = resolveCsvContext(cfg);
  const groupNumber = requestedGroup >= 1 ? requestedGroup : startOrderGroupSelection;
  return {
    template: 'starting-order',
    payload: csvAdapter.startingOrderPayloadFromGroups(startOrderCache.groups, { context, groupNumber }),
  };
}

function resolveCsvContextPreview(cfg) {
  const eventInfoPath = csvFilePath(cfg, 'eventInfo');
  let info = null;
  if (eventInfoPath && fs.existsSync(eventInfoPath)) {
    try {
      info = normalizers.fromCsv(eventInfoPath, 'event-info');
    } catch (err) {
      console.warn('[preview csv] event info error:', err.message);
    }
  }
  return Object.assign({}, sourceContextFromConfig(cfg), info || {});
}

function resolveCsvContext(cfg) {
  const eventInfoPath = csvFilePath(cfg, 'eventInfo');
  let info = null;
  if (eventInfoPath && fs.existsSync(eventInfoPath)) {
    try {
      info = normalizers.fromCsv(eventInfoPath, 'event-info');
      applyEventInfoPatch(info);
    } catch (err) {
      console.warn('[csv] event info error:', err.message);
    }
  }
  return Object.assign({}, sourceContextFromConfig(readConfig()), info || {});
}

function buildCsvPayload(endpoint, cfg, options = {}) {
  const lang = cfg.language || 'en';
  const context = resolveCsvContext(cfg);

  switch (endpoint) {
    case 'eventInfo':
      return { info: context };
    case 'startOrder': {
      const useCacheOnly = !!options.useCacheOnly;
      const cacheReady = useCacheOnly ? ensureStartOrderCacheLoaded(cfg) : refreshStartOrderCache(cfg);
      if (!cacheReady) {
        const csv = getCsvSettings(cfg);
        throw new Error(`CSV start order file not found in ${csv.folderPath} (configured: ${csv.files.startOrder || 'none'})`);
      }
      return buildStartOrderPayloadFromCache(cfg, options);
    }
    case 'currentSkater': {
      const scorePath = csvFilePath(cfg, 'scores');
      const currentPath = csvFilePath(cfg, 'currentSkater');
      const result = {
        template: 'scoring',
        payload: null,
        lowerThird: normalizeLowerThirdFromCurrentSkaterCsv(currentPath, context, lang),
      };
      if (scorePath && fs.existsSync(scorePath)) {
        result.payload = normalizers.fromCsv(scorePath, 'scoring', { context, lang, currentSkaterPath: currentPath });
      }
      if (!result.payload && !result.lowerThird) {
        throw new Error('CSV scoring/current skater files not found');
      }
      return result;
    }
    case 'ranking': {
      const filePath = csvFilePath(cfg, 'ranking');
      if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV ranking file not found');
      const existing = readData('rankings');
      const currentPage = existing?.data?.page ?? 1;
      const rowsPerPage = rankingsCache.rowsPerPage || existing?.data?.rowsPerPage || 6;
      const payload = normalizers.fromCsv(filePath, 'rankings', {
        context,
        lang,
        rowsPerPage,
        page: currentPage,
      });
      return { template: 'rankings', payload: sliceRankingsPage(payload, currentPage) };
    }
    case 'rankingContext': {
      const filePath = csvFilePath(cfg, 'ranking');
      if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV ranking file not found');
      return {
        template: 'standings',
        payload: normalizers.fromCsv(filePath, 'standings', { context, lang }),
      };
    }
    case 'officials': {
      const filePath = csvFilePath(cfg, 'officials');
      if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV officials file not found');
      return {
        template: 'officials',
        payload: normalizers.fromCsv(filePath, 'officials', { context, lang }),
      };
    }
    case 'liveElements': {
      const filePath = csvFilePath(cfg, 'liveElements');
      const scorePath = csvFilePath(cfg, 'scores');
      const currentPath = csvFilePath(cfg, 'currentSkater');
      if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV live elements file not found');
      return {
        template: 'elements',
        payload: normalizers.fromCsv(filePath, 'elements', {
          scoringPath: scorePath,
          currentSkaterPath: currentPath,
        }),
      };
    }
    default:
      throw new Error(`Unsupported CSV endpoint: ${endpoint}`);
  }
}

function writeCsvEndpoint(endpoint, cfg, options = {}) {
  const result = buildCsvPayload(endpoint, cfg, options);
  if (endpoint === 'eventInfo') return result;

  if (result.payload) {
    if (endpoint === 'startOrder') {
      const group = Number(result.payload?.data?.groupNumber);
      if (group >= 1) startOrderGroupSelection = group;
    }
    writeAndBroadcast(result.template, result.payload);
  }
  if (result.lowerThird) {
    writeAndBroadcast('lower-third', result.lowerThird);
  }
  return result;
}

function getGraphicPayload(template) {
  return readData(template) || {
    meta: { template, revision: 0, updatedAt: new Date().toISOString() },
    control: { visible: false, state: 'hidden' },
    data: {},
  };
}

function getGraphicOverlaySettings(settings, template) {
  const map = settings.vmix?.graphicOverlays || {};
  return template ? (map[template] || {}) : {};
}

// When a graphic comes on-air on a shared overlay, vMix's overlayIn swaps
// the previous input out — but our state still thinks the previous graphic
// is "visible". That means the next time it's brought back its handlePayload
// sees visible+currentVisible and treats it as an in-place update, skipping
// the entry animation. Sync state with vMix by writing visible:false on
// every other graphic configured for the same overlay slot. Pure state
// hygiene — no vMix calls (vMix already handled the swap).
function clearOtherGraphicsOnOverlay(currentTemplate, overlayNumber) {
  const settings = settingsService.readSettings();
  const overlays = settings.vmix?.graphicOverlays || {};
  const defaultOverlay = Number(settings.vmix?.defaultOverlayNumber) || 1;
  for (const tpl of TEMPLATES) {
    if (tpl === currentTemplate) continue;
    const cfg = overlays[tpl] || {};
    const tplOverlay = Number(cfg.overlayNumber) || defaultOverlay;
    if (tplOverlay !== Number(overlayNumber)) continue;
    const cur = readData(tpl);
    if (!cur?.control?.visible) continue; // already hidden in our state
    mergeControl(tpl, { visible: false, state: 'animateOut' }, null);
    actionLogger.log('graphic auto-hidden (overlay swap)', {
      template: tpl,
      swappedTo: currentTemplate,
      overlay: overlayNumber,
    });
  }
}

function getOverlayRequestOptions(req, template) {
  const settings = settingsService.readSettings();
  const graphicOverlay = getGraphicOverlaySettings(settings, template);
  const inputName = String(
    req.query.inputName || req.query.input || graphicOverlay.inputName || settings.vmix?.defaultBrowserInputName || 'GFX'
  ).trim();
  const overlayNumber = Math.min(Math.max(Number(
    req.query.overlay || req.query.overlayNumber || graphicOverlay.overlayNumber || settings.vmix?.defaultOverlayNumber || 1
  ) || 1, 1), 4);
  const overlayOutDelayMs = Math.max(0, Number(req.query.overlayOutDelayMs ?? settings.vmix?.overlayOutDelayMs ?? 900) || 0);
  const enabled = !['0', 'false', 'off', 'no'].includes(String(req.query.vmixOverlay ?? req.query.overlayEnabled ?? 'true').toLowerCase());
  return { enabled, inputName, overlayNumber, overlayOutDelayMs };
}

async function setVmixOverlayForRequest(req, active, template) {
  const options = getOverlayRequestOptions(req, template);
  if (!options.enabled) return { skipped: true, message: 'vMix overlay control skipped by request.', ...options };
  try {
    if (!active && options.overlayOutDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.overlayOutDelayMs));
    }
    const result = active
      ? await vmixService.overlayIn(options.overlayNumber, options.inputName)
      : await vmixService.overlayOut(options.overlayNumber, options.inputName);
    return { success: true, active, ...options, functionName: result.functionName };
  } catch (err) {
    return { success: false, active, ...options, message: err.message };
  }
}

function setRankingsPage(pageNum) {
  const page = Math.max(1, Number(pageNum) || 1);
  ensureRankingsCacheLoaded();

  if (rankingsCache.groupedPageMode && rankingsCache.pages.length) {
    const pageCount = Math.max(1, rankingsCache.pages.length);
    const safePage = Math.min(Math.max(1, page), pageCount);
    const pageRows = rankingsCache.pages[safePage - 1] || [];
    const existing = getGraphicPayload('rankings');
    existing.data = {
      ...existing.data,
      page: safePage,
      pageCount,
      groupedPageMode: true,
      groupedPages: rankingsCache.pages,
      rowCount: pageRows.length,
      rows: pageRows,
      rowsPerPage: pageRows.length,
    };
    delete existing.data.allRows;
    existing.meta.revision = Date.now();
    existing.meta.updatedAt = new Date().toISOString();
    existing.control.state = 'pageChange';
    writeData('rankings', existing);
    graphicState.rankings = { visible: existing.control.visible, state: existing.control.state };
    broadcast({ type: 'update', template: 'rankings', payload: existing });
    return { ok: true, payload: existing, page: safePage, pageCount, rowsPerPage: pageRows.length, rowCount: pageRows.length };
  }

  const rpp = rankingsCache.rowsPerPage || 6;
  const allRows = rankingsCache.allRows;
  const pageCount = Math.max(1, Math.ceil(allRows.length / rpp));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * rpp;
  const pageRows = allRows.slice(start, start + rpp);
  const existing = getGraphicPayload('rankings');
  existing.data = { ...existing.data, page: safePage, pageCount, rowCount: pageRows.length, rows: pageRows, rowsPerPage: rpp };
  existing.meta.revision = Date.now();
  existing.meta.updatedAt = new Date().toISOString();
  existing.control.state = 'pageChange';
  writeData('rankings', existing);
  graphicState.rankings = { visible: existing.control.visible, state: existing.control.state };
  broadcast({ type: 'update', template: 'rankings', payload: existing });
  return { ok: true, payload: existing, page: safePage, pageCount, rowsPerPage: rpp, rowCount: pageRows.length };
}

async function setStartingOrderGroup(group) {
  const groupNumber = Number(group);
  if (!groupNumber || groupNumber < 1) throw new Error('invalid group number');
  const cfg = readConfig();
  if (getDataSourceMode(cfg) === 'csv-folder') {
    const result = writeCsvEndpoint('startOrder', cfg, { group: groupNumber, useCacheOnly: true });
    return {
      ok: true,
      payload: readData('starting-order') || result.payload,
      group: groupNumber,
      revision: result.payload?.meta?.revision,
      rowCount: result.payload?.data?.rowCount,
    };
  }

  if (getDataSourceMode(cfg) === 'sc-api') {
    // sc-api mode: pollOnce() writes allRows (every group) into the file.
    // Re-slice by warmUpGroup without hitting the API again.
    const existing = readData('starting-order');
    if (!existing) throw new Error('No starting-order data — select a segment first');
    const allRows = existing.data?.allRows || existing.data?.rows || [];
    const availableGroups = existing.data?.availableGroups || [...new Set(allRows.map(r => r.warmUpGroup ?? 1))].sort((a, b) => a - b);
    const targetGroup = availableGroups.includes(groupNumber) ? groupNumber : (availableGroups[0] ?? 1);
    const rows = allRows.filter(r => (r.warmUpGroup ?? 1) === targetGroup);
    const payload = {
      ...existing,
      data: { ...existing.data, allRows, rows, rowCount: rows.length, groupNumber: targetGroup, groupCount: availableGroups.length || 1, availableGroups },
    };
    payload.meta.revision = Date.now();
    writeData('starting-order', payload);
    graphicState['starting-order'] = { visible: payload.control.visible, state: payload.control.state };
    broadcast({ type: 'update', template: 'starting-order', payload });
    return { ok: true, payload, group: targetGroup, revision: payload.meta.revision, rowCount: rows.length };
  }

  const url = buildUrl(cfg, 'startOrder');
  if (!url) throw new Error('No startOrder URL configured');
  const raw = await normalizers.fetchJson(url);
  const lang = cfg.language || 'en';
  const catInfo = await fetchCategoryInfo(cfg);
  const payload = sc.normalizeStartingOrder(raw, groupNumber, lang, catInfo);
  if (!payload) throw new Error('Normalizer returned null');
  const existing = readData('starting-order');
  mergeControlState(payload, existing);
  writeData('starting-order', payload);
  graphicState['starting-order'] = { visible: payload.control.visible, state: payload.control.state };
  broadcast({ type: 'update', template: 'starting-order', payload });
  return { ok: true, payload, group: groupNumber, revision: payload.meta.revision, rowCount: payload.data?.rowCount };
}

async function toggleTemplateGraphic(req, template) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template: ${template}`);
  // Source of truth: vMix's actual overlay state, scoped to *this graphic's*
  // configured input. So when overlay 1 is shared, toggling Lower Third while
  // Scoring is on overlay 1 still treats Lower Third as "not visible" and
  // swaps it in — instead of being fooled into hiding Scoring.
  const options = getOverlayRequestOptions(req, template);
  const { slot, mine } = await vmixService.getOverlayState(options.overlayNumber, options.inputName);
  const wasVisible = mine;
  // Diagnostic: capture the exact state we decided from so we can debug
  // "had to press twice" reports. fileVisible mismatching `mine` is the smoking
  // gun for vMix overlay state drift.
  const fileVisible = !!(readData(template)?.control?.visible);
  actionLogger.log('graphic toggle decision', {
    template,
    overlayNumber: options.overlayNumber,
    configuredInputName: options.inputName,
    vmixSlot: slot,
    mine,
    wasVisible,
    fileVisible,
    decision: wasVisible ? 'hide' : 'show',
    stateMatch: mine === fileVisible,
  });
  // If we're showing, evict any other graphics that share this overlay slot
  // so their next reveal plays a full animateIn instead of an in-place update.
  if (!wasVisible) clearOtherGraphicsOnOverlay(template, options.overlayNumber);
  const payload = mergeControl(template, { visible: !wasVisible, state: wasVisible ? 'animateOut' : 'animateIn' }, null);
  const overlay = await setVmixOverlayForRequest(req, !wasVisible, template);
  actionLogger.log('graphic toggle', { template, action: wasVisible ? 'hidden' : 'shown', vmixSlot: slot, expectedInput: options.inputName, overlay });
  return {
    ok: true,
    success: true,
    template,
    action: wasVisible ? 'hidden' : 'shown',
    visible: !wasVisible,
    revision: payload.meta.revision,
    overlay,
  };
}

async function setTemplateGraphicVisibility(req, template, visible) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template: ${template}`);
  if (visible) {
    const options = getOverlayRequestOptions(req, template);
    clearOtherGraphicsOnOverlay(template, options.overlayNumber);
  }
  const payload = mergeControl(template, { visible, state: visible ? 'animateIn' : 'animateOut' }, null);
  const overlay = await setVmixOverlayForRequest(req, visible, template);
  actionLogger.log(`graphic ${visible ? 'show' : 'hide'}`, { template, overlay });
  return {
    ok: true,
    success: true,
    template,
    action: visible ? 'shown' : 'hidden',
    visible,
    revision: payload.meta.revision,
    overlay,
  };
}

async function toggleStartingOrderGroup(req, group) {
  const groupNumber = Number(group);
  if (!groupNumber || groupNumber < 1) throw new Error('invalid group number');
  const current = getGraphicPayload('starting-order');
  const wasVisible = !!current.control?.visible;
  const currentGroup = Number(current.data?.groupNumber) || null;

  if (wasVisible && currentGroup === groupNumber) {
    const payload = mergeControl('starting-order', { visible: false, state: 'animateOut' }, null);
    const overlay = await setVmixOverlayForRequest(req, false, 'starting-order');
    actionLogger.log('starting-order toggle hidden', { group: groupNumber, overlay });
    return { ok: true, success: true, template: 'starting-order', action: 'hidden', visible: false, group: groupNumber, revision: payload.meta.revision, overlay };
  }

  const result = await setStartingOrderGroup(groupNumber);
  let payload = readData('starting-order') || result.payload;
  if (!wasVisible || !payload.control?.visible) {
    // First show (or coming back from hidden) — evict other overlay-mates
    // so they replay their entry animation next time they're brought up.
    const options = getOverlayRequestOptions(req, 'starting-order');
    clearOtherGraphicsOnOverlay('starting-order', options.overlayNumber);
    payload = mergeControl('starting-order', { visible: true, state: 'animateIn' }, null);
  }
  const overlay = wasVisible
    ? { skipped: true, message: 'Graphic was already on-air; overlay left active while changing group.' }
    : await setVmixOverlayForRequest(req, true, 'starting-order');
  actionLogger.log('starting-order toggle shown', { group: groupNumber, action: wasVisible ? 'switched_group' : 'shown', overlay });
  return {
    ok: true,
    success: true,
    template: 'starting-order',
    action: wasVisible ? 'switched_group' : 'shown',
    visible: true,
    group: groupNumber,
    rowCount: payload.data?.rowCount,
    revision: payload.meta.revision,
    overlay,
  };
}

async function toggleRankingsPage(req, page) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const current = getGraphicPayload('rankings');
  const wasVisible = !!current.control?.visible;
  const currentPage = Number(current.data?.page) || null;

  if (wasVisible && currentPage === pageNumber) {
    const payload = mergeControl('rankings', { visible: false, state: 'animateOut' }, null);
    const overlay = await setVmixOverlayForRequest(req, false, 'rankings');
    actionLogger.log('rankings toggle hidden', { page: pageNumber, overlay });
    return { ok: true, success: true, template: 'rankings', action: 'hidden', visible: false, page: pageNumber, revision: payload.meta.revision, overlay };
  }

  const result = setRankingsPage(pageNumber);
  let payload = readData('rankings') || result.payload;
  if (!wasVisible || !payload.control?.visible) {
    const options = getOverlayRequestOptions(req, 'rankings');
    clearOtherGraphicsOnOverlay('rankings', options.overlayNumber);
    payload = mergeControl('rankings', { visible: true, state: 'animateIn' }, null);
  }
  const overlay = wasVisible
    ? { skipped: true, message: 'Graphic was already on-air; overlay left active while changing page.' }
    : await setVmixOverlayForRequest(req, true, 'rankings');
  actionLogger.log('rankings toggle shown', { page: result.page, action: wasVisible ? 'switched_page' : 'shown', overlay });
  return {
    ok: true,
    success: true,
    template: 'rankings',
    action: wasVisible ? 'switched_page' : 'shown',
    visible: true,
    page: result.page,
    pageCount: result.pageCount,
    rowCount: result.rowCount,
    revision: payload.meta.revision,
    overlay,
  };
}

function pollCsvFolder() {
  const cfg = readConfig();
  if (getDataSourceMode(cfg) !== 'csv-folder') return;

  ['startOrder', 'currentSkater', 'ranking', 'rankingContext', 'officials', 'liveElements'].forEach(endpoint => {
    try {
      writeCsvEndpoint(endpoint, cfg);
    } catch (err) {
      console.warn(`[csv] ${endpoint} error:`, err.message);
    }
  });
}

async function pollEndpoint(endpoint, cfg) {
  const url = buildUrl(cfg, endpoint);
  if (!url) return;
  const def = LIVE_ENDPOINTS[endpoint];
  if (!def) return;

  const myGeneration = pollGeneration;
  try {
    const raw  = await normalizers.fetchJson(url);
    // If polling was stopped (or restarted) while we were in flight, drop
    // the result silently — it belongs to the previous "session".
    if (myGeneration !== pollGeneration) return;
    const lang = cfg.language || 'en';

    // ── Event info → patches event-config.json (no graphic data file) ───
    // Refresh the in-memory TTL cache too so on-demand callers immediately
    // see the new category/segment values, not the old cached ones.
    if (def.isEventInfo) {
      const info = sc.normalizeEventInfo(raw);
      if (info) {
        _eventInfoCache.at = Date.now();
        _eventInfoCache.info = {
          en: info.categoryName || '',
          fr: info.categoryNameFr || '',
          segmentEn: info.segmentName || '',
          segmentFr: info.segmentNameFr || '',
        };
        applyEventInfoPatch({
          categoryName:   info.categoryName,
          categoryNameFr: info.categoryNameFr,
          segmentName:    info.segmentName,
          segmentNameFr:  info.segmentNameFr,
        });
      }
      return;
    }

    // ── Full rankings (ranking-seg.php) → rankings.json only ────────────
    if (def.dualRanking) {
      const fullPayload = sc.normalizeRankings(raw, rankingsCache.rowsPerPage, 1, lang);

      // Update cache — preserve current page selection
      const existingFull = readData('rankings');
      const currentPage  = existingFull?.data?.page ?? 1;
      rankingsCache.allRows     = fullPayload.data.allRows;
      rankingsCache.rowsPerPage = fullPayload.data.rowsPerPage;

      // Rebuild page slice from cache (preserves what page was on screen)
      const rpp       = rankingsCache.rowsPerPage;
      const pageCount = Math.max(1, Math.ceil(rankingsCache.allRows.length / rpp));
      const safePage  = Math.min(currentPage, pageCount);
      const start     = (safePage - 1) * rpp;
      fullPayload.data.page      = safePage;
      fullPayload.data.pageCount = pageCount;
      fullPayload.data.rows      = rankingsCache.allRows.slice(start, start + rpp);
      fullPayload.data.rowCount  = fullPayload.data.rows.length;

      writeAndBroadcast('rankings', fullPayload);
      return;
    }

    // ── Rank 6 context (ranking.php) → standings.json only ──────────────
    if (def.dualStandings) {
      const rank6Payload = sc.normalizeRank6(raw, lang);
      writeAndBroadcast('standings', rank6Payload);
      return;
    }

    // ── Start order: preserve current group selection ────────────────────
    let payload;
    if (endpoint === 'startOrder') {
      const existing = readData('starting-order');
      const grp = existing?.data?.groupNumber ?? null;
      // startOrder.php rows don't include CategoryName. eventInfo.php is the
      // documented fallback, but on some events (e.g. BC/YT Section Super
      // Series 2026) eventInfo returns Category="" / Segment=null entirely,
      // and starting-order ends up displaying just the discipline ("Singles")
      // instead of the real category ("Pre-Novice Men Singles 1"). Borrow the
      // richest available category from other templates (scoring/rankings)
      // before falling back to eventInfo — same approach Officials already uses.
      const catInfo = await fetchCategoryInfo(cfg);
      const ctx     = pickRichestCategory(catInfo);
      const enriched = {
        en: ctx.en || catInfo?.en || '',
        fr: ctx.fr || catInfo?.fr || '',
      };
      payload = sc.normalizeStartingOrder(raw, grp, lang, enriched);
    } else if (endpoint === 'officials') {
      // Officials response carries no category/segment context. eventInfo is
      // sometimes too sparse (just "Patinage en simple") — prefer the richer
      // per-skater category that rankings / scoring / starting-order already
      // wrote out. Falls back to eventInfo when those aren't populated.
      const catInfo = await fetchCategoryInfo(cfg);
      const ctx = pickRichestCategory(catInfo);
      payload = sc.normalizeOfficials(raw, lang, {
        categoryEn: ctx.en,
        categoryFr: ctx.fr,
        segmentEn:  ctx.segEn,
        segmentFr:  ctx.segFr,
      });
    } else if (endpoint === 'liveElements') {
      // The feed sends only the current element; accumulate into the full
      // running list (also attaches category/segment context for Highest TES).
      payload = normalizeAccumulatedElements(raw);
    } else {
      payload = def.fn(raw, lang);
    }

    if (!payload) return;
    writeAndBroadcast(def.template, payload);

    // ── Canonical category source: currentSkater.php ─────────────────────
    // currentSkater is filled in manually by the DS operator (selected from
    // the CSS dropdown for the skater about to take the ice), so its
    // category info is the most reliable thing in the feed — more reliable
    // than eventInfo.php which can be left as just "Singles" on some events.
    // Mirror it into event-config so every header that falls back to the
    // config (start-order, officials, rankings, standings, lower-third)
    // resolves to the same authoritative category the operator just picked.
    // Only writes when scoring produced a real (non-bare-discipline) category.
    if (endpoint === 'currentSkater') {
      const d = payload.data || {};
      const looksReal = s => {
        const t = String(s || '').trim();
        if (!t) return false;
        // Reject bare discipline markers ("Singles" / "Patinage en simple" / etc.)
        // — same set the eventInfo normalizer guards against.
        if (/^singles?$/i.test(t)) return false;
        if (/^pairs?$/i.test(t)) return false;
        if (/^ice\s*dance$/i.test(t)) return false;
        if (/^synchro(nized\s*skating)?$/i.test(t)) return false;
        if (/^patinage\s+(en\s+)?simples?$/i.test(t)) return false;
        if (/^simples?$/i.test(t)) return false;
        if (/^patinage\s+(en\s+)?couples?$/i.test(t)) return false;
        if (/^danse\s+sur\s+glace$/i.test(t)) return false;
        return true;
      };
      const patch = {};
      if (looksReal(d.categoryName))   patch.categoryName   = d.categoryName;
      if (looksReal(d.categoryNameFr)) patch.categoryNameFr = d.categoryNameFr;
      if (d.segmentName)               patch.segmentName    = d.segmentName;
      if (d.segmentNameFr)             patch.segmentNameFr  = d.segmentNameFr;
      if (Object.keys(patch).length) {
        applyEventInfoPatch(patch);
        // Also refresh the in-memory eventInfo cache so pickRichestCategory's
        // fallback chain sees the new category immediately (don't wait 30s
        // for the cache TTL).
        _eventInfoCache.at   = Date.now();
        _eventInfoCache.info = {
          en:        patch.categoryName   || _eventInfoCache.info?.en        || '',
          fr:        patch.categoryNameFr || _eventInfoCache.info?.fr        || '',
          segmentEn: patch.segmentName    || _eventInfoCache.info?.segmentEn || '',
          segmentFr: patch.segmentNameFr  || _eventInfoCache.info?.segmentFr || '',
        };
      }
    }

    // Dual-write lower-third from scoring data
    if (def.dualLt) {
      const ltPayload = normalizeLowerThirdFromScoring(payload.data, lang);
      writeAndBroadcast('lower-third', ltPayload);
    }

  } catch (err) {
    // Suppress errors from a previous polling session — see pollGeneration.
    if (myGeneration !== pollGeneration) return;
    console.warn(`[live-poll] ${endpoint} error:`, err.message);
  }
}

// liveElementTracker.php doesn't carry category/segment per row. Pull the
// most recent per-skater context from scoring.json (currentSkater feed) so
// the elements tracker can bucket the Highest TES correctly by category.
function elementsContextFromScoring() {
  const d = readData('scoring')?.data;
  if (!d) return {};
  return {
    categoryName:   d.categoryName   || '',
    categoryNameFr: d.categoryNameFr || '',
    segmentName:    d.segmentName    || '',
    segmentNameFr:  d.segmentNameFr  || '',
    groupNumber:    d.groupNumber    ?? null,
  };
}

// The live scoring feed (liveElementTracker.php) reports only the single
// most-recently-scored element per poll. csvAdapter.jsonToElements accumulates
// these into the full per-skater running list — the SAME mechanism (and shared
// history state) the CSV path uses — so list view and the GOE light rail build
// up and clear on a new skater identically in both modes.
function normalizeAccumulatedElements(raw) {
  return csvAdapter.jsonToElements(raw, elementsContextFromScoring());
}

// officials.php has no category context. Pick the LONGEST EN and LONGEST FR
// values independently across all per-skater data files. When the resulting
// FR is still just a discipline marker ("Patinage en simple"), translate
// from EN via the normalizer's substring dictionary so Officials gets a
// readable French category instead of the marker.
// Strings the rankings/standings/officials normalizers write into their
// own categoryName as the template's *header label* (e.g. "Final Rankings",
// "Classement final"). These are NOT real categories and must never be
// borrowed by other templates via pickRichestCategory — otherwise an empty
// FR source ends up displaying "Classement final" as the category on
// neighbouring graphics. Match case-insensitively, full string only.
const TEMPLATE_LABEL_BLACKLIST = new Set([
  'final rankings', 'classement final',
  'rankings',       'classement',
  'officials',      'officiels', 'officiel(le)s',
  'starting order', 'ordre de départ', 'ordre de depart',
]);
function isTemplateLabel(s) {
  return TEMPLATE_LABEL_BLACKLIST.has(String(s || '').trim().toLowerCase());
}

function pickRichestCategory(fallback) {
  const wc = s => (s || '').trim().split(/\s+/).filter(Boolean).length;
  let bestEn    = fallback?.en        || '';
  let bestFr    = fallback?.fr        || '';
  let bestSegEn = fallback?.segmentEn || '';
  let bestSegFr = fallback?.segmentFr || '';
  // scoring (from currentSkater.php) is the most reliable per-skater source.
  // starting-order has its own pickRichest-derived category. Rankings and
  // standings are EXCLUDED — their categoryName fields hold the template
  // header label by design, not a real category.
  for (const tpl of ['scoring', 'starting-order']) {
    const d = readData(tpl)?.data;
    if (!d) continue;
    if (!isTemplateLabel(d.categoryName)   && wc(d.categoryName)   > wc(bestEn))    bestEn    = d.categoryName;
    if (!isTemplateLabel(d.categoryNameFr) && wc(d.categoryNameFr) > wc(bestFr))    bestFr    = d.categoryNameFr;
    if (wc(d.segmentName)     > wc(bestSegEn)) bestSegEn = d.segmentName;
    if (wc(d.segmentNameFr)   > wc(bestSegFr)) bestSegFr = d.segmentNameFr;
  }
  // Final pass: if FR is still sparse (just a discipline marker), translate
  // the EN category via the dictionary so the on-air display reads as a
  // real French category.
  if (sc.enrichFrCategory) bestFr = sc.enrichFrCategory(bestEn, bestFr);
  return { en: bestEn, fr: bestFr, segEn: bestSegEn, segFr: bestSegFr };
}

// Debug endpoint — dumps the category/segment fields each data file is
// currently holding, so we can see exactly what each graphic is reading.
// Hit GET /api/debug/categories in a browser when something looks wrong.

function startLivePolling() {
  stopLivePolling();
  const cfg = readConfig();
  const lp  = cfg.dataSource?.livePoll;
  if (!lp?.enabled) return;

  // Per-endpoint enable flags — undefined/null means "on" for back-compat
  // with old configs that didn't have this section.
  const epEnabled = lp.endpoints || {};
  const skipped = [];

  console.log('[live-poll] starting…');
  for (const [endpoint, intervalMs] of Object.entries(lp.intervals || {})) {
    if (!LIVE_ENDPOINTS[endpoint]) continue;
    if (epEnabled[endpoint] === false) { skipped.push(endpoint); continue; }
    liveTimers[endpoint] = setInterval(() => pollEndpoint(endpoint, cfg), intervalMs);
    // Immediate first poll
    pollEndpoint(endpoint, cfg);
  }
  if (skipped.length) console.log(`[live-poll] manual-only (skipped): ${skipped.join(', ')}`);
}

function stopLivePolling() {
  for (const id of Object.values(liveTimers)) clearInterval(id);
  Object.keys(liveTimers).forEach(k => delete liveTimers[k]);
  // Bump the generation so any in-flight fetches drop their results/errors
  // instead of writing data or logging when they eventually settle.
  pollGeneration++;
}

function startCsvPolling() {
  stopCsvPolling();
  const cfg = readConfig();
  const csv = getCsvSettings(cfg);
  console.log('[csv-poll] starting…');
  csvPollTimer = setInterval(() => pollCsvFolder(), csv.pollIntervalMs);
  pollCsvFolder();
}

function stopCsvPolling() {
  if (csvPollTimer) clearInterval(csvPollTimer);
  csvPollTimer = null;
}

function startConfiguredPolling() {
  const cfg  = readConfig();
  const mode = getDataSourceMode(cfg);
  if (mode === 'csv-folder') {
    stopLivePolling();
    scApiService.stop();
    startCsvPolling();
    return;
  }
  if (mode === 'sc-api') {
    stopLivePolling();
    stopCsvPolling();
    scApiService.start();
    return;
  }
  // live-json
  scApiService.stop();
  stopCsvPolling();
  startLivePolling();
}

function stopAllPolling() {
  stopLivePolling();
  stopCsvPolling();
  scApiService.stop();
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '15mb' })); // headroom for base64 workbook uploads
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, cacheControl: false,
}));

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const status = {};
  TEMPLATES.forEach(t => { status[t] = graphicState[t]; });
  ws.send(JSON.stringify({ type: 'connected', status }));

  // Replay current data to this client so iframes recover immediately
  // after server restart without waiting for the next poll cycle.
  // Use a fresh revision so the client always re-renders even if it
  // previously cached this same revision (stale-DOM scenario).
  const replayRevision = Date.now();
  TEMPLATES.forEach((t, i) => {
    const payload = readData(t);
    if (payload) {
      const replay = { ...payload, meta: { ...payload.meta, revision: replayRevision + i } };
      ws.send(JSON.stringify({ type: 'update', template: t, payload: replay }));
    }
  });
});

// ── File watcher ───────────────────────────────────────────────────────────
// applyEventInfoPatch increments this before a silent write so the watcher
// skips the config-update broadcast for that change only.
let _silentConfigWriteCount = 0;
let _configChangeTimer = null;
chokidar.watch(path.join(DATA_DIR, '*.json'), { ignoreInitial: true })
  .on('change', fp => {
    const template = path.basename(fp, '.json');
    // event-config.json is the derived merged cache written by every config
    // path (writeConfig + applyEventInfoPatch); it's the single change trigger.
    // The split source files (style-config / event-state) are written together
    // with it, so we ignore them here to keep the silent-write counter exact.
    if (template === 'style-config' || template === 'event-state') return;
    if (template === 'event-config') {
      if (_silentConfigWriteCount > 0) { _silentConfigWriteCount--; }
      else { broadcast({ type: 'config-update' }); }
      // Debounce live-poll restart — rapid saves (e.g. from operator panel)
      // can fire multiple change events; only act after things settle.
      clearTimeout(_configChangeTimer);
      _configChangeTimer = setTimeout(() => {
        const cfg  = readConfig();
        const mode = getDataSourceMode(cfg);
        // sc-api manages its own polling lifecycle; don't restart it on every
        // config write (applyEventInfoPatch writes config on every poll tick,
        // which would cause an infinite restart loop in sc-api mode).
        if (mode === 'sc-api') return;
        if (cfg.dataSource?.livePoll?.enabled) startConfiguredPolling();
        else stopAllPolling();
      }, 600);
      return;
    }
    if (!TEMPLATES.includes(template)) return;
    const payload = readData(template);
    if (!payload) return;
    graphicState[template] = { visible: payload.control?.visible, state: payload.control?.state };
    broadcast({ type: 'update', template, payload });
  });

// ── REST API ───────────────────────────────────────────────────────────────

registerProductionRoutes(app, {
  settingsService,
  stateService,
  vmixService,
  recordingController,
  recordingRepairService,
  dailymotionService,
  logger: actionLogger,
  graphics: {
    templates: TEMPLATES,
    show: template => mergeControl(template, { visible: true, state: 'animateIn' }, null),
    hide: template => mergeControl(template, { visible: false, state: 'animateOut' }, null),
  },
});

app.get('/api/status', (_req, res) => {
  const out = {};
  TEMPLATES.forEach(t => { out[t] = graphicState[t]; });
  const cfg = readConfig();
  res.json({
    ok: true,
    templates: out,
    livePollActive: isSourcePollingActive(),
    sourceMode: getDataSourceMode(cfg),
    language: cfg.language || 'en',
  });
});

// ── Version + self-update (git) ─────────────────────────────────────────────
const { execFile } = require('child_process');
function git(args, cb) {
  execFile('git', args, { cwd: __dirname, timeout: 30000 }, (err, stdout, stderr) =>
    cb(err, String(stdout || '').trim(), String(stderr || '').trim()));
}

app.get('/api/version', (_req, res) => {
  git(['log', '-1', '--format=%h|%cd|%s', '--date=format:%Y-%m-%d %H:%M'], (err, out) => {
    if (err || !out) return res.json({ ok: true, available: false });
    const [commit, date, subject] = out.split('|');
    git(['rev-parse', '--abbrev-ref', 'HEAD'], (e2, branch) => {
      res.json({ ok: true, available: true, commit, date, subject, branch: branch || '' });
    });
  });
});

// Pull the latest code. Reports the git output; the operator restarts the
// server afterward (Node can't reliably relaunch itself without a supervisor).
app.post('/api/update', (_req, res) => {
  git(['pull', '--ff-only'], (err, out, stderr) => {
    if (err) {
      const raw = stderr || out || err.message || '';
      // A non-fast-forward means this clone's history no longer matches what
      // is published (the studio rewrote history). An operator cannot resolve
      // that from here, so say so plainly instead of surfacing git's wording.
      const diverged = /non-fast-forward|not possible to fast-forward|unrelated histories|diverged/i.test(raw);
      const error = diverged
        ? 'This install no longer matches the published version and cannot update itself. Your studio contact needs to reset it — event, settings and workbooks are not affected.'
        : raw;
      return res.status(500).json({ ok: false, error, diverged });
    }
    const alreadyCurrent = /up to date/i.test(out);

    // Under the Windows service the wrapper restarts us on exit, so we can
    // finish the update ourselves rather than asking the operator to go and
    // restart something. Unsupervised (a dev machine, or run from the Force
    // Start window) there is nothing to bring us back, so we must not exit —
    // the operator restarts manually instead.
    const supervised = process.env.VMIX_SUPERVISED === '1';
    const willRestart = supervised && !alreadyCurrent;
    res.json({ ok: true, alreadyCurrent, willRestart, output: out || stderr });

    if (willRestart) {
      console.log('[update] pulled new code — exiting so the service restarts on it');
      // Let the response flush before dropping the process.
      setTimeout(() => process.exit(1), 750);
    }
  });
});

// ── Export graphics as transparent PNG stills ────────────────────────────
// For rebuilding a stream after the fact. One job at a time: the renderer
// borrows the live data files while it works, so two at once would fight
// over them and produce stills of each other's skaters.
const stills = require('./src/modules/graphicStills');
let stillsJob = null;   // { running, done, total, message, error, result, startedAt }

app.get('/api/export/browser', (_req, res) => {
  try {
    const b = stills.findBrowser();
    res.json({ ok: true, available: true, name: b.name });
  } catch (e) {
    res.json({ ok: true, available: false, error: e.message });
  }
});

app.get('/api/export/folder', (_req, res) => {
  const folder = settingsService.readSettings()?.exports?.folder || '';
  res.json({ ok: true, folder, resolved: folder || stills.OUT_ROOT });
});

app.post('/api/export/folder', (req, res) => {
  const folder = String(req.body?.folder ?? '').trim();
  settingsService.writeSettings({ exports: { folder } });
  res.json({ ok: true, folder, resolved: folder || stills.OUT_ROOT });
});

app.get('/api/export/status', (_req, res) => {
  res.json({ ok: true, job: stillsJob });
});

app.post('/api/export/stills', async (req, res) => {
  if (stillsJob?.running) {
    return res.status(409).json({ ok: false, error: 'An export is already running.' });
  }
  const { segmentId, graphics, scoreKind } = req.body || {};
  if (!segmentId) return res.status(400).json({ ok: false, error: 'segmentId is required' });

  stillsJob = { running: true, done: 0, total: 0, message: 'Starting…', error: null, result: null, startedAt: Date.now() };
  res.json({ ok: true, started: true });   // return immediately; progress is polled

  const cfg = readConfig().dataSource?.scApi || {};
  const apiBaseUrl = (cfg.baseUrl || 'https://sc-css-public-api-cmh9d3htgxfpdkb7.canadacentral-01.azurewebsites.net').replace(/\/$/, '');

  try {
    const result = await stills.exportStills({
      segmentId,
      graphics: Array.isArray(graphics) ? graphics : ['manual-skater', 'scoring'],
      scoreKind: scoreKind === 'category' ? 'category' : 'segment',
      apiBaseUrl,
      port: PORT,
      poller: scApiService,
      outRoot: settingsService.readSettings()?.exports?.folder || '',
      onProgress: p => {
        if (!stillsJob) return;
        Object.assign(stillsJob, p);
        broadcast({ type: 'export-progress', job: stillsJob });
      },
    });
    stillsJob = { ...stillsJob, running: false, result, message: 'Done' };
  } catch (e) {
    console.warn('[export] failed:', e.message);
    stillsJob = { ...stillsJob, running: false, error: e.message, message: 'Failed' };
  }
  broadcast({ type: 'export-progress', job: stillsJob });
  // The renderer restored the live data files; tell the graphics to reload.
  broadcast({ type: 'config-update' });
});

// Plain-text feedback endpoints for Companion. Each returns "1" if active or
// "0" otherwise — trivial to compare in a Companion feedback expression.
app.get('/api/feedback/graphic/:template', (req, res) => {
  const { template } = req.params;
  const visible = !!graphicState[template]?.visible;
  res.type('text/plain').send(visible ? '1' : '0');
});

async function getRecordingFeedbackState() {
  let vmixRecording = false;
  let controllerRecording = false;

  try {
    const status = await vmixService.getRecordingStatus();
    vmixRecording = !!status.recording;
  } catch { /* fall back to local controller state below */ }

  try {
    const local = recordingController.getStatus();
    controllerRecording = !!local.recording || local.activeSession?.status === 'recording';
  } catch { /* ignore */ }

  return vmixRecording || controllerRecording;
}

app.get('/api/feedback/recording', async (_req, res) => {
  const recording = await getRecordingFeedbackState();
  res.type('text/plain').send(recording ? '1' : '0');
});

function escapeSvgText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusButtonSvg({ active, label, subLabel, activeColor = '#d91535', inactiveColor = '#1b202b' }) {
  const bg = active ? activeColor : inactiveColor;
  const border = active ? '#ff6f86' : '#3a4355';
  const glow = active ? '0 0 18px rgba(255, 45, 86, 0.72)' : 'none';
  const dot = active ? '#35f06f' : '#6c7482';
  const safeLabel = escapeSvgText(label);
  const safeSubLabel = escapeSvgText(subLabel || (active ? 'ACTIVE' : 'INACTIVE'));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="288" height="144" viewBox="0 0 288 144">
  <rect width="288" height="144" rx="18" fill="${bg}"/>
  <rect x="4" y="4" width="280" height="136" rx="15" fill="none" stroke="${border}" stroke-width="5"/>
  <circle cx="36" cy="36" r="10" fill="${dot}" style="filter: drop-shadow(${glow});"/>
  <text x="144" y="70" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800" fill="#ffffff">${safeLabel}</text>
  <text x="144" y="101" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" letter-spacing="2" fill="#ffffff" opacity="0.82">${safeSubLabel}</text>
</svg>`;
}

function sendStatusSvg(res, options) {
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(statusButtonSvg(options));
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buffers) {
  let c = 0xffffffff;
  buffers.forEach(buffer => {
    for (let i = 0; i < buffer.length; i += 1) {
      c = PNG_CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    }
  });
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(pngCrc32([typeBuffer, data]), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function parseHexColor(value, fallback) {
  const raw = String(value || fallback || '').replace(/^#/, '').trim();
  const hex = raw.length === 3
    ? raw.split('').map(char => char + char).join('')
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return parseHexColor(fallback || '#1b202b', '#1b202b');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

const PNG_FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function createPngCanvas(width = 288, height = 144, color = '#1b202b') {
  const [r, g, b] = parseHexColor(color, '#1b202b');
  const rowLength = 1 + width * 4;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = rowOffset + 1 + x * 4;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = 255;
    }
  }
  return { width, height, raw, rowLength };
}

function setPngPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const [r, g, b] = Array.isArray(color) ? color : parseHexColor(color, '#ffffff');
  const idx = y * canvas.rowLength + 1 + x * 4;
  canvas.raw[idx] = r;
  canvas.raw[idx + 1] = g;
  canvas.raw[idx + 2] = b;
  canvas.raw[idx + 3] = 255;
}

function fillPngRect(canvas, x, y, width, height, color) {
  for (let yy = Math.max(0, y); yy < Math.min(canvas.height, y + height); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(canvas.width, x + width); xx += 1) {
      setPngPixel(canvas, xx, yy, color);
    }
  }
}

function strokePngRect(canvas, x, y, width, height, color, stroke = 2) {
  fillPngRect(canvas, x, y, width, stroke, color);
  fillPngRect(canvas, x, y + height - stroke, width, stroke, color);
  fillPngRect(canvas, x, y, stroke, height, color);
  fillPngRect(canvas, x + width - stroke, y, stroke, height, color);
}

function drawPngCircle(canvas, cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (Math.hypot(x - cx, y - cy) <= radius) setPngPixel(canvas, x, y, color);
    }
  }
}

function measurePngText(text, scale = 4) {
  const chars = String(text || '').toUpperCase().split('');
  return chars.length ? chars.length * 5 * scale + (chars.length - 1) * scale : 0;
}

function drawPngText(canvas, text, x, y, scale = 4, color = '#ffffff') {
  const chars = String(text || '').toUpperCase().split('');
  let cursor = x;
  chars.forEach(char => {
    const glyph = PNG_FONT[char] || PNG_FONT[' '];
    glyph.forEach((row, rowIndex) => {
      row.split('').forEach((cell, colIndex) => {
        if (cell !== '1') return;
        fillPngRect(canvas, cursor + colIndex * scale, y + rowIndex * scale, scale, scale, color);
      });
    });
    cursor += 6 * scale;
  });
}

function drawCenteredPngText(canvas, text, centerX, y, scale, color, shadow = true) {
  const width = measurePngText(text, scale);
  const x = Math.round(centerX - width / 2);
  if (shadow) drawPngText(canvas, text, x + Math.max(1, Math.round(scale / 3)), y + Math.max(1, Math.round(scale / 3)), scale, '#050609');
  drawPngText(canvas, text, x, y, scale, color);
}

function drawFittedCenteredPngText(canvas, text, centerX, y, preferredScale, minScale, maxWidth, color, shadow = true) {
  let scale = preferredScale;
  while (scale > minScale && measurePngText(text, scale) > maxWidth) {
    scale -= 1;
  }
  drawCenteredPngText(canvas, text, centerX, y, scale, color, shadow);
}

function encodePng(canvas) {
  const { width, height, raw } = canvas;

  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    header,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND'),
  ]);
}

function makeRecordingPng({ active, activeColor = '#d91535', inactiveColor = '#171a22' }) {
  const textColor = active ? '#d9dde6' : '#ffffff';
  const canvas = createPngCanvas(288, 288, active ? activeColor : inactiveColor);
  strokePngRect(canvas, 8, 8, 272, 272, active ? '#ff8a9c' : '#3a4355', 8);
  drawPngCircle(canvas, 44, 42, 15, active ? '#35f06f' : '#6c7482');
  drawCenteredPngText(canvas, 'REC', 144, 72, 11, textColor);
  drawCenteredPngText(canvas, active ? 'STARTED' : 'STOPPED', 144, 185, 5, textColor);
  return encodePng(canvas);
}

const PREVIEW_GRAPHIC_META = {
  'starting-order': { title: 'START ORDER', sub: 'GROUPS', accent: '#e31b3f' },
  scoring: { title: 'SCORING', sub: 'TOTAL SCORE', accent: '#e31b3f' },
  'lower-third': { title: 'LOWER THIRD', sub: 'NAME BAR', accent: '#e31b3f' },
  standings: { title: 'RANK 6', sub: 'STANDINGS', accent: '#e31b3f' },
  officials: { title: 'OFFICIALS', sub: 'JUDGES', accent: '#e31b3f' },
  elements: { title: 'ELEMENTS', sub: 'GOE TRACKER', accent: '#e31b3f' },
  messages: { title: 'MESSAGES', sub: 'ANNOUNCE', accent: '#e31b3f' },
  'manual-skater': { title: 'SKATER', sub: 'NAME BAR', accent: '#e31b3f' },
  interview: { title: 'INTERVIEW', sub: 'NAME BAR', accent: '#c9a227' },
  'skater-profile': { title: 'PROFILE', sub: 'SKATER BIO', accent: '#e31b3f' },
  rankings: { title: 'RANKINGS', sub: 'FINAL', accent: '#e31b3f' },
};

function makeGraphicPreviewPng({ template, active = false }) {
  const meta = PREVIEW_GRAPHIC_META[template] || {
    title: template.replace(/-/g, ' ').toUpperCase(),
    sub: 'GRAPHIC',
    accent: '#e31b3f',
  };
  const canvas = createPngCanvas(288, 288, active ? '#3a0712' : '#151922');
  strokePngRect(canvas, 8, 8, 272, 272, active ? '#ff6f86' : '#3a4355', 8);
  drawPngCircle(canvas, 43, 43, 14, active ? '#35f06f' : '#6c7482');
  fillPngRect(canvas, 28, 128, 232, 54, meta.accent);
  fillPngRect(canvas, 54, 190, 180, 14, '#0d1017');
  fillPngRect(canvas, 70, 211, 148, 10, '#252b36');

  if (template === 'starting-order' || template === 'rankings' || template === 'standings') {
    for (let i = 0; i < 4; i += 1) {
      fillPngRect(canvas, 72, 142 + i * 14, 88, 7, i % 2 ? '#25252b' : '#111217');
      fillPngRect(canvas, 174, 142 + i * 14, 38, 7, '#101116');
    }
  } else if (template === 'scoring') {
    fillPngRect(canvas, 54, 190, 48, 28, '#101116');
    fillPngRect(canvas, 120, 190, 48, 28, '#101116');
    fillPngRect(canvas, 186, 190, 48, 28, '#101116');
  } else if (template === 'elements') {
    ['#35f06f', '#d91535', '#6c7482', '#35f06f'].forEach((color, index) => drawPngCircle(canvas, 82 + index * 42, 206, 8, color));
  }

  drawFittedCenteredPngText(canvas, meta.title, 144, 72, 6, 3, 236, '#ffffff');
  drawFittedCenteredPngText(canvas, meta.sub, 144, 143, 5, 3, 206, '#ffffff');
  drawFittedCenteredPngText(canvas, active ? 'ON AIR' : 'READY', 144, 238, 4, 3, 190, active ? '#ffffff' : '#c7ceda');
  return encodePng(canvas);
}

function makeFeedbackTickPng() {
  const now = new Date();
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const canvas = createPngCanvas(288, 288, '#151922');
  strokePngRect(canvas, 8, 8, 272, 272, '#3a4355', 8);
  drawCenteredPngText(canvas, 'TICK', 144, 72, 8, '#ffffff');
  drawCenteredPngText(canvas, seconds, 144, 166, 10, '#e31b3f');
  drawCenteredPngText(canvas, 'REFRESH TEST', 144, 242, 3, '#c7ceda');
  return encodePng(canvas);
}

function sendStatusPng(res, options) {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(makeRecordingPng(options));
}

function sendPreviewPng(res, options) {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(makeGraphicPreviewPng(options));
}

app.get('/api/feedback/image/graphic/:template.svg', async (req, res) => {
  const { template } = req.params;
  if (template === 'recording') {
    const recording = await getRecordingFeedbackState();
    return sendStatusSvg(res, {
      active: recording,
      label: req.query.label || 'REC',
      subLabel: recording ? 'STARTED' : 'STOPPED',
      activeColor: req.query.activeColor || '#d91535',
      inactiveColor: req.query.inactiveColor || '#171a22',
    });
  }
  const visible = !!graphicState[template]?.visible;
  const label = req.query.label || template.replace(/-/g, ' ').toUpperCase();
  return sendStatusSvg(res, {
    active: visible,
    label,
    subLabel: visible ? 'ON AIR' : 'HIDDEN',
    activeColor: req.query.activeColor || '#d91535',
    inactiveColor: req.query.inactiveColor || '#1b202b',
  });
});

app.get('/api/feedback/image/graphic/:template.png', async (req, res) => {
  const { template } = req.params;
  if (template === 'recording') {
    const recording = await getRecordingFeedbackState();
    return sendStatusPng(res, {
      active: recording,
      activeColor: req.query.activeColor || '#d91535',
      inactiveColor: req.query.inactiveColor || '#171a22',
    });
  }
  const visible = !!graphicState[template]?.visible;
  return sendPreviewPng(res, { template, active: visible });
});

app.get('/api/feedback/preview/graphic/:template.png', (req, res) => {
  const { template } = req.params;
  const visible = !!graphicState[template]?.visible;
  sendPreviewPng(res, { template, active: visible });
});

app.get('/api/feedback/image/recording.svg', async (req, res) => {
  const recording = await getRecordingFeedbackState();
  sendStatusSvg(res, {
    active: recording,
    label: req.query.label || 'REC',
    subLabel: recording ? 'STARTED' : 'STOPPED',
    activeColor: req.query.activeColor || '#d91535',
    inactiveColor: req.query.inactiveColor || '#171a22',
  });
});

app.get('/api/feedback/image/recording.png', async (req, res) => {
  const recording = await getRecordingFeedbackState();
  sendStatusPng(res, {
    active: recording,
    activeColor: req.query.activeColor || '#d91535',
    inactiveColor: req.query.inactiveColor || '#171a22',
  });
});

function sendFeedbackTickPng(res) {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(makeFeedbackTickPng());
}

app.get('/api/feedback/image/tick.png', (_req, res) => {
  sendFeedbackTickPng(res);
});

app.get('/api/feedback/tick.png', (_req, res) => {
  sendFeedbackTickPng(res);
});

app.get('/api/feedback/image/test.png', (_req, res) => {
  sendFeedbackTickPng(res);
});

app.get('/api/graphics/:template/data', (req, res) => {
  const { template } = req.params;
  if (!TEMPLATES.includes(template)) return res.status(404).json({ error: 'unknown template' });
  const data = readData(template);
  if (!data) return res.status(404).json({ error: 'no data file' });
  res.json(data);
});

app.post('/api/graphics/:template/data', (req, res) => {
  const { template } = req.params;
  if (!TEMPLATES.includes(template)) return res.status(404).json({ error: 'unknown template' });
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'invalid payload' });
  writeData(template, payload);
  // Keep rankings cache in sync whenever data is pushed directly
  if (template === 'rankings') warmRankingsCache();
  graphicState[template] = { visible: payload.control?.visible, state: payload.control?.state };
  broadcast({ type: 'update', template, payload });
  res.json({ ok: true });
});

registerDual('/api/graphics/:template/show', (req, res) => {
  const { template } = req.params;
  if (!TEMPLATES.includes(template)) return res.status(404).json({ error: 'unknown template' });
  const result = mergeControl(template, { visible: true, state: 'animateIn' }, req.body?.data || null);
  res.json({ ok: true, revision: result.meta.revision });
});

registerDual('/api/graphics/:template/hide', (req, res) => {
  const { template } = req.params;
  if (!TEMPLATES.includes(template)) return res.status(404).json({ error: 'unknown template' });
  const result = mergeControl(template, { visible: false, state: 'animateOut' }, null);
  res.json({ ok: true, revision: result.meta.revision });
});

app.post('/api/graphics/:template/update', (req, res) => {
  const { template } = req.params;
  if (!TEMPLATES.includes(template)) return res.status(404).json({ error: 'unknown template' });
  const result = mergeControl(template, { state: 'animateUpdate' }, req.body?.data || null);
  res.json({ ok: true, revision: result.meta.revision });
});

function registerDualAsync(route, handler) {
  const wrapped = (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => res.status(500).json({ ok: false, success: false, error: err.message, message: err.message }));
  };
  app.get(route, wrapped);
  app.post(route, wrapped);
}

/**
 * Same idea for the plain (non-async) control routes.
 *
 * A Stream Deck's built-in Website action can only issue GET, so anything
 * POST-only is unreachable from a bare key press. These handlers read their
 * arguments from req.body, so on a GET the query string stands in for it —
 * ?minutes=2 behaves exactly like a JSON body of {"minutes": 2}.
 *
 * Only live operating actions are registered this way. Config writes, uploads
 * and /api/update stay POST-only on purpose: a GET can be fired by a link
 * preview, a prefetch or an over-eager crawler, and none of those should be
 * able to rewrite settings or pull code.
 */
function registerDual(route, handler) {
  const wrapped = (req, res) => {
    if (req.method === 'GET') {
      req.body = { ...(req.query || {}) };
      res.set('Cache-Control', 'no-store');
    }
    return handler(req, res);
  };
  app.get(route, wrapped);
  app.post(route, wrapped);
}

registerDualAsync('/api/graphics/:template/toggle', async (req, res) => {
  res.json(await toggleTemplateGraphic(req, req.params.template));
});
registerDualAsync('/api/control/graphic/:template/toggle', async (req, res) => {
  res.json(await toggleTemplateGraphic(req, req.params.template));
});
registerDualAsync('/api/control/toggle/:template', async (req, res) => {
  res.json(await toggleTemplateGraphic(req, req.params.template));
});
registerDualAsync('/api/graphics/:template/show', async (req, res) => {
  res.json(await setTemplateGraphicVisibility(req, req.params.template, true));
});

// Fetch-then-show: pulls fresh data from the configured source for a template,
// then shows the graphic — atomically. Lets Companion trigger one HTTP call
// for sources that are set to manual-only polling (Final Rankings, Rank 6
// Context, Officials, Start Order…) without needing a delay-then-show step.
//
// Templates → their underlying fetch endpoint:
//   starting-order → startOrder
//   scoring        → currentSkater
//   rankings       → ranking          (full segment leaderboard)
//   standings      → rankingContext   (Rank 6 corner)
//   officials      → officials
//   elements       → liveElements
//
// Body / query: `group` (for starting-order), `page` (for rankings).
// Responds after the fetch completes (or fails) AND the show action fires.
const FETCH_FOR_TEMPLATE = {
  'starting-order': 'startOrder',
  'scoring':        'currentSkater',
  'rankings':       'ranking',
  'standings':      'rankingContext',
  'officials':      'officials',
  'elements':       'liveElements',
};
async function fetchAndShow(req, template) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template: ${template}`);
  const endpoint = FETCH_FOR_TEMPLATE[template];
  const cfg = readConfig();
  const fetchResult = { attempted: !!endpoint, ok: false, message: null };
  if (endpoint) {
    try {
      if (getDataSourceMode(cfg) === 'csv-folder') {
        writeCsvEndpoint(endpoint, cfg, {
          group: req.query.group || req.body?.group,
          useCacheOnly: endpoint === 'startOrder' && Number(req.query.group || req.body?.group) >= 1,
        });
      } else {
        const url = buildUrl(cfg, endpoint);
        if (!url) throw new Error(`No URL configured for endpoint: ${endpoint}`);
        const raw  = await normalizers.fetchJson(url);
        const lang = cfg.language || 'en';
        let payload;
        switch (endpoint) {
          case 'startOrder': {
            const grp = Number(req.query.group || req.body?.group) || readData('starting-order')?.data?.groupNumber || null;
            const catInfo = await fetchCategoryInfo(cfg);
            payload = sc.normalizeStartingOrder(raw, grp, lang, catInfo);
            break;
          }
          case 'currentSkater': {
            payload = sc.normalizeScoring(raw, lang);
            if (payload) {
              const ltPayload = normalizeLowerThirdFromScoring(payload.data, lang);
              writeData('lower-third', ltPayload);
              graphicState['lower-third'] = { visible: ltPayload.control.visible, state: ltPayload.control.state };
              broadcast({ type: 'update', template: 'lower-third', payload: ltPayload });
            }
            break;
          }
          case 'liveElements': payload = normalizeAccumulatedElements(raw); break;
          case 'officials': {
            const catInfo = await fetchCategoryInfo(cfg);
            const ctx = pickRichestCategory(catInfo);
            payload = sc.normalizeOfficials(raw, lang, {
              categoryEn: ctx.en, categoryFr: ctx.fr,
              segmentEn:  ctx.segEn, segmentFr:  ctx.segFr,
            });
            break;
          }
          case 'ranking': {
            const fullPayload = sc.normalizeRankings(raw, rankingsCache.rowsPerPage || 6, 1, lang);
            rankingsCache.allRows     = fullPayload.data.allRows;
            rankingsCache.rowsPerPage = fullPayload.data.rowsPerPage;
            writeData('rankings', fullPayload);
            graphicState['rankings'] = { visible: fullPayload.control.visible, state: fullPayload.control.state };
            broadcast({ type: 'update', template: 'rankings', payload: fullPayload });
            payload = null; // already written above
            break;
          }
          case 'rankingContext': {
            const rank6 = sc.normalizeRank6(raw, lang);
            writeData('standings', rank6);
            graphicState['standings'] = { visible: rank6.control.visible, state: rank6.control.state };
            broadcast({ type: 'update', template: 'standings', payload: rank6 });
            payload = null;
            break;
          }
        }
        if (payload) {
          writeData(payload.meta.template, payload);
          graphicState[payload.meta.template] = { visible: payload.control.visible, state: payload.control.state };
          broadcast({ type: 'update', template: payload.meta.template, payload });
        }
      }
      fetchResult.ok = true;
    } catch (err) {
      fetchResult.message = err.message;
      // Continue to the show step anyway — better to show stale data than
      // miss a Companion cue because the source was briefly slow.
    }
  }
  const show = await setTemplateGraphicVisibility(req, template, true);
  return { ok: true, template, fetch: fetchResult, show };
}

registerDualAsync('/api/graphics/:template/fetch-and-show', async (req, res) => {
  try { res.json(await fetchAndShow(req, req.params.template)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
registerDualAsync('/api/control/graphic/:template/fetch-and-show', async (req, res) => {
  try { res.json(await fetchAndShow(req, req.params.template)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Clock (countdown / count-up) ────────────────────────────────────────
// Authoritative state lives in clock.json; the graphic computes its own
// displayed value from {mode, startedAt, durationMs, running} via rAF.
// Server only broadcasts state TRANSITIONS — no per-tick traffic.
function writeClock(state, controlOverride) {
  const existing = readData('clock') || {};
  const payload = {
    meta:    { template: 'clock', revision: Date.now(), updatedAt: new Date().toISOString() },
    control: Object.assign({}, existing.control || { visible: false, state: 'hidden' }, controlOverride || {}),
    data:    Object.assign({
      mode:        'countdown',   // 'countdown' | 'countup'
      startedAt:   null,          // ms epoch when timing began (null = not running)
      durationMs:  0,             // total target duration for countdown; 0 for countup
      running:     false,         // is the clock actively timing right now
      pausedAtMs:  0,             // elapsed when paused, so resume picks up
      label:       '',            // optional headline ("WARM-UP", "RESURFACE", etc.)
      finishedAt:  null,          // ms epoch when countdown hit 0 (or null)
    }, existing.data || {}, state || {}),
  };
  writeData('clock', payload);
  graphicState.clock = { visible: payload.control.visible, state: payload.control.state };
  broadcast({ type: 'update', template: 'clock', payload });
  return payload;
}

// Start a countdown of N seconds (or N ms via durationMs).
registerDual('/api/clock/countdown', (req, res) => {
  const q = Object.assign({}, req.query, req.body || {});
  const durationMs = Math.max(0, Number(q.durationMs) || (Number(q.seconds) || 0) * 1000);
  if (!durationMs) return res.status(400).json({ error: 'seconds or durationMs is required' });
  const show  = q.show === undefined ? true : !['0','false','no','off'].includes(String(q.show).toLowerCase());
  const label = String(q.label || '').trim();
  const payload = writeClock(
    { mode: 'countdown', startedAt: Date.now(), durationMs, running: true, pausedAtMs: 0, label, finishedAt: null },
    show ? { visible: true, state: 'animateIn' } : null
  );
  res.json({ ok: true, payload });
});

// Start a count-up from zero (or from `fromSeconds`).
registerDual('/api/clock/countup', (req, res) => {
  const q = Object.assign({}, req.query, req.body || {});
  const from = Math.max(0, Number(q.fromSeconds) || 0);
  const show = q.show === undefined ? true : !['0','false','no','off'].includes(String(q.show).toLowerCase());
  const label = String(q.label || '').trim();
  const payload = writeClock(
    { mode: 'countup', startedAt: Date.now() - from * 1000, durationMs: 0, running: true, pausedAtMs: 0, label, finishedAt: null },
    show ? { visible: true, state: 'animateIn' } : null
  );
  res.json({ ok: true, payload });
});

// Pause — freezes the displayed value where it is.
registerDual('/api/clock/pause', (_req, res) => {
  const existing = readData('clock')?.data || {};
  if (!existing.running || !existing.startedAt) {
    return res.json({ ok: true, payload: readData('clock') });
  }
  const elapsed = Date.now() - existing.startedAt;
  const payload = writeClock({ running: false, pausedAtMs: elapsed });
  res.json({ ok: true, payload });
});

// Resume from paused state.
registerDual('/api/clock/resume', (_req, res) => {
  const existing = readData('clock')?.data || {};
  if (existing.running) return res.json({ ok: true, payload: readData('clock') });
  const offset = Math.max(0, Number(existing.pausedAtMs) || 0);
  const payload = writeClock({ running: true, startedAt: Date.now() - offset, pausedAtMs: 0 });
  res.json({ ok: true, payload });
});

// Stop — running goes false, value freezes wherever it was.
registerDual('/api/clock/stop', (_req, res) => {
  const existing = readData('clock')?.data || {};
  const elapsed = existing.startedAt ? (Date.now() - existing.startedAt) : 0;
  const payload = writeClock({ running: false, pausedAtMs: elapsed });
  res.json({ ok: true, payload });
});

// Reset — back to zero (countup) or full duration remaining (countdown).
registerDual('/api/clock/reset', (_req, res) => {
  const payload = writeClock({ running: false, startedAt: null, pausedAtMs: 0, finishedAt: null });
  res.json({ ok: true, payload });
});

// Show / hide are the standard graphic toggles — exposed here too for
// Companion convenience so a single button URL drives the clock.
registerDual('/api/clock/show', (_req, res) => {
  res.json({ ok: true, payload: writeClock({}, { visible: true,  state: 'animateIn'  }) });
});
registerDual('/api/clock/hide', (_req, res) => {
  res.json({ ok: true, payload: writeClock({}, { visible: false, state: 'animateOut' }) });
});

// One-button toggles — press once to start + show, press again to hide + reset.
// Companion can wire a single button per preset and the operator never has to
// remember whether the clock is currently on air. Same query params as the
// non-toggle endpoints (seconds, fromSeconds, label).
function clockIsActive() {
  const cur = readData('clock');
  return !!cur?.control?.visible;
}

registerDual('/api/clock/countdown-toggle', (req, res) => {
  if (clockIsActive()) {
    const payload = writeClock(
      { running: false, startedAt: null, pausedAtMs: 0, finishedAt: null },
      { visible: false, state: 'animateOut' }
    );
    return res.json({ ok: true, action: 'hidden', payload });
  }
  const q = Object.assign({}, req.query, req.body || {});
  const durationMs = Math.max(0, Number(q.durationMs) || (Number(q.seconds) || 0) * 1000);
  if (!durationMs) return res.status(400).json({ error: 'seconds or durationMs is required' });
  const label = String(q.label || '').trim();
  const payload = writeClock(
    { mode: 'countdown', startedAt: Date.now(), durationMs, running: true, pausedAtMs: 0, label, finishedAt: null },
    { visible: true, state: 'animateIn' }
  );
  res.json({ ok: true, action: 'shown', payload });
});

registerDual('/api/clock/countup-toggle', (req, res) => {
  if (clockIsActive()) {
    const payload = writeClock(
      { running: false, startedAt: null, pausedAtMs: 0, finishedAt: null },
      { visible: false, state: 'animateOut' }
    );
    return res.json({ ok: true, action: 'hidden', payload });
  }
  const q = Object.assign({}, req.query, req.body || {});
  const from = Math.max(0, Number(q.fromSeconds) || 0);
  const label = String(q.label || '').trim();
  const payload = writeClock(
    { mode: 'countup', startedAt: Date.now() - from * 1000, durationMs: 0, running: true, pausedAtMs: 0, label, finishedAt: null },
    { visible: true, state: 'animateIn' }
  );
  res.json({ ok: true, action: 'shown', payload });
});

// ── Time-of-day clock ────────────────────────────────────────────────────
// Render-only — the client computes the displayed time itself via
// Intl.DateTimeFormat each tick. Server stores config (timezone, 12/24h,
// label, show-seconds) and visibility. No per-tick traffic.
function writeTimeOfDay(state, controlOverride) {
  const existing = readData('time-of-day') || {};
  const payload = {
    meta:    { template: 'time-of-day', revision: Date.now(), updatedAt: new Date().toISOString() },
    control: Object.assign({}, existing.control || { visible: false, state: 'hidden' }, controlOverride || {}),
    data:    Object.assign({
      timezone:    'America/Toronto',  // IANA tz name
      format24:    true,                // false = 12-hour with AM/PM
      showSeconds: true,
      label:       '',
    }, existing.data || {}, state || {}),
  };
  writeData('time-of-day', payload);
  graphicState['time-of-day'] = { visible: payload.control.visible, state: payload.control.state };
  broadcast({ type: 'update', template: 'time-of-day', payload });
  return payload;
}

// Update config without changing visibility. Body/query: timezone, format24,
// showSeconds, label.
app.post('/api/time-of-day/config', (req, res) => {
  const q = Object.assign({}, req.query, req.body || {});
  const state = {};
  if (q.timezone)    state.timezone    = String(q.timezone);
  if (q.format24 !== undefined) state.format24 = !['0','false','no','off'].includes(String(q.format24).toLowerCase());
  if (q.showSeconds !== undefined) state.showSeconds = !['0','false','no','off'].includes(String(q.showSeconds).toLowerCase());
  if (q.label !== undefined) state.label = String(q.label || '').trim();
  res.json({ ok: true, payload: writeTimeOfDay(state) });
});

registerDual('/api/time-of-day/show', (_req, res) => {
  res.json({ ok: true, payload: writeTimeOfDay({}, { visible: true,  state: 'animateIn'  }) });
});
registerDual('/api/time-of-day/hide', (_req, res) => {
  res.json({ ok: true, payload: writeTimeOfDay({}, { visible: false, state: 'animateOut' }) });
});
registerDual('/api/time-of-day/toggle', (_req, res) => {
  const visible = !!(readData('time-of-day')?.control?.visible);
  const payload = writeTimeOfDay({}, visible
    ? { visible: false, state: 'animateOut' }
    : { visible: true,  state: 'animateIn'  });
  res.json({ ok: true, action: visible ? 'hidden' : 'shown', payload });
});

// Convenience: start + show + hide-after for the common "give them N seconds"
// pattern. Body/query: { seconds, autoHideAfterFinishMs }.
registerDual('/api/clock/countdown-show', (req, res) => {
  const q = Object.assign({}, req.query, req.body || {});
  const durationMs = Math.max(0, Number(q.durationMs) || (Number(q.seconds) || 0) * 1000);
  if (!durationMs) return res.status(400).json({ error: 'seconds or durationMs is required' });
  const label = String(q.label || '').trim();
  const payload = writeClock(
    { mode: 'countdown', startedAt: Date.now(), durationMs, running: true, pausedAtMs: 0, label, finishedAt: null },
    { visible: true, state: 'animateIn' }
  );
  res.json({ ok: true, payload });
});


registerDualAsync('/api/graphics/:template/hide', async (req, res) => {
  res.json(await setTemplateGraphicVisibility(req, req.params.template, false));
});
registerDualAsync('/api/control/graphic/:template/show', async (req, res) => {
  res.json(await setTemplateGraphicVisibility(req, req.params.template, true));
});
registerDualAsync('/api/control/graphic/:template/hide', async (req, res) => {
  res.json(await setTemplateGraphicVisibility(req, req.params.template, false));
});
registerDualAsync('/api/graphics/starting-order/group/:n/toggle', async (req, res) => {
  res.json(await toggleStartingOrderGroup(req, req.params.n));
});
registerDualAsync('/api/control/starting-order/group/:n/toggle', async (req, res) => {
  res.json(await toggleStartingOrderGroup(req, req.params.n));
});
registerDualAsync('/api/graphics/rankings/page/:n/toggle', async (req, res) => {
  res.json(await toggleRankingsPage(req, req.params.n));
});
registerDualAsync('/api/control/rankings/page/:n/toggle', async (req, res) => {
  res.json(await toggleRankingsPage(req, req.params.n));
});

function registerMessageAction(route, handler) {
  const wrapped = (req, res) => {
    try {
      res.json(handler(req));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get(route, wrapped);
  app.post(route, wrapped);
}

app.get('/api/messages/status', (_req, res) => {
  try {
    const status = messagesService.current();
    res.json({
      ok: true,
      settings: status.settings,
      selected: status.selected,
      rows: status.workbook.rows,
      headers: status.workbook.headers,
      sheetName: status.workbook.sheetName,
      sheetNames: status.workbook.sheetNames,
      workbookPath: status.workbook.workbookPath,
      payload: status.payload,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, settings: messagesService.settings() });
  }
});

app.post('/api/messages/config', (req, res) => {
  try {
    const settings = messagesService.saveSettings(req.body || {});
    const status = messagesService.current({ write: true });
    res.json({ ok: true, settings, rows: status.workbook.rows, headers: status.workbook.headers, sheetNames: status.workbook.sheetNames });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Upload a messages workbook straight from the operator's computer — no path
// typing. Body: { filename, dataBase64 }. Saved under uploads/messages/ and
// wired up as the active workbook, then the list refreshes.
const UPLOADS_DIR = path.join(__dirname, 'uploads');
app.post('/api/messages/upload', (req, res) => {
  try {
    const { filename, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) return res.status(400).json({ ok: false, error: 'filename and dataBase64 are required' });
    if (!/\.(xlsx|xls|csv)$/i.test(filename)) return res.status(400).json({ ok: false, error: 'File must be .xlsx, .xls, or .csv' });
    // Sanitize to a safe basename (strip any path components + odd chars).
    const safe = path.basename(filename).replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'messages.xlsx';
    const destDir = path.join(UPLOADS_DIR, 'messages');
    ensureDir(destDir);
    const buf = Buffer.from(String(dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'File too large (max 15 MB)' });
    fs.writeFileSync(path.join(destDir, safe), buf);
    // Relative path resolves against rootDir in the messages service.
    const relPath = path.join('uploads', 'messages', safe);
    messagesService.saveSettings({ workbookPath: relPath, sheetName: '' });
    const status = messagesService.current({ write: true });
    res.json({ ok: true, filename: safe, workbookPath: relPath,
      rows: status.workbook.rows, headers: status.workbook.headers, sheetNames: status.workbook.sheetNames });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

registerMessageAction('/api/messages/refresh', () => messagesService.refresh());
registerMessageAction('/api/messages/show', () => messagesService.show());
registerMessageAction('/api/messages/hide', () => messagesService.hide());
registerMessageAction('/api/messages/next', () => messagesService.move(1));
registerMessageAction('/api/messages/previous', () => messagesService.move(-1));
registerMessageAction('/api/messages/return-to-list', () => messagesService.returnToList());
registerMessageAction('/api/messages/row/:n', req => messagesService.selectIndex(Number(req.params.n) - 1, { visible: true }));
registerMessageAction('/api/messages/excel-row/:n', req => {
  const workbook = messagesService.readWorkbookRows();
  const row = workbook.rows.find(item => Number(item.excelRow) === Number(req.params.n));
  if (!row) throw new Error(`No message found at Excel row ${req.params.n}`);
  return messagesService.selectIndex(row.index, { visible: true });
});
registerMessageAction('/api/messages/manual', req => messagesService.manual({ ...req.query, ...(req.body || {}) }));

registerMessageAction('/api/control/messages-refresh', () => messagesService.refresh());
registerMessageAction('/api/control/messages-show', () => messagesService.show());
registerMessageAction('/api/control/messages-hide', () => messagesService.hide());
registerMessageAction('/api/control/messages-next', () => messagesService.move(1));
registerMessageAction('/api/control/messages-previous', () => messagesService.move(-1));
registerMessageAction('/api/control/messages-return-to-list', () => messagesService.returnToList());
registerMessageAction('/api/control/messages-row/:n', req => messagesService.selectIndex(Number(req.params.n) - 1, { visible: true }));
registerMessageAction('/api/control/messages-manual', req => messagesService.manual({ ...req.query, ...(req.body || {}) }));

app.get('/api/manual-skaters/status', (_req, res) => {
  try {
    const status = manualSkatersService.current();
    res.json({
      ok: true,
      settings: status.settings,
      selected: status.selected,
      rows: status.workbook.rows,
      headers: status.workbook.headers,
      headerRow: status.workbook.headerRow,
      sheetName: status.workbook.sheetName,
      sheetNames: status.workbook.sheetNames,
      workbookPath: status.workbook.workbookPath,
      payload: status.payload,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, settings: manualSkatersService.settings() });
  }
});

app.post('/api/manual-skaters/config', (req, res) => {
  try {
    const settings = manualSkatersService.saveSettings(req.body || {});
    const status = manualSkatersService.current({ write: true });
    res.json({
      ok: true,
      settings,
      rows: status.workbook.rows,
      headers: status.workbook.headers,
      headerRow: status.workbook.headerRow,
      sheetNames: status.workbook.sheetNames,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

registerMessageAction('/api/manual-skaters/refresh', () => manualSkatersService.refresh());
registerMessageAction('/api/manual-skaters/show', () => manualSkatersService.show());
registerMessageAction('/api/manual-skaters/hide', () => manualSkatersService.hide());
registerMessageAction('/api/manual-skaters/next', () => manualSkatersService.move(1));
registerMessageAction('/api/manual-skaters/previous', () => manualSkatersService.move(-1));
registerMessageAction('/api/manual-skaters/return-to-list', () => manualSkatersService.returnToList());
registerMessageAction('/api/manual-skaters/row/:n', req => manualSkatersService.selectIndex(Number(req.params.n) - 1));
registerMessageAction('/api/manual-skaters/excel-row/:n', req => {
  const workbook = manualSkatersService.readWorkbookRows();
  const row = workbook.rows.find(item => Number(item.excelRow) === Number(req.params.n));
  if (!row) throw new Error(`No skater found at Excel row ${req.params.n}`);
  return manualSkatersService.selectIndex(row.index);
});
registerMessageAction('/api/manual-skaters/manual', req => manualSkatersService.manual({ ...req.query, ...(req.body || {}) }));

registerMessageAction('/api/control/manual-skaters-refresh', () => manualSkatersService.refresh());
registerMessageAction('/api/control/manual-skaters-show', () => manualSkatersService.show());
registerMessageAction('/api/control/manual-skaters-hide', () => manualSkatersService.hide());
registerMessageAction('/api/control/manual-skaters-next', () => manualSkatersService.move(1));
registerMessageAction('/api/control/manual-skaters-previous', () => manualSkatersService.move(-1));
registerMessageAction('/api/control/manual-skaters-return-to-list', () => manualSkatersService.returnToList());
registerMessageAction('/api/control/manual-skaters-row/:n', req => manualSkatersService.selectIndex(Number(req.params.n) - 1, { visible: true }));
registerMessageAction('/api/control/manual-skaters-manual', req => manualSkatersService.manual({ ...req.query, ...(req.body || {}) }));

// GET /api/debug/categories — quick diagnostic that returns the category /
// segment fields each graphic is currently holding, plus the eventInfo
// cache and the result of pickRichestCategory(). Use this when the
// on-air title doesn't look right to see exactly what each data file has.
app.get('/api/debug/categories', (_req, res) => {
  const summary = {};
  for (const tpl of ['officials', 'rankings', 'standings', 'starting-order', 'scoring']) {
    const d = readData(tpl)?.data || {};
    summary[tpl] = {
      categoryName:    d.categoryName    || null,
      categoryNameFr:  d.categoryNameFr  || null,
      segmentName:     d.segmentName     || null,
      segmentNameFr:   d.segmentNameFr   || null,
      titleEn:         d.titleEn         || null,
      titleFr:         d.titleFr         || null,
    };
  }
  res.json({
    ok: true,
    eventInfoCache: _eventInfoCache.info,
    perTemplate: summary,
    pickRichest: pickRichestCategory(_eventInfoCache.info),
  });
});

// GET /api/eventInfo/debug
// Operator-side inspector. Returns whatever eventInfo.php (or the CSV
// equivalent) is currently serving, the normalized field map, and the
// values that have been patched onto event-config.json. Bypasses the
// 30s in-process cache so the operator sees exactly what's on the wire.
app.get('/api/eventInfo/debug', async (_req, res) => {
  const cfg = readConfig();
  const mode = getDataSourceMode(cfg);
  const result = {
    ok: true,
    mode,
    source: null,
    fetchedAt: new Date().toISOString(),
    raw: null,
    normalized: null,
    cachedInfo: _eventInfoCache.info,
    cachedAt: _eventInfoCache.at ? new Date(_eventInfoCache.at).toISOString() : null,
    currentConfig: {
      eventName:       cfg.eventName       || '',
      eventNameFr:     cfg.eventNameFr     || '',
      eventLocation:   cfg.eventLocation   || '',
      eventDate:       cfg.eventDate       || '',
      categoryName:    cfg.categoryName    || '',
      categoryNameFr:  cfg.categoryNameFr  || '',
      segmentName:     cfg.segmentName     || '',
      segmentNameFr:   cfg.segmentNameFr   || '',
    },
    warnings: [],
  };

  try {
    if (mode === 'csv-folder') {
      const fp = csvFilePath(cfg, 'eventInfo');
      result.source = fp || '(no eventInfo CSV configured)';
      if (!fp || !fs.existsSync(fp)) {
        result.warnings.push('CSV event info file not found');
        return res.json(result);
      }
      const rawRow = csvAdapter.readFirstRow ? csvAdapter.readFirstRow(fp) : null;
      result.raw = rawRow;
      result.normalized = normalizers.fromCsv(fp, 'event-info');
    } else {
      const url = buildUrl(cfg, 'eventInfo');
      result.source = url || '(no eventInfo URL configured)';
      if (!url) {
        result.warnings.push('No eventInfo URL configured');
        return res.json(result);
      }
      const raw = await normalizers.fetchJson(url);
      result.raw = raw;
      result.normalized = sc.normalizeEventInfo(raw);
    }
    return res.json(result);
  } catch (err) {
    result.warnings.push(err.message);
    return res.json(result);
  }
});

// GET /api/preview/starting-order/group/:n
// Preview-only: returns a normalized group payload without writing data files
// or broadcasting to live/on-air graphics.
app.get('/api/preview/starting-order/group/:n', async (req, res) => {
  const group = Number(req.params.n);
  if (!group || group < 1) return res.status(400).json({ error: 'invalid group number' });

  const cfg = readConfig();
  const csv = getCsvSettings(cfg);
  const sourceMode = getDataSourceMode(cfg);
  const sourceId = sourceMode === 'csv-folder'
    ? (csvFilePath(cfg, 'startOrder') || path.resolve(csv.folderPath, csv.files.startOrder || ''))
    : (buildUrl(cfg, 'startOrder') || '');
  const cacheKey = `${sourceMode}:${sourceId}:group:${group}:lang:${cfg.language || 'en'}`;
  const cached = previewStartOrderCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 1500) return res.json(cached.payload);

  try {
    let payload;
    if (sourceMode === 'sc-api') {
      // sc-api mode: pollOnce() already wrote the correct data to starting-order.json.
      // Just read that file and serve the requested group slice from it.
      const existing = readData('starting-order');
      if (!existing) throw new Error('No starting-order data available yet — select a segment first');
      const allRows = existing.data?.allRows || existing.data?.rows || [];
      const grouped = {};
      allRows.forEach(r => {
        const g = r.warmUpGroup ?? 1;
        if (!grouped[g]) grouped[g] = [];
        grouped[g].push(r);
      });
      const availableGroups = Object.keys(grouped).map(Number).sort((a, b) => a - b);
      const targetGroup = availableGroups.includes(group) ? group : (availableGroups[0] ?? 1);
      const rows = (grouped[targetGroup] || allRows).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
      payload = {
        ...existing,
        data: {
          ...existing.data,
          rows,
          rowCount:        rows.length,
          groupNumber:     targetGroup,
          groupCount:      availableGroups.length || 1,
          availableGroups: availableGroups.length ? availableGroups : [1],
        },
      };
    } else if (sourceMode === 'csv-folder') {
      const filePath = csvFilePath(cfg, 'startOrder');
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`CSV start order file not found in ${csv.folderPath} (configured: ${csv.files.startOrder || 'none'})`);
      }
      const groups = csvAdapter.buildStartOrderGroups(filePath);
      payload = csvAdapter.startingOrderPayloadFromGroups(groups, {
        context: resolveCsvContextPreview(cfg),
        groupNumber: group,
      });
    } else {
      const url = buildUrl(cfg, 'startOrder');
      if (!url) return res.status(400).json({ error: 'No startOrder URL configured' });
      const raw = await normalizers.fetchJson(url);
      const context = sourceContextFromConfig(cfg);
      payload = sc.normalizeStartingOrder(raw, group, cfg.language || 'en', {
        en: context.categoryName,
        fr: context.categoryNameFr,
        segmentEn: context.segmentName,
        segmentFr: context.segmentNameFr,
      });
    }

    if (!payload) throw new Error('Normalizer returned null');
    payload.control = { ...(payload.control || {}), visible: true, state: 'animateIn' };
    previewStartOrderCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/graphics/rankings/page — slice cached full data to a new page
registerDual('/api/graphics/rankings/page', (req, res) => {
  const { page } = req.body || {};
  const result = setRankingsPage(page);
  res.json({ ok: true, page: result.page, pageCount: result.pageCount, rowsPerPage: result.rowsPerPage, rowCount: result.rowCount });
});

// GET /api/normalize — fetch from URL or file, normalize, write, broadcast
app.get('/api/normalize', async (req, res) => {
  const { source, template, group, maxRows } = req.query;
  if (!source)   return res.status(400).json({ error: 'source is required' });
  if (!template) return res.status(400).json({ error: 'template is required' });
  if (!TEMPLATES.includes(template)) return res.status(400).json({ error: 'unknown template' });

  const options = {
    groupNumber: group   ? Number(group)   : null,
    maxRows:     maxRows ? Number(maxRows)  : null,
  };
  try {
    let payload;
    if (source.startsWith('http://') || source.startsWith('https://')) {
      payload = await normalizers.fromUrl(source, template, options);
    } else {
      payload = normalizers.fromFile(source, template, options);
    }
    writeData(template, payload);
    graphicState[template] = { visible: payload.control?.visible, state: payload.control?.state };
    broadcast({ type: 'update', template, payload });
    res.json({ ok: true, revision: payload.meta.revision, rowCount: payload.data?.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sc/fetch — fetch a named SC endpoint by key, normalize, write, broadcast
// Body: { endpoint: "startOrder"|"currentSkater"|..., group: 1, show: true }
app.post('/api/sc/fetch', async (req, res) => {
  const { endpoint, group, show } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

  const cfg = readConfig();
  if (getDataSourceMode(cfg) === 'csv-folder') {
    try {
      const result = writeCsvEndpoint(endpoint, cfg, {
        group,
        show,
        useCacheOnly: endpoint === 'startOrder' && Number(group) >= 1,
      });
      if (endpoint === 'eventInfo') return res.json({ ok: true, info: result.info });
      return res.json({
        ok: true,
        revision: result.payload?.meta?.revision,
        rowCount: result.payload?.data?.rowCount || result.payload?.data?.rows?.length || 0,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (getDataSourceMode(cfg) === 'sc-api') {
    // In sc-api mode the polling service owns all template data.
    // Re-poll now and return the result without touching the old live-stream URL.
    try {
      await Promise.allSettled([scApiService.pollOnce(), scApiService.pollOfficials()]);
      const payload = readData(endpoint === 'startOrder' ? 'starting-order' : endpoint) || {};
      return res.json({ ok: true, revision: payload.meta?.revision, rowCount: payload.data?.rowCount || payload.data?.rows?.length || 0 });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const url = buildUrl(cfg, endpoint);
  if (!url) return res.status(400).json({ error: `No URL configured for endpoint: ${endpoint}` });

  try {
    const raw  = await normalizers.fetchJson(url);
    const lang = cfg.language || 'en';
    let payload;

    switch (endpoint) {
      case 'startOrder': {
        const catInfo = await fetchCategoryInfo(cfg);
        payload = sc.normalizeStartingOrder(raw, group ? Number(group) : null, lang, catInfo);
        break;
      }
      case 'currentSkater': {
        payload = sc.normalizeScoring(raw, lang);
        if (payload) {
          const ltPayload = normalizeLowerThirdFromScoring(payload.data, lang);
          writeData('lower-third', ltPayload);
          graphicState['lower-third'] = { visible: ltPayload.control.visible, state: ltPayload.control.state };
          broadcast({ type: 'update', template: 'lower-third', payload: ltPayload });
        }
        break;
      }
      case 'liveElements':  payload = normalizeAccumulatedElements(raw); break;
      case 'officials': {
        const catInfo = await fetchCategoryInfo(cfg);
        const ctx = pickRichestCategory(catInfo);
        payload = sc.normalizeOfficials(raw, lang, {
          categoryEn: ctx.en,
          categoryFr: ctx.fr,
          segmentEn:  ctx.segEn,
          segmentFr:  ctx.segFr,
        });
        break;
      }
      case 'ranking': {
        // Full rankings (ranking-seg.php) → rankings.json only
        const fullPayload  = sc.normalizeRankings(raw, rankingsCache.rowsPerPage || 6, 1, lang);
        rankingsCache.allRows    = fullPayload.data.allRows;
        rankingsCache.rowsPerPage = fullPayload.data.rowsPerPage;
        if (show) fullPayload.control.visible = true;
        writeData('rankings', fullPayload);
        graphicState['rankings'] = { visible: fullPayload.control.visible, state: fullPayload.control.state };
        broadcast({ type: 'update', template: 'rankings', payload: fullPayload });
        return res.json({ ok: true, revision: fullPayload.meta.revision, rowCount: fullPayload.data.allRows.length,
                          pageCount: fullPayload.data.pageCount });
      }
      case 'rankingContext': {
        // Rank 6 context (ranking.php) → standings.json only
        const rank6Payload = sc.normalizeRank6(raw, lang);
        if (show) rank6Payload.control.visible = true;
        writeData('standings', rank6Payload);
        graphicState['standings'] = { visible: rank6Payload.control.visible, state: rank6Payload.control.state };
        broadcast({ type: 'update', template: 'standings', payload: rank6Payload });
        return res.json({ ok: true, revision: rank6Payload.meta.revision, rowCount: rank6Payload.data?.rows?.length });
      }
      case 'eventInfo': {
        const info = sc.normalizeEventInfo(raw);
        applyEventInfoPatch(info);
        return res.json({ ok: true, info });
      }
      default:
        return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
    }

    if (!payload) return res.status(500).json({ error: 'Normalizer returned null' });

    if (show) payload.control.visible = true;

    writeData(payload.meta.template, payload);
    graphicState[payload.meta.template] = { visible: payload.control.visible, state: payload.control.state };
    broadcast({ type: 'update', template: payload.meta.template, payload });
    res.json({ ok: true, revision: payload.meta.revision, rowCount: payload.data?.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/graphics/rankings/rows-per-page — change rows per page & re-slice
registerDual('/api/graphics/rankings/rows-per-page', (req, res) => {
  const rpp = Math.max(1, Math.min(20, Number(req.body?.rowsPerPage) || 6));

  ensureRankingsCacheLoaded();

  if (rankingsCache.groupedPageMode && rankingsCache.pages.length) {
    const pageCount = Math.max(1, rankingsCache.pages.length);
    const page = Math.min(Math.max(1, Number(readData('rankings')?.data?.page) || 1), pageCount);
    const rows = rankingsCache.pages[page - 1] || [];
    return res.json({ ok: true, page, pageCount, rowsPerPage: rows.length, rowCount: rows.length });
  }

  rankingsCache.rowsPerPage = rpp;
  const allRows   = rankingsCache.allRows;
  if (!allRows.length) return res.json({ ok: true, rowsPerPage: rpp, pageCount: 0 });

  const pageCount = Math.max(1, Math.ceil(allRows.length / rpp));
  const rows      = allRows.slice(0, rpp);

  const existing = readData('rankings') || {
    meta: { template: 'rankings', revision: 0, updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn' },
    data: {},
  };
  existing.data           = { ...existing.data, page: 1, pageCount, rowsPerPage: rpp, rows, rowCount: rows.length };
  existing.meta.revision  = Date.now();
  existing.meta.updatedAt = new Date().toISOString();
  existing.control.state  = 'pageChange';

  writeData('rankings', existing);
  graphicState['rankings'] = { visible: existing.control.visible, state: existing.control.state };
  broadcast({ type: 'update', template: 'rankings', payload: existing });
  res.json({ ok: true, page: 1, pageCount, rowsPerPage: rpp, rowCount: rows.length });
});

// POST /api/graphics/starting-order/group/:n — Companion shortcut, no JSON body needed
registerDual('/api/graphics/starting-order/group/:n', async (req, res) => {
  try {
    const result = await setStartingOrderGroup(req.params.n);
    res.json({ ok: true, group: result.group, revision: result.revision, rowCount: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/graphics/rankings/page/:n — Companion shortcut, no JSON body needed
registerDual('/api/graphics/rankings/page/:n', (req, res) => {
  const result = setRankingsPage(req.params.n);
  res.json({ ok: true, page: result.page, pageCount: result.pageCount, rowsPerPage: result.rowsPerPage, rowCount: result.rowCount });
});

// POST /api/live-poll/start|stop
registerDual('/api/live-poll/start', (_req, res) => {
  try {
    const cfg = readConfig();
    cfg.dataSource = Object.assign({}, cfg.dataSource || {}, {
      livePoll: Object.assign({}, cfg.dataSource?.livePoll || {}, { enabled: true }),
    });
    writeConfig(cfg);
    startConfiguredPolling();
    res.json({ ok: true, active: isSourcePollingActive() });
  } catch (err) {
    console.error('[live-poll] start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
registerDual('/api/live-poll/stop', (_req, res) => {
  try {
    const cfg = readConfig();
    cfg.dataSource = Object.assign({}, cfg.dataSource || {}, {
      livePoll: Object.assign({}, cfg.dataSource?.livePoll || {}, { enabled: false }),
    });
    writeConfig(cfg);
    stopAllPolling();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logos — list image files in public/assets/logos/
app.get('/api/logos', (_req, res) => {
  const logoDir = path.join(__dirname, 'public', 'assets', 'logos');
  try {
    const files = fs.existsSync(logoDir)
      ? fs.readdirSync(logoDir).filter(f => /\.(png|jpe?g|svg|gif|webp)$/i.test(f)).sort()
      : [];
    res.json(files);
  } catch { res.json([]); }
});

// ── Config history (auto-backup) ─────────────────────────────────────────
// Snapshots are written by writeConfig() on every save and pruned to the
// last 20. The operator UI uses these endpoints to list & restore them.
app.get('/api/config/history', (_req, res) => {
  res.json({ ok: true, backups: listConfigBackups() });
});

app.post('/api/config/restore', (req, res) => {
  const name = String(req.body?.name || '').replace(/[\/\\]/g, '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  const fp = path.join(CONFIG_HISTORY_DIR, name);
  if (!fp.startsWith(CONFIG_HISTORY_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'backup not found' });
  }
  try {
    const restored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    writeConfig(restored);
    res.json({ ok: true, restored: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config presets (named bundles) ───────────────────────────────────────
app.get('/api/presets', (_req, res) => {
  res.json({ ok: true, presets: listPresets() });
});

app.get('/api/presets/:name', (req, res) => {
  const name = safePresetName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid preset name' });
  const fp = path.join(PRESETS_DIR, `${name}.json`);
  if (!fp.startsWith(PRESETS_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'preset not found' });
  }
  try { res.json({ ok: true, name, data: JSON.parse(fs.readFileSync(fp, 'utf8')) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Save the CURRENT event-config as a named preset. Body: { name }.
app.put('/api/presets/:name', (req, res) => {
  const name = safePresetName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid preset name' });
  ensureDir(PRESETS_DIR);
  const fp = path.join(PRESETS_DIR, `${name}.json`);
  if (!fp.startsWith(PRESETS_DIR)) return res.status(400).json({ error: 'invalid path' });
  try {
    fs.writeFileSync(fp, JSON.stringify(readConfig(), null, 2));
    res.json({ ok: true, name, savedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply a preset to event-config.json. Goes through writeConfig() so the
// previous config gets backed up first — no data loss when switching.
app.post('/api/presets/:name/load', (req, res) => {
  const name = safePresetName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid preset name' });
  const fp = path.join(PRESETS_DIR, `${name}.json`);
  if (!fp.startsWith(PRESETS_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'preset not found' });
  }
  try {
    const preset = JSON.parse(fs.readFileSync(fp, 'utf8'));
    writeConfig(preset);
    res.json({ ok: true, loaded: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/presets/:name', (req, res) => {
  const name = safePresetName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid preset name' });
  const fp = path.join(PRESETS_DIR, `${name}.json`);
  if (!fp.startsWith(PRESETS_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'preset not found' });
  }
  try { fs.unlinkSync(fp); res.json({ ok: true, deleted: name }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/config
app.get('/api/config', (_req, res) => res.json(readConfig()));

// POST /api/config — save event-config.json
app.post('/api/config', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'invalid body' });
  const current = readConfig();
  const languageChanged = incoming.language && incoming.language !== (current.language || 'en');
  const merged  = Object.assign({}, current, incoming);
  // Deep-merge theme
  if (incoming.theme) merged.theme = Object.assign({}, current.theme || {}, incoming.theme);
  if (incoming.dataSource) {
    merged.dataSource = Object.assign({}, current.dataSource || {}, incoming.dataSource);
    if (incoming.dataSource.urls) {
      merged.dataSource.urls = Object.assign({}, current.dataSource?.urls || {}, incoming.dataSource.urls);
    }
    if (incoming.dataSource.livePoll) {
      merged.dataSource.livePoll = Object.assign({}, current.dataSource?.livePoll || {}, incoming.dataSource.livePoll);
      if (incoming.dataSource.livePoll.intervals) {
        merged.dataSource.livePoll.intervals = Object.assign(
          {},
          current.dataSource?.livePoll?.intervals || {},
          incoming.dataSource.livePoll.intervals
        );
      }
      if (incoming.dataSource.livePoll.endpoints) {
        merged.dataSource.livePoll.endpoints = Object.assign(
          {},
          current.dataSource?.livePoll?.endpoints || {},
          incoming.dataSource.livePoll.endpoints
        );
      }
    }
    if (incoming.dataSource.csv) {
      merged.dataSource.csv = Object.assign({}, current.dataSource?.csv || {}, incoming.dataSource.csv);
      if (incoming.dataSource.csv.files) {
        merged.dataSource.csv.files = Object.assign({}, current.dataSource?.csv?.files || {}, incoming.dataSource.csv.files);
      }
    }
    if (incoming.dataSource.scApi) {
      merged.dataSource.scApi = Object.assign({}, current.dataSource?.scApi || {}, incoming.dataSource.scApi);
    }
  }
  if (incoming.autoRecord) {
    merged.autoRecord = Object.assign({}, current.autoRecord || {}, incoming.autoRecord);
  }
  writeConfig(merged);
  // When language changes, immediately re-poll all configured live endpoints so
  // data files regenerate with correct titleEn/titleFr/title for the new language.
  // Runs even if live polling timers are OFF — we want a one-shot refresh regardless.
  if (languageChanged) {
    setTimeout(() => {
      const freshCfg = readConfig();
      const mode = getDataSourceMode(freshCfg);
      if (mode === 'csv-folder') { pollCsvFolder(); return; }
      if (mode === 'sc-api') { scApiService.pollOnce().catch(() => {}); return; }
      const endpoints = Object.keys(freshCfg.dataSource?.urls || {});
      for (const endpoint of endpoints) {
        if (LIVE_ENDPOINTS[endpoint]) pollEndpoint(endpoint, freshCfg).catch(() => {});
      }
    }, 150);
  }
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vmix-html-graphics', uptime: process.uptime() });
});

// ── SC API routes ──────────────────────────────────────────────────────────
// Operator panel uses these to browse the API hierarchy (event → category →
// segment) before activating a segment for live polling.

app.get('/api/sc-api/browse/event/:eventId', async (req, res) => {
  try {
    const result = await scApiService.browseEvent(req.params.eventId.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/sc-api/browse/event/:eventId/rinks', async (req, res) => {
  try {
    const result = await scApiService.browseEventRinks(req.params.eventId.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/sc-api/browse/category/:categoryId', async (req, res) => {
  try {
    const result = await scApiService.browseCategory(req.params.categoryId.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/sc-api/browse/segment/:segmentId', async (req, res) => {
  try {
    const result = await scApiService.browseSegment(req.params.segmentId.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live roster for the currently-active segment (operator panel skater picker)
app.get('/api/sc-api/roster', async (req, res) => {
  const segmentId = readConfig().dataSource?.scApi?.segmentId;
  if (!segmentId) return res.json({ ok: true, entries: [] });
  try {
    const result = await scApiService.browseSegment(segmentId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Activate a segment: saves IDs to config and (re)starts sc-api polling
app.post('/api/sc-api/select', async (req, res) => {
  const { eventId, categoryId, segmentId, segmentName, discipline, baseUrl, pollIntervalMs, officialsPollIntervalMs } = req.body || {};
  if (!segmentId) return res.status(400).json({ error: 'segmentId is required' });
  const cfg = readConfig();
  cfg.dataSource = cfg.dataSource || {};
  const prevSegmentId = cfg.dataSource.scApi?.segmentId || null;
  cfg.dataSource.mode = 'sc-api';
  cfg.dataSource.scApi = Object.assign({}, cfg.dataSource.scApi || {}, {
    baseUrl: baseUrl || 'https://sc-css-public-api-cmh9d3htgxfpdkb7.canadacentral-01.azurewebsites.net',
    eventId:                 eventId     || null,
    categoryId:              categoryId  || null,
    segmentId,
    segmentName:             segmentName || null,
    discipline:              discipline  || null,
    pollIntervalMs:          Number(pollIntervalMs)          || 2000,
    officialsPollIntervalMs: Number(officialsPollIntervalMs) || 30000,
  });
  writeConfig(cfg);

  // On-ice-driven graphics (scoring, lower-third, elements) are only rewritten
  // when a skater is on ice, so a segment change leaves the previous segment's
  // skater in those files until someone new goes on ice. Clear them so an
  // operator can't accidentally air the last segment's data.
  if (segmentId !== prevSegmentId) {
    for (const t of ['scoring', 'lower-third', 'elements']) {
      const payload = {
        meta:    { template: t, revision: Date.now(), updatedAt: new Date().toISOString() },
        control: { visible: false, state: 'hidden' },
        data:    {},
      };
      writeData(t, payload);
      graphicState[t] = { visible: false, state: 'hidden' };
      broadcast({ type: 'update', template: t, payload });
    }
  }

  startConfiguredPolling();
  // Await the initial force-poll so data is fresh before the operator UI responds.
  // This means by the time sc-api.html shows "✓ activated", the template files
  // already contain the new segment's data and a preview-wall reload is immediate.
  await Promise.allSettled([scApiService.pollOnce(), scApiService.pollOfficials()]);
  res.json({ ok: true, mode: 'sc-api', segmentId });
});

// Stop sc-api polling (operator can stop without changing mode)
app.post('/api/sc-api/stop', (_req, res) => {
  scApiService.stop();
  res.json({ ok: true, active: false });
});

// Manual trigger: refresh all sc-api data immediately (entries + officials)
app.post('/api/sc-api/refresh', async (_req, res) => {
  try {
    await Promise.all([scApiService.pollOnce(), scApiService.pollOfficials()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Skater extras (quotes + music workbooks) — load status for the operator UI
app.get('/api/skater-extras/status', (_req, res) => {
  res.json({ ok: true, ...skaterExtrasService.status() });
});

// Upload a coaches / quotes / music workbook straight from the operator's
// computer — no path typing, same pattern as /api/messages/upload. Body:
// { kind: 'music'|'quotes'|'coaches', filename, dataBase64 }.
const SKATER_EXTRAS_CONFIG_KEY = {
  music:   'musicWorkbookPath',
  quotes:  'quotesWorkbookPath',
  coaches: 'coachesWorkbookPath',
};
app.post('/api/skater-extras/upload', (req, res) => {
  try {
    const { kind, filename, dataBase64 } = req.body || {};
    const configKey = SKATER_EXTRAS_CONFIG_KEY[kind];
    if (!configKey) return res.status(400).json({ ok: false, error: 'kind must be music, quotes, or coaches' });
    if (!filename || !dataBase64) return res.status(400).json({ ok: false, error: 'filename and dataBase64 are required' });
    if (!/\.(xlsx|xls|csv)$/i.test(filename)) return res.status(400).json({ ok: false, error: 'File must be .xlsx, .xls, or .csv' });
    const safe = path.basename(filename).replace(/[^a-zA-Z0-9._ -]/g, '').trim() || `${kind}.xlsx`;
    const destDir = path.join(UPLOADS_DIR, 'skater-extras');
    ensureDir(destDir);
    const buf = Buffer.from(String(dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'File too large (max 15 MB)' });
    // Prefix with kind so music/quotes/coaches uploads never collide on name.
    const storedName = `${kind}-${safe}`;
    fs.writeFileSync(path.join(destDir, storedName), buf);
    const relPath = path.join('uploads', 'skater-extras', storedName);
    const cfg = readConfig();
    cfg.skaterExtras = Object.assign({}, cfg.skaterExtras || {}, { [configKey]: relPath });
    writeConfig(cfg);
    res.json({ ok: true, kind, filename: safe, workbookPath: relPath, ...skaterExtrasService.status() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tracks the entryId most recently pushed to the manual-skater graphic
let scApiSelectedEntryId = null;

async function applyScApiManualSkater(entryId) {
  const data = await scApiService.setManualSkaterFromEntry(entryId);
  const existing = readData('manual-skater') || {
    meta:    { template: 'manual-skater', revision: 0, updatedAt: new Date().toISOString() },
    control: { visible: false, state: 'hidden' },
    data:    {},
  };
  // Coaches + quote + program music from the event-supplied workbooks (if
  // configured). The graphic's slide-down card shows coaches, then the quote,
  // then the music for the active segment. Missing skater / missing files →
  // empty strings, card falls back to the category detail text.
  const extras = skaterExtrasService.lookup(data.name);
  existing.data = {
    line1:          data.name,
    line2:          data.club,
    name:           data.name,
    club:           data.club,
    flagUrl:        data.flagUrl,
    categoryName:   data.categoryName,
    categoryNameFr: data.categoryNameFr,
    segmentName:    data.segmentName,
    segmentNameFr:  data.segmentNameFr,
    groupNumber:    data.groupNumber,
    coaches:        extras?.coaches || '',
    quote:          extras?.quote || '',
    musicTitle:     skaterExtrasService.musicForSegment(extras, data.segmentName),
  };
  existing.meta.revision  = Date.now();
  existing.meta.updatedAt = new Date().toISOString();
  writeData('manual-skater', existing);
  graphicState['manual-skater'] = { visible: existing.control.visible, state: existing.control.state };
  broadcast({ type: 'update', template: 'manual-skater', payload: existing });
  scApiSelectedEntryId = entryId;
  // Tell open operator pages (sc-api.html) which skater is now selected so
  // StreamDeck-triggered next/prev updates the on-page highlight too.
  broadcast({ type: 'sc-api-selection', entryId, name: data.name });

  // Interview bar follows the selected skater, exactly like the manual-skater
  // bar — including live updates while it's on air. Operator overrides happen
  // via the interview panel/page (those pushes are tagged source:'manual').
  const iv = readData('interview') || {
    meta:    { template: 'interview', revision: 0, updatedAt: new Date().toISOString() },
    control: { visible: false, state: 'hidden' },
    data:    {},
  };
  iv.data = {
    line1:        data.name,
    line2:        data.club,
    name:         data.name,
    club:         data.club,
    flagUrl:      data.flagUrl,
    categoryName: data.categoryName,
    source:       'auto',
  };
  iv.meta.revision  = Date.now();
  iv.meta.updatedAt = new Date().toISOString();
  writeData('interview', iv);
  graphicState['interview'] = { visible: iv.control.visible, state: iv.control.state };
  broadcast({ type: 'update', template: 'interview', payload: iv });

  const cfg = readConfig();
  const segCode = (data.segmentName || '').replace(/.*\b(SP|FS|RD|FD|SD|PD)\b.*/i, '$1').toUpperCase();
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = [sanitizeFilename(data.name), segCode, datePart].filter(Boolean).join(' - ');
  vmixClient.setFilename(filename).catch(e => {
    const reason = e.message || e.code || 'unreachable';
    console.warn(`[sc-api] vMix setFilename failed (${reason}) — is vMix running? Check autoRecord.vmixHost/vmixPort in settings.`);
  });
  return data;
}

// Push a roster entry to the manual-skater graphic
app.post('/api/sc-api/manual-skater/:entryId', async (req, res) => {
  try {
    const data = await applyScApiManualSkater(req.params.entryId.trim());
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Advance to the next or previous non-withdrawn skater in the current roster
async function moveScApiSkater(direction) {
  const cfg = readConfig();
  const segmentId = cfg.dataSource?.scApi?.segmentId;
  if (!segmentId) throw new Error('No segment active');
  const result = await scApiService.browseSegment(segmentId);
  const active = (result.entries || []).filter(e => {
    const s = (e.status || '').toUpperCase();
    return s !== 'WITHDRAW' && s !== 'WITHDRAWN' && s !== 'WDR';
  });
  if (!active.length) throw new Error('No active skaters');
  const idx = active.findIndex(e => e.id === scApiSelectedEntryId);
  const next = idx < 0
    ? (direction > 0 ? 0 : active.length - 1)
    : Math.max(0, Math.min(active.length - 1, idx + direction));
  return applyScApiManualSkater(active[next].id);
}

// GET + POST so StreamDeck / Companion / browser can all trigger these
registerDualAsync('/api/sc-api/next-skater', async (_req, res) => {
  const data = await moveScApiSkater(1);
  res.json({ ok: true, data });
});

registerDualAsync('/api/sc-api/prev-skater', async (_req, res) => {
  const data = await moveScApiSkater(-1);
  res.json({ ok: true, data });
});

// ── Auto-record endpoints ──────────────────────────────────────────────────

app.get('/api/sc-api/recording/status', (_req, res) => {
  res.json({
    recording:       autoRecordState.recording,
    currentFilename: autoRecordState.currentFilename,
    pendingName:     autoRecordState.pendingName,
    pendingFilename: autoRecordState.pendingFilename,
    countdownActive: !!autoRecordState.countdownTimer,
  });
});

// Cancel a pending countdown without stopping an active recording
app.post('/api/sc-api/recording/cancel-countdown', (_req, res) => {
  cancelRecordingCountdown('operator');
  res.json({ ok: true });
});

// Skip the countdown and start recording immediately
app.post('/api/sc-api/recording/start-now', async (req, res) => {
  cancelRecordingCountdown('start-now');
  const filename = req.body?.filename || autoRecordState.pendingFilename || `Manual_${Date.now()}`;
  try {
    await vmixClient.startRecording(filename);
    autoRecordState.recording       = true;
    autoRecordState.currentFilename = filename;
    autoRecordState.pendingName     = null;
    autoRecordState.pendingFilename = null;
    broadcastRecordingStatus('recording-started');
    res.json({ ok: true, filename });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manually stop a running recording
app.post('/api/sc-api/recording/stop', async (_req, res) => {
  cancelRecordingCountdown('operator');
  const prev = autoRecordState.currentFilename;
  try {
    await vmixClient.stopRecording();
    autoRecordState.recording       = false;
    autoRecordState.currentFilename = null;
    broadcastRecordingStatus('recording-stopped', { stoppedFilename: prev });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  // One-time migration: the Elements graphic now defaults to the short
  // broadcast-standard "TES" / "NTÉ" labels. Configs saved before that
  // change still carry the long form. Only rewrite when the saved value
  // EXACTLY matches the old default — intentional custom values are safe.
  try {
    const cfg = readConfig();
    let migrated = false;
    if (cfg.elementsTotalLabel === 'Technical Score') {
      cfg.elementsTotalLabel = 'TES'; migrated = true;
    }
    if (cfg.elementsTotalLabelFr === 'Score technique') {
      cfg.elementsTotalLabelFr = 'NTÉ'; migrated = true;
    }
    if (migrated) {
      writeConfig(cfg);
      console.log('[migrate] elements labels updated to TES / NTÉ defaults');
    }
  } catch (err) {
    console.warn('[migrate] elements label migration skipped:', err.message);
  }
  // Refresh workbook-backed graphics only if a workbook is actually
  // configured — a fresh install has none, and that's normal, not an error.
  const startupCfg = readConfig();
  if (startupCfg.messages?.workbookPath) {
    try { messagesService.refresh(); } catch (err) { console.warn('[messages] startup refresh skipped:', err.message); }
  }
  if (startupCfg.manualSkaters?.workbookPath) {
    try { manualSkatersService.refresh(); } catch (err) { console.warn('[manual-skaters] startup refresh skipped:', err.message); }
  }
  console.log(`\nvMix graphics server → http://127.0.0.1:${PORT}`);
  console.log(`  WebSocket           → ws://127.0.0.1:${PORT}`);
  console.log(`  Graphics menu       → http://127.0.0.1:${PORT}/menu/`);
  console.log(`  Operator panel      → http://127.0.0.1:${PORT}/operator/\n`);
  TEMPLATES.forEach(t => console.log(`  /graphics/${t}/`));
  console.log('');

  // Auto-start polling if configured
  const cfg = readConfig();
  const mode = getDataSourceMode(cfg);
  if (mode === 'sc-api') startConfiguredPolling();
  else if (cfg.dataSource?.livePoll?.enabled) startConfiguredPolling();
});
