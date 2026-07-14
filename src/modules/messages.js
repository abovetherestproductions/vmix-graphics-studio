const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_MESSAGES = {
  workbookPath: 'Rink 1 Messages.xlsx',
  sheetName: '',
  topHeader: 'top',
  bottomHeader: 'bottom',
  selectedIndex: 0,
};

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAbsoluteLike(filePath) {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(String(filePath || '')) || /^\\\\/.test(String(filePath || ''));
}

function createMessagesService({ rootDir, readConfig, writeConfig, readData, writeData, publish }) {
  function settings() {
    return { ...DEFAULT_MESSAGES, ...(readConfig().messages || {}) };
  }

  function saveSettings(patch = {}) {
    const cfg = readConfig();
    const next = { ...settings(), ...patch };
    cfg.messages = next;
    writeConfig(cfg);
    return next;
  }

  function workbookPath() {
    const source = settings().workbookPath || DEFAULT_MESSAGES.workbookPath;
    return isAbsoluteLike(source) ? source : path.resolve(rootDir, source);
  }

  function readWorkbookRows() {
    const cfg = settings();
    const resolvedPath = workbookPath();
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Messages workbook not found: ${resolvedPath}`);
    }

    const workbook = XLSX.readFile(resolvedPath, { cellDates: false });
    const sheetName = cfg.sheetName && workbook.Sheets[cfg.sheetName] ? cfg.sheetName : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headers = (matrix[0] || []).map(value => String(value || '').trim()).filter(Boolean);
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

    function findValue(row, requestedHeader, fallbackIndex) {
      const wanted = normalizeHeader(requestedHeader);
      const key = Object.keys(row).find(candidate => normalizeHeader(candidate) === wanted);
      if (key) return String(row[key] ?? '').trim();
      const fallbackKey = headers[fallbackIndex];
      return fallbackKey ? String(row[fallbackKey] ?? '').trim() : '';
    }

    const rows = rawRows
      .map((row, rawIndex) => ({
        excelRow: Number(row.__rowNum__) ? Number(row.__rowNum__) + 1 : rawIndex + 2,
        top: findValue(row, cfg.topHeader, 0),
        bottom: findValue(row, cfg.bottomHeader, 1),
      }))
      .filter(row => row.top || row.bottom)
      // index must reflect position in THIS filtered array — selectedRow()
      // below does rows[index], so assigning index before the filter (as
      // this used to) drifts by one for every blank/spacer row skipped,
      // landing clicks on the wrong row the further down the list you go.
      .map((row, index) => ({ ...row, index }));

    return {
      workbookPath: resolvedPath,
      sheetName,
      sheetNames: workbook.SheetNames,
      headers,
      rows,
    };
  }

  function selectedRow(rows, index) {
    if (!rows.length) return null;
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), rows.length - 1);
    return rows[safeIndex];
  }

  function buildPayload(row, options = {}) {
    const existing = readData('messages');
    const visible = options.visible ?? existing?.control?.visible ?? false;
    return {
      meta: { template: 'messages', revision: Date.now(), updatedAt: new Date().toISOString() },
      control: { visible, state: visible ? (existing?.control?.visible ? 'animateUpdate' : 'animateIn') : 'hidden' },
      data: {
        line1: row?.top || '',
        line2: row?.bottom || '',
        source: options.source || 'workbook',
        rowIndex: row?.index ?? null,
        displayIndex: row?.index != null ? row.index + 1 : null,
        excelRow: row?.excelRow ?? null,
      },
    };
  }

  function publishPayload(payload) {
    writeData('messages', payload);
    publish(payload);
    return payload;
  }

  function selectIndex(index, options = {}) {
    const workbook = readWorkbookRows();
    const row = selectedRow(workbook.rows, index);
    if (!row) throw new Error('Messages workbook does not contain any display rows.');
    saveSettings({ selectedIndex: row.index });
    return {
      ok: true,
      selected: row,
      payload: publishPayload(buildPayload(row, { visible: options.visible ?? true })),
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
      payload: options.write && row ? publishPayload(buildPayload(row, { visible: options.visible ?? false })) : readData('messages'),
      workbook,
    };
  }

  function move(delta) {
    const workbook = readWorkbookRows();
    if (!workbook.rows.length) throw new Error('Messages workbook does not contain any display rows.');
    const currentIndex = Math.min(Math.max(Number(settings().selectedIndex) || 0, 0), workbook.rows.length - 1);
    return selectIndex(Math.min(Math.max(currentIndex + delta, 0), workbook.rows.length - 1), { visible: true });
  }

  function show() {
    const existing = readData('messages');
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
    const existing = readData('messages') || buildPayload(null, { visible: false });
    existing.control.visible = false;
    existing.control.state = 'animateOut';
    existing.meta.revision = Date.now();
    existing.meta.updatedAt = new Date().toISOString();
    return { ok: true, payload: publishPayload(existing) };
  }

  function manual(body = {}) {
    const row = { index: null, excelRow: null, top: body.top || body.line1 || '', bottom: body.bottom || body.line2 || '' };
    return { ok: true, payload: publishPayload(buildPayload(row, { visible: body.visible !== false, source: 'manual' })) };
  }

  function returnToList() {
    return selectIndex(settings().selectedIndex, { visible: true });
  }

  function refresh() {
    return selectIndex(settings().selectedIndex, { visible: readData('messages')?.control?.visible ?? false });
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

module.exports = { createMessagesService };
