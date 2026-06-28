'use strict';

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const sc = require('./skate-canada-json');

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRecord(record) {
  return Object.fromEntries(
    Object.entries(record || {}).map(([key, value]) => [normalizeKey(key), value == null ? '' : String(value).trim()])
  );
}

function isEffectivelyEmpty(record) {
  if (!record) return true;
  return Object.values(record).every(value => String(value || '').trim() === '');
}

function readCsv(filePath, { keepSeparators = false } = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, {
    columns: headers => headers.map(normalizeKey),
    skip_empty_lines: !keepSeparators,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  const normalized = records.map(normalizeRecord);
  return keepSeparators ? normalized : normalized.filter(record => !isEffectivelyEmpty(record));
}

function readFirstRow(filePath) {
  return readCsv(filePath)[0] || null;
}

function col(row, ...aliases) {
  for (const alias of aliases) {
    const key = normalizeKey(alias);
    if (row && row[key] != null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

function safeNum(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function revisionNow() {
  return Date.now();
}

const KNOWN_SEGMENT_NAMES = [
  'Short Program',
  'Free Program',
  'Free Skate',
  'Free Skating',
  'Rhythm Dance',
  'Free Dance',
  'Short Dance',
  'Original Dance',
  'Pattern Dance',
  'Interpretive',
  'Artistic',
  'Creative',
];

function splitCategoryAndSegment(value) {
  const text = String(value || '').trim();
  if (!text) return { categoryName: '', segmentName: '' };

  const dashParts = text
    .split(/\s+[-–—]\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (dashParts.length >= 2) {
    return {
      categoryName: dashParts.slice(0, -1).join(' - '),
      segmentName: dashParts[dashParts.length - 1],
    };
  }

  const segment = KNOWN_SEGMENT_NAMES
    .slice()
    .sort((a, b) => b.length - a.length)
    .find(name => new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i').test(text));

  if (segment) {
    return {
      categoryName: text.replace(new RegExp(`\\s*${segment.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i'), '').trim(),
      segmentName: segment,
    };
  }

  return { categoryName: '', segmentName: text };
}

function splitBilingual(value) {
  const parts = String(value || '')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean);

  return {
    en: parts[0] || '',
    fr: parts[1] || '',
  };
}

function buildContext(context = {}) {
  return {
    categoryName: context.categoryName || '',
    categoryNameFr: context.categoryNameFr || '',
    segmentName: context.segmentName || '',
    segmentNameFr: context.segmentNameFr || '',
    eventName: context.eventName || '',
    eventNameFr: context.eventNameFr || '',
    eventLocation: context.eventLocation || '',
    eventLocationFr: context.eventLocationFr || '',
    eventDate: context.eventDate || '',
    eventDateFr: context.eventDateFr || '',
  };
}

function flagPath(value) {
  const file = String(value || '').trim();
  if (!file || /unknown/i.test(file)) return null;
  return sc.flagUrl(file);
}

function applyContextToPayload(payload, context = {}, titleMode = 'category') {
  if (!payload || !payload.data) return payload;

  const ctx = buildContext(context);
  const data = payload.data;

  if (ctx.categoryName && !data.categoryName) data.categoryName = ctx.categoryName;
  if (ctx.categoryNameFr && !data.categoryNameFr) data.categoryNameFr = ctx.categoryNameFr;
  if (ctx.segmentName && !data.segmentName) data.segmentName = ctx.segmentName;
  if (ctx.segmentNameFr && !data.segmentNameFr) data.segmentNameFr = ctx.segmentNameFr;

  if (titleMode === 'segment' && (ctx.segmentName || ctx.segmentNameFr)) {
    data.titleEn = ctx.segmentName || data.titleEn || data.title || 'Starting Order';
    data.titleFr = ctx.segmentNameFr || data.titleFr || data.titleEn;
    data.title = data.titleEn;
  } else if (titleMode === 'category' && (ctx.categoryName || ctx.categoryNameFr)) {
    data.titleEn = ctx.categoryName || data.titleEn || data.title || 'Rankings';
    data.titleFr = ctx.categoryNameFr || data.titleFr || data.titleEn;
    data.title = data.titleEn;
  }

  return payload;
}

function isWithdrawnStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  return s === 'WITHDREW' || s === 'WITHDRAW' || s === 'WD' || s === 'NOENTRY' || s === 'NO ENTRY';
}

function isCompletedStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  return s === 'COMPETED' || s === 'SCORED';
}

function cleanRole(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return `Judge ${raw}`;
  return raw;
}

function splitIntoGroups(records, hasContent) {
  const groups = [];
  let current = [];

  for (const record of records) {
    if (hasContent(record)) {
      current.push(record);
      continue;
    }
    if (current.length) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length) groups.push(current);
  return groups;
}

function sameRankingGroup(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((row, idx) =>
    String(row.rank ?? '') === String(b[idx].rank ?? '') &&
    String(row.name ?? '') === String(b[idx].name ?? '') &&
    String(row.total ?? '') === String(b[idx].total ?? '')
  );
}

function buildStartOrderGroups(filePath) {
  const records = readCsv(filePath, { keepSeparators: true });
  const groups = splitIntoGroups(
    records,
    row => !!col(row, 'position', 'start', 'startnumber', '#') && !!col(row, 'skater', 'name', 'fullname')
  );

  return groups
    .map(group => group.filter(row => !col(row, 'noentry')).filter(row => !isWithdrawnStatus(col(row, 'status'))))
    .filter(group => group.length > 0)
    .map(group => group.map(row => ({
      position: safeNum(col(row, 'position', 'start', 'startnumber', '#')),
      name: col(row, 'skater', 'name', 'fullname'),
      club: col(row, 'club', 'clubname'),
      section: col(row, 'section', 'province', 'region'),
      flagUrl: flagPath(col(row, 'flag', 'flagfile')),
      status: col(row, 'status').toUpperCase() || null,
    })));
}

function startingOrderPayloadFromGroups(groups, options = {}) {
  const {
    groupNumber = null,
    context = {},
  } = options;

  const selectedGroup = Number(groupNumber) > 0
    ? Math.min(Number(groupNumber), groups.length || 1)
    : Math.max(1, groups.findIndex(group => group.some(row => !isCompletedStatus(row.status))) + 1 || 1);
  const rows = groups[selectedGroup - 1] || [];

  const ctx = buildContext(context);
  return applyContextToPayload({
    meta: { template: 'starting-order', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 700 },
    data: {
      title: ctx.segmentName || 'Starting Order',
      titleEn: ctx.segmentName || 'Starting Order',
      titleFr: ctx.segmentNameFr || ctx.segmentName || 'Ordre de depart',
      segmentName: ctx.segmentName,
      segmentNameFr: ctx.segmentNameFr,
      categoryName: ctx.categoryName,
      categoryNameFr: ctx.categoryNameFr,
      subtitle: '',
      groupNumber: selectedGroup,
      groupCount: groups.length,
      availableGroups: groups.map((_, idx) => idx + 1),
      rowCount: rows.length,
      rows,
    },
  }, ctx, 'segment');
}

function buildRankingEntries(filePath, context = {}) {
  const rows = readCsv(filePath);
  const deduped = new Map();

  for (const row of rows) {
    const name = col(row, 'skater', 'name', 'fullname');
    const rank = safeNum(col(row, 'position', 'rank', 'place', 'catrank'));
    if (!name || rank == null) continue;

    const entry = {
      Position: rank,
      Rank: rank,
      CatRank: rank,
      Skater: name,
      CatScore: col(row, 'catscore', 'total', 'score', 'points'),
      SegScore: col(row, 'segscore'),
      Section: col(row, 'section', 'province', 'region'),
      Club: col(row, 'club', 'clubname'),
      Flag: col(row, 'flag', 'flagfile'),
      CurrentSkater: /red/i.test(col(row, 'currentskater')) ? '#E4002B' : '',
      CategoryName: context.categoryName || col(row, 'categoryname') || '',
      CategoryNameFr: context.categoryNameFr || '',
      SegmentName: context.segmentName || '',
      SegmentNameFr: context.segmentNameFr || '',
    };

    const dedupeKey = `${rank}:${name}`;
    const existing = deduped.get(dedupeKey);
    if (existing) {
      existing.CurrentSkater = existing.CurrentSkater || entry.CurrentSkater;
      existing.Flag = existing.Flag || entry.Flag;
      existing.Section = existing.Section || entry.Section;
      existing.Club = existing.Club || entry.Club;
      existing.CatScore = existing.CatScore || entry.CatScore;
      continue;
    }

    deduped.set(dedupeKey, entry);
  }

  return [...deduped.values()].sort((a, b) => (a.Position ?? 999) - (b.Position ?? 999));
}

function buildRankingGroups(filePath) {
  const records = readCsv(filePath, { keepSeparators: true });
  const groups = splitIntoGroups(
    records,
    row => !!col(row, 'position', 'rank', 'place', 'catrank') && !!col(row, 'skater', 'name', 'fullname')
  );

  const normalized = groups.map(group => group.map(row => ({
    rank: safeNum(col(row, 'position', 'rank', 'place', 'catrank')),
    name: col(row, 'skater', 'name', 'fullname'),
    club: col(row, 'club', 'clubname'),
    section: col(row, 'section', 'province', 'region'),
    flagUrl: flagPath(col(row, 'flag', 'flagfile')),
    total: safeNum(col(row, 'catscore', 'total', 'score', 'points')),
    onIce: /red/i.test(col(row, 'currentskater')),
  }))).filter(group => group.length > 0);

  const deduped = [];
  for (const group of normalized) {
    if (deduped.length && sameRankingGroup(deduped[deduped.length - 1], group)) continue;
    deduped.push(group);
  }
  return deduped;
}

function csvToEventInfo(filePath) {
  const row = readFirstRow(filePath);
  if (!row) return null;

  const category = splitBilingual(col(row, 'category'));
  const segment = splitBilingual(col(row, 'segment'));
  const eventName = col(row, 'eventname');
  const eventLocation = col(row, 'eventlocation');
  const eventDate = col(row, 'eventdate');

  return {
    eventName,
    eventNameFr: col(row, 'freventname') || eventName,
    eventLocation,
    eventLocationFr: col(row, 'freventlocation') || eventLocation,
    eventDate,
    eventDateFr: col(row, 'freventdate') || eventDate,
    logoPath: col(row, 'eventlogopath') || null,
    categoryName: category.en,
    categoryNameFr: category.fr,
    segmentName: segment.en,
    segmentNameFr: segment.fr,
    eventSubtitle: [category.en, segment.en].filter(Boolean).join(' — '),
  };
}

function csvToStartingOrder(filePath, options = {}) {
  const groups = buildStartOrderGroups(filePath);
  return startingOrderPayloadFromGroups(groups, options);
}

function csvToOfficials(filePath, options = {}) {
  const { context = {}, lang = 'en' } = options;
  const raw = readCsv(filePath)
    .filter(row => {
      const name = col(row, 'judgename', 'name', 'official');
      return !!name;
    })
    .map(row => ({
      Position: cleanRole(col(row, 'judgeno', 'position', 'role', 'function', 'title')),
      PositionFr: cleanRole(col(row, 'judgeno', 'positionfr', 'rolefr', 'functionfr')),
      JudgeName: col(row, 'judgename', 'name', 'official'),
      Section: col(row, 'section', 'province', 'region'),
      Flag: flagPath(col(row, 'flag', 'flagfile')) ? col(row, 'flag', 'flagfile') : '',
    }));

  return sc.normalizeOfficials(raw, lang, {
    categoryEn: context.categoryName,
    categoryFr: context.categoryNameFr,
    segmentEn: context.segmentName,
    segmentFr: context.segmentNameFr,
  });
}

function csvToStandings(filePath, options = {}) {
  const { context = {}, lang = 'en' } = options;
  const raw = buildRankingEntries(filePath, context);
  return applyContextToPayload(sc.normalizeRank6(raw, lang), context, 'category');
}

function csvToRankings(filePath, options = {}) {
  const {
    context = {},
    page = 1,
  } = options;
  const rankingGroups = buildRankingGroups(filePath);
  const pageCount = Math.max(1, rankingGroups.length);
  const safePage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const rows = rankingGroups[safePage - 1] || [];
  const titleEn = context.categoryName || 'Final Rankings';
  const titleFr = context.categoryNameFr || titleEn;

  return {
    meta: { template: 'rankings', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 700 },
    data: {
      title: titleEn,
      titleEn,
      titleFr,
      categoryName: context.categoryName || '',
      categoryNameFr: context.categoryNameFr || '',
      segmentName: context.segmentName || '',
      segmentNameFr: context.segmentNameFr || '',
      subtitle: '',
      page: safePage,
      pageCount,
      rowsPerPage: rows.length,
      rowCount: rows.length,
      rows,
      groupedPages: rankingGroups,
      groupedPageMode: true,
    },
  };
}

function csvToScoring(filePath, options = {}) {
  const { currentSkaterPath = null, context = {}, lang = 'en' } = options;
  const scoreRow = readFirstRow(filePath) || {};
  const currentRow = currentSkaterPath ? (readFirstRow(currentSkaterPath) || {}) : {};
  const parsedCurrentSegment = splitCategoryAndSegment(col(currentRow, 'segmentname'));
  const parsedScoreSegment = splitCategoryAndSegment(col(scoreRow, 'segmentname'));

  const merged = {
    SegmentName: context.segmentName || parsedCurrentSegment.segmentName || parsedScoreSegment.segmentName || col(currentRow, 'segmentname') || col(scoreRow, 'segmentname') || '',
    SegmentNameFr: context.segmentNameFr || '',
    CategoryName: context.categoryName || parsedCurrentSegment.categoryName || parsedScoreSegment.categoryName || '',
    CategoryNameFr: context.categoryNameFr || '',
    Group: col(scoreRow, 'group', 'groupnumber', 'groupno') || col(currentRow, 'group', 'groupnumber', 'groupno') || '',
    Flag: col(currentRow, 'flag') || col(scoreRow, 'flag'),
    Skater: col(currentRow, 'skater') || col(scoreRow, 'skater'),
    PCScore: col(scoreRow, 'pcscore') || col(currentRow, 'pcscore') || 0,
    TEScore: col(scoreRow, 'tescore') || col(currentRow, 'tescore') || 0,
    SegScore: col(scoreRow, 'segscore') || col(currentRow, 'segscore') || 0,
    SegRank: col(scoreRow, 'segrank') || col(currentRow, 'segrank') || null,
    CatScore: col(scoreRow, 'catscore') || col(currentRow, 'catscore') || 0,
    CatRank: col(scoreRow, 'catrank') || col(currentRow, 'catrank') || null,
    Section: col(currentRow, 'section') || col(scoreRow, 'section'),
    Club: col(currentRow, 'club') || col(scoreRow, 'club'),
    Bonuses: col(scoreRow, 'bonuses') || 0,
    Deductions: col(scoreRow, 'deductions') || 0,
  };

  return sc.normalizeScoring(merged, lang);
}

const liveElementHistory = {
  key: '',
  elements: [],
};

function currentSkaterHistoryKey(currentRow = {}, scoringRow = {}) {
  const skater = col(currentRow, 'skater');
  const segment = col(currentRow, 'segmentname');
  const club = col(currentRow, 'club');
  const section = col(currentRow, 'section');

  if (skater || segment || club || section) {
    return ['current', skater, segment, club, section].join('|');
  }

  return [
    'fallback',
    col(scoringRow, 'skater'),
    col(scoringRow, 'segmentname'),
    col(scoringRow, 'club'),
    col(scoringRow, 'section'),
  ].join('|');
}

function resetLiveElementHistory(key) {
  liveElementHistory.key = key;
  liveElementHistory.elements = [];
}

// Merge one just-scored element into the per-skater history and return the full
// raw element list (with OnIce on the most recent one only). Shared by both the
// CSV (single-row) and live-JSON paths — the feed reports one element at a time,
// so we accumulate: clear on a new skater, update in place while an element's
// GOE is still settling (same identity), otherwise append it as the next one.
function pushLiveElement(skaterKey, identity, rawElement) {
  if (liveElementHistory.key !== skaterKey) resetLiveElementHistory(skaterKey);
  const last = liveElementHistory.elements[liveElementHistory.elements.length - 1];
  if (last?.identity === identity) {
    last.raw = rawElement;
  } else {
    if (last) last.raw.OnIce = false;
    liveElementHistory.elements.push({ identity, raw: rawElement });
  }
  return liveElementHistory.elements.map((entry, index) => ({
    ...entry.raw,
    OnIce: index === liveElementHistory.elements.length - 1,
  }));
}

function elementIdentity(row = {}) {
  return [
    col(row, 'element'),
    col(row, 'base'),
    col(row, 'elementstring', 'elementstringen', 'name'),
  ].join('|');
}

function buildRawElement(row, skaterName, onIce) {
  return {
    Element: col(row, 'element'),
    SkaterID: skaterName || col(row, 'skaterid'),
    Base: col(row, 'base'),
    GOE: col(row, 'goe'),
    Score: col(row, 'score'),
    TES: col(row, 'tes'),
    ElementString: col(row, 'elementstring', 'elementstringen', 'name'),
    OnIce: onIce,
  };
}

function csvToElements(filePath, options = {}) {
  const { scoringPath = null, currentSkaterPath = null } = options;
  const rows = readCsv(filePath);
  const scoringRow = scoringPath ? (readFirstRow(scoringPath) || {}) : {};
  const currentRow = currentSkaterPath ? (readFirstRow(currentSkaterPath) || {}) : {};
  const skaterName = col(currentRow, 'skater') || col(scoringRow, 'skater');
  const skaterKey = currentSkaterHistoryKey(currentRow, scoringRow);

  const elementRows = rows.filter(row => col(row, 'element'));
  if (!elementRows.length) {
    resetLiveElementHistory(skaterKey);
    return sc.normalizeLiveElements([]);
  }

  if (elementRows.length > 1) {
    liveElementHistory.key = skaterKey;
    liveElementHistory.elements = elementRows.map((row, index) => ({
      identity: elementIdentity(row),
      raw: buildRawElement(row, skaterName, index === elementRows.length - 1),
    }));
    return sc.normalizeLiveElements(liveElementHistory.elements.map(entry => entry.raw));
  }

  const row = elementRows[0];
  const raw = pushLiveElement(skaterKey, elementIdentity(row), buildRawElement(row, skaterName, true));
  return sc.normalizeLiveElements(raw);
}

// Live-JSON element identity — mirrors elementIdentity() (element | base |
// element name) so the same physical element settles in place rather than
// duplicating while its GOE updates.
function jsonElementIdentity(e = {}) {
  return [
    e.Element || '',
    e.Base ?? '',
    e.ElementString || e.ElementStringEn || e.ElementName || e.Name || '',
  ].join('|');
}

function jsonSkaterKey(entries) {
  const id = entries.find(e => e && e.SkaterID != null)?.SkaterID;
  // No SkaterID in this batch → keep the current key (don't reset mid-skater).
  return id != null ? `json|${String(id).trim()}` : liveElementHistory.key;
}

// Live-JSON entrypoint. The JSON feed (liveElementTracker.php) sends one element
// at a time, exactly like the single-row CSV case, so it shares the SAME
// per-skater history — identical building-list + clear-on-new-skater behaviour.
// `context` carries category/segment through for the Highest TES bucketing.
function jsonToElements(rawEntries, context = {}) {
  const entries = Array.isArray(rawEntries) ? rawEntries : (rawEntries ? [rawEntries] : []);
  const elementEntries = entries.filter(e => e && String(e.Element || '').trim());
  const skaterKey = jsonSkaterKey(entries);

  // Nothing on the ice — clear if the skater changed, else keep the list as-is
  // so the panel doesn't blank between elements.
  if (!elementEntries.length) {
    if (liveElementHistory.key !== skaterKey) resetLiveElementHistory(skaterKey);
    const raw = liveElementHistory.elements.map((entry, index) => ({
      ...entry.raw,
      OnIce: index === liveElementHistory.elements.length - 1,
    }));
    return sc.normalizeLiveElements(raw, context);
  }

  // If the feed ever returns the whole list at once, rebuild straight from it.
  if (elementEntries.length > 1) {
    resetLiveElementHistory(skaterKey);
    liveElementHistory.elements = elementEntries.map((e, index) => ({
      identity: jsonElementIdentity(e),
      raw: { ...e, OnIce: index === elementEntries.length - 1 },
    }));
    return sc.normalizeLiveElements(liveElementHistory.elements.map(en => en.raw), context);
  }

  const e = elementEntries[0];
  const raw = pushLiveElement(skaterKey, jsonElementIdentity(e), { ...e });
  return sc.normalizeLiveElements(raw, context);
}

module.exports = {
  csvToEventInfo,
  csvToStartingOrder,
  buildStartOrderGroups,
  startingOrderPayloadFromGroups,
  csvToOfficials,
  csvToStandings,
  csvToRankings,
  csvToScoring,
  csvToElements,
  jsonToElements,
  readCsv,
  readFirstRow,
};
