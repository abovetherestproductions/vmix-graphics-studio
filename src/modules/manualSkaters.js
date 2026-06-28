const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
// Reuse the same name normaliser the live-feed normalisers use so manual
// workbook entries get the same Title-Case treatment for all-lower / all-upper inputs.
const { safeName } = require('../../normalizers/skate-canada-json');

const DEFAULT_MANUAL_SKATERS = {
  workbookPath: 'manual skater list/skater info sheet.xlsx',
  sheetName: '',
  nameHeader: 'name',
  clubHeader: 'club',
  categoryHeader: 'category',
  flagHeader: 'flag',
  selectedIndex: 0,
};

// Flag column may contain "BC.png", "BC", or a full path like "C:\\flags\\BC.png".
// Strip any directory prefix and ensure we end up with a file the static
// /assets/flags/ route can serve (matching the rest of the codebase).
function resolveFlagUrl(flagValue) {
  const raw = String(flagValue || '').trim();
  if (!raw) return '';
  const base = raw.replace(/^.*[\\/]/, '').trim();
  if (!base) return '';
  const withExt = /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.png`;
  return `/assets/flags/${withExt}`;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAbsoluteLike(filePath) {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(String(filePath || '')) || /^\\\\/.test(String(filePath || ''));
}

function createManualSkatersService({ rootDir, readConfig, writeConfig, readData, writeData, publish }) {
  function settings() {
    return { ...DEFAULT_MANUAL_SKATERS, ...(readConfig().manualSkaters || {}) };
  }

  function saveSettings(patch = {}) {
    const cfg = readConfig();
    const next = { ...settings(), ...patch };
    cfg.manualSkaters = next;
    writeConfig(cfg);
    return next;
  }

  function workbookPath() {
    const source = settings().workbookPath || DEFAULT_MANUAL_SKATERS.workbookPath;
    return isAbsoluteLike(source) ? source : path.resolve(rootDir, source);
  }

  function readWorkbookRows() {
    const cfg = settings();
    const resolvedPath = workbookPath();
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Manual skater workbook not found: ${resolvedPath}`);
    }

    const workbook = XLSX.readFile(resolvedPath, { cellDates: false });
    const sheetName = cfg.sheetName && workbook.Sheets[cfg.sheetName] ? cfg.sheetName : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

    const requested = [cfg.nameHeader, cfg.clubHeader, cfg.categoryHeader].map(normalizeHeader);
    let headerIndex = matrix.findIndex(row => {
      const normalized = row.map(normalizeHeader);
      return requested.every(header => normalized.includes(header));
    });
    if (headerIndex < 0) headerIndex = 0;

    const headers = (matrix[headerIndex] || []).map(value => String(value || '').trim());
    const headerKeys = headers.map(normalizeHeader);

    function cell(row, requestedHeader, fallbackIndex) {
      const wanted = normalizeHeader(requestedHeader);
      const index = headerKeys.indexOf(wanted);
      const targetIndex = index >= 0 ? index : fallbackIndex;
      return String(row[targetIndex] ?? '').trim();
    }

    // Flag is optional — only pull a column if the sheet actually has one
    // matching `flagHeader`. fallbackIndex is -1 so missing column yields ''.
    const flagColumnIndex = headerKeys.indexOf(normalizeHeader(cfg.flagHeader || 'flag'));
    const rows = matrix
      .slice(headerIndex + 1)
      .map((row, offset) => ({
        index: null,
        excelRow: headerIndex + offset + 2,
        name: cell(row, cfg.nameHeader, 1),
        club: cell(row, cfg.clubHeader, 2),
        category: cell(row, cfg.categoryHeader, 3),
        flag: flagColumnIndex >= 0 ? String(row[flagColumnIndex] ?? '').trim() : '',
      }))
      .filter(row => row.name || row.club || row.category)
      .filter(row => !/^[-—]+$/.test(row.name) && !/^name$/i.test(row.name))
      .map((row, index) => ({ ...row, index }));

    return {
      workbookPath: resolvedPath,
      sheetName,
      sheetNames: workbook.SheetNames,
      headers: headers.filter(Boolean),
      headerRow: headerIndex + 1,
      rows,
    };
  }

  function selectedRow(rows, index) {
    if (!rows.length) return null;
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), rows.length - 1);
    return rows[safeIndex];
  }

  function buildPayload(row, options = {}) {
    const existing = readData('manual-skater');
    const appConfig = readConfig();
    const visible = options.visible ?? existing?.control?.visible ?? false;
    return {
      meta: { template: 'manual-skater', revision: Date.now(), updatedAt: new Date().toISOString() },
      control: { visible, state: visible ? (existing?.control?.visible ? 'animateUpdate' : 'animateIn') : 'hidden' },
      data: {
        // Normalise lower/upper-case-only entries (e.g. "christiana lock" →
        // "Christiana Lock"). Already-mixed-case input is preserved.
        line1: safeName(row?.name || ''),
        line2: safeName(row?.club || ''),
        name:  safeName(row?.name || ''),
        club:  safeName(row?.club || ''),
        category: row?.category || '',
        categoryName: row?.category || '',
        flag: row?.flag || '',
        flagUrl: resolveFlagUrl(row?.flag),
        segmentName: appConfig.segmentName || '',
        segmentNumber: appConfig.segmentNumber || '',
        source: options.source || 'workbook',
        rowIndex: row?.index ?? null,
        displayIndex: row?.index != null ? row.index + 1 : null,
        excelRow: row?.excelRow ?? null,
      },
    };
  }

  function publishPayload(payload) {
    writeData('manual-skater', payload);
    publish(payload);
    return payload;
  }

  function selectIndex(index, options = {}) {
    const workbook = readWorkbookRows();
    const row = selectedRow(workbook.rows, index);
    if (!row) throw new Error('Manual skater workbook does not contain any display rows.');
    saveSettings({ selectedIndex: row.index });
    const payloadOptions = Object.prototype.hasOwnProperty.call(options, 'visible')
      ? { visible: options.visible }
      : {};
    return {
      ok: true,
      selected: row,
      payload: publishPayload(buildPayload(row, payloadOptions)),
      workbook,
    };
  }

  function current(options = {}) {
    const workbook = readWorkbookRows();
    const row = selectedRow(workbook.rows, settings().selectedIndex);
    return {
      ok: true,
      settings: settings(),
      selected: row,
      payload: options.write && row ? publishPayload(buildPayload(row, { visible: options.visible ?? false })) : readData('manual-skater'),
      workbook,
    };
  }

  function move(delta) {
    const workbook = readWorkbookRows();
    if (!workbook.rows.length) throw new Error('Manual skater workbook does not contain any display rows.');
    const currentIndex = Math.min(Math.max(Number(settings().selectedIndex) || 0, 0), workbook.rows.length - 1);
    return selectIndex(Math.min(Math.max(currentIndex + delta, 0), workbook.rows.length - 1), { visible: true });
  }

  function show() {
    const existing = readData('manual-skater');
    if (existing?.data?.source === 'manual') {
      existing.control.visible = true;
      existing.control.state = 'animateIn';
      existing.meta.revision = Date.now();
      existing.meta.updatedAt = new Date().toISOString();
      return { ok: true, payload: publishPayload(existing) };
    }
    return selectIndex(settings().selectedIndex, { visible: true });
  }

  function hide() {
    const existing = readData('manual-skater') || buildPayload(null, { visible: false });
    existing.control.visible = false;
    existing.control.state = 'animateOut';
    existing.meta.revision = Date.now();
    existing.meta.updatedAt = new Date().toISOString();
    return { ok: true, payload: publishPayload(existing) };
  }

  function manual(body = {}) {
    const row = {
      index: null,
      excelRow: null,
      name: body.name || body.line1 || '',
      club: body.club || body.line2 || '',
      category: body.category || '',
      flag: body.flag || '',
    };
    return { ok: true, payload: publishPayload(buildPayload(row, { visible: body.visible !== false, source: 'manual' })) };
  }

  function returnToList() {
    return selectIndex(settings().selectedIndex, { visible: true });
  }

  function refresh() {
    return selectIndex(settings().selectedIndex, { visible: readData('manual-skater')?.control?.visible ?? false });
  }

  return {
    settings,
    saveSettings,
    readWorkbookRows,
    current,
    selectIndex,
    move,
    show,
    hide,
    manual,
    returnToList,
    refresh,
  };
}

module.exports = { createManualSkatersService };
