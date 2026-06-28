const fs = require('fs');
const path = require('path');

const EMPTY_STATE = {
  currentEvent: '',
  currentCategory: '',
  currentSegment: '',
  segmentNumber: '',
  currentSkater: {
    startOrder: null,
    skaterName: '',
    club: '',
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSkater(skater = {}) {
  return {
    startOrder: skater.startOrder ?? skater.position ?? null,
    skaterName: skater.skaterName || skater.name || '',
    club: skater.club || '',
  };
}

function createStateService(rootDir, paths = {}) {
  const statePath = path.join(rootDir, 'config', 'current-state.json');
  const eventConfigPath = paths.eventConfigPath || path.join(rootDir, 'public', 'data', 'event-config.json');
  const startingOrderPath = paths.startingOrderPath || path.join(rootDir, 'public', 'data', 'starting-order.json');
  const scoringPath = paths.scoringPath || path.join(rootDir, 'public', 'data', 'scoring.json');
  const manualSkaterPath = paths.manualSkaterPath || path.join(rootDir, 'public', 'data', 'manual-skater.json');
  const settingsPath = paths.settingsPath || path.join(rootDir, 'config', 'settings.json');

  function readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function deriveState() {
    const cfg = readJson(eventConfigPath) || {};
    const settings = readJson(settingsPath) || {};
    const scoringPayload = readJson(scoringPath) || {};
    const manualPayload = readJson(manualSkaterPath) || {};
    const scoring = scoringPayload.data || {};
    const manual = manualPayload.data || {};
    const scoringRevision = Number(scoringPayload.meta?.revision) || 0;
    const manualRevision = Number(manualPayload.meta?.revision) || 0;
    const hasScoringSkater = !!(scoring.name || scoring.club || scoring.startOrder);
    const hasManualSkater = !!(manual.name || manual.line1 || manual.club || manual.line2 || manual.category);
    const metadataSource = settings.localRecordingSorter?.metadataSource || 'auto';
    const forceManual = metadataSource === 'manual-skater';
    const forceScoring = metadataSource === 'scoring';
    const useManualSkater = hasManualSkater && (
      forceManual || (!forceScoring && !hasScoringSkater)
    );
    const derived = clone(EMPTY_STATE);
    derived.currentEvent = cfg.eventName || '';
    derived.currentCategory = cfg.categoryName || scoring.categoryName || '';
    derived.currentSegment = cfg.segmentName || scoring.segmentName || '';
    derived.currentSkaterSource = 'none';
    derived.recordingMetadataSource = metadataSource;
    if (useManualSkater) {
      derived.currentCategory = manual.category || derived.currentCategory;
      derived.currentSkater = normalizeSkater({
        startOrder: manual.startOrder ?? manual.displayIndex ?? (manual.rowIndex != null ? Number(manual.rowIndex) + 1 : null),
        skaterName: manual.name || manual.line1 || '',
        club: manual.club || manual.line2 || '',
      });
      derived.currentSkaterSource = 'manual-skater';
    } else if (hasScoringSkater) {
      derived.currentSkater = normalizeSkater(scoring);
      derived.currentSkaterSource = 'scoring';
    }
    return derived;
  }

  function readState() {
    const stored = readJson(statePath) || {};
    const derived = deriveState();
    const storedSkater = stored.currentSkater || {};
    const preferDerivedSkater = ['manual-skater', 'scoring'].includes(derived.currentSkaterSource);
    return {
      ...derived,
      ...stored,
      currentEvent: preferDerivedSkater ? (derived.currentEvent || stored.currentEvent) : (stored.currentEvent || derived.currentEvent),
      currentCategory: preferDerivedSkater ? derived.currentCategory : (stored.currentCategory || derived.currentCategory),
      currentSegment: preferDerivedSkater ? (derived.currentSegment || stored.currentSegment) : (stored.currentSegment || derived.currentSegment),
      segmentNumber: preferDerivedSkater ? (derived.segmentNumber || stored.segmentNumber) : (stored.segmentNumber || derived.segmentNumber),
      currentSkater: {
        startOrder: preferDerivedSkater ? derived.currentSkater.startOrder : (storedSkater.startOrder ?? derived.currentSkater.startOrder),
        skaterName: preferDerivedSkater ? derived.currentSkater.skaterName : (storedSkater.skaterName || derived.currentSkater.skaterName),
        club: preferDerivedSkater ? derived.currentSkater.club : (storedSkater.club || derived.currentSkater.club),
      },
      currentSkaterSource: preferDerivedSkater ? derived.currentSkaterSource : (stored.currentSkaterSource || derived.currentSkaterSource),
      recordingMetadataSource: derived.recordingMetadataSource,
    };
  }

  function writeState(nextState) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
    return nextState;
  }

  function updateState(patch = {}) {
    const current = readState();
    const next = {
      ...current,
      ...patch,
      currentSkater: patch.currentSkater
        ? { ...current.currentSkater, ...normalizeSkater(patch.currentSkater) }
        : current.currentSkater,
    };
    return writeState(next);
  }

  function setCurrentCategory(body = {}) {
    return updateState({
      currentEvent: body.currentEvent ?? body.eventName ?? readState().currentEvent,
      currentCategory: body.currentCategory ?? body.categoryName ?? readState().currentCategory,
      currentSegment: body.currentSegment ?? body.segmentName ?? readState().currentSegment,
      segmentNumber: body.segmentNumber ?? readState().segmentNumber,
    });
  }

  function setCurrentSkater(body = {}) {
    return updateState({ currentSkater: normalizeSkater(body.currentSkater || body) });
  }

  function getStartingOrderRows() {
    const rows = readJson(startingOrderPath)?.data?.rows;
    return Array.isArray(rows) ? rows : [];
  }

  function moveSkater(direction) {
    const rows = getStartingOrderRows();
    if (!rows.length) return { state: readState(), moved: false, message: 'No starting-order rows are loaded.' };
    const state = readState();
    const currentOrder = Number(state.currentSkater?.startOrder);
    let idx = rows.findIndex(row => Number(row.position) === currentOrder);
    if (idx < 0) idx = direction > 0 ? -1 : rows.length;
    const nextIdx = Math.min(Math.max(idx + direction, 0), rows.length - 1);
    const row = rows[nextIdx];
    const nextState = setCurrentSkater({
      startOrder: row.position,
      skaterName: row.name,
      club: row.club,
    });
    return { state: nextState, moved: nextIdx !== idx, message: direction > 0 ? 'Next skater selected.' : 'Previous skater selected.' };
  }

  function snapshot() {
    const state = readState();
    return {
      eventName: state.currentEvent || '',
      categoryName: state.currentCategory || '',
      segmentName: state.currentSegment || '',
      segmentNumber: state.segmentNumber || '',
      startOrder: state.currentSkater?.startOrder ?? null,
      skaterName: state.currentSkater?.skaterName || '',
      club: state.currentSkater?.club || '',
      metadataSource: state.recordingMetadataSource || 'auto',
      skaterSource: state.currentSkaterSource || 'none',
    };
  }

  return {
    statePath,
    readState,
    writeState,
    updateState,
    setCurrentCategory,
    setCurrentSkater,
    nextSkater: () => moveSkater(1),
    previousSkater: () => moveSkater(-1),
    snapshot,
  };
}

module.exports = { createStateService, EMPTY_STATE };
