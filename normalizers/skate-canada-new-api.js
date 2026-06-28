'use strict';

/**
 * Skate Canada Public REST API normalizer.
 *
 * Maps the new REST API DTOs to the same payload shapes consumed by the
 * existing graphic templates. The new API is a proper hierarchical REST
 * service (Event → Category → Segment → Entries) that replaces the old
 * PHP live-stream endpoints.
 *
 * API base: https://sc-css-public-api-staging-hdf5ape6agh8gnea.canadacentral-01.azurewebsites.net
 * All IDs are GUIDs. Read-only GET endpoints. Bilingual fields: EN + FrenchName suffix.
 *
 * Key field mappings:
 *   competitorSection → section / flag URL
 *   sortOrder         → position in start order
 *   warmUpGroup       → group number
 *   onice: true       → currently performing (≡ old currentSkater.php)
 *   segmentRank       → rank in segment
 *   categoryRank      → cumulative rank across segments
 */

// ── French translation table ───────────────────────────────────────────────
const SEGMENT_FR = {
  'Short Program':           'Programme court',
  'Free Program':            'Programme libre',
  'Free Skate':              'Programme libre',
  'Free Skating':            'Programme libre',
  'Rhythm Dance':            'Danse rythmique',
  'Free Dance':              'Danse libre',
  'Short Dance':             'Danse courte',
  'Original Dance':          'Danse originale',
  'Pairs Short Program':     'Programme court en couple',
  'Pairs Free Program':      'Programme libre en couple',
  'Pairs Short':             'Programme court en couple',
  'Pairs Free':              'Programme libre en couple',
  'Pattern Dance':           'Danse imposée',
  'Interpretive':            'Programme d’interprétation',
  'Artistic':                'Artistique',
  'Creative':                'Créatif',
  'Solo Dance':              'Danse en solo',
  'Starting Order':          'Ordre de départ',
  'Final Rankings':          'Classement final',
  'Officials Panel':         'Officiels',
  'Rankings':                'Classement',
};

// Section code → flag file stem (without .png extension)
// Covers Canadian provincial/territorial sections plus international codes.
// Entries sorted longest-first so substring matching picks the most specific hit.
const SECTION_FLAG_MAP = [
  ['BC/YT',         'BC'],
  ['ALBERTA',       'AB'],
  ['ONTARIO',       'ON'],
  ['QUÉBEC',        'QC'],
  ['QUEBEC',        'QC'],
  ['MANITOBA',      'MB'],
  ['SASKATCHEWAN',  'SK'],
  ['NOVA SCOTIA',   'NS'],
  ['NEW BRUNSWICK', 'NB'],
  ['NEWFOUNDLAND',  'NL'],
  ['NORTHWEST',     'NT'],
  ['NUNAVUT',       'NU'],
  ['YUKON',         'YT'],
  ['PRINCE EDWARD', 'PE'],
  ['AB',            'AB'],
  ['BC',            'BC'],
  ['MB',            'MB'],
  ['MAN',           'MAN'],
  ['NB',            'NB'],
  ['NFL',           'NFL'],
  ['NL',            'NL'],
  ['NS',            'NS'],
  ['NWT',           'NWT'],
  ['NT',            'NT'],
  ['NU',            'NU'],
  ['ON',            'ON'],
  ['PE',            'PE'],
  ['PEI',           'PEI'],
  ['QC',            'QC'],
  ['SK',            'SK'],
  ['YT',            'YT'],
  ['HQ',            'HQ'],
  ['ISU',           'ISU'],
];

// ── Helpers ────────────────────────────────────────────────────────────────

function safeStr(v) { return v != null ? String(v).trim() : ''; }
function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

function sectionFlagUrl(section) {
  if (!section) return null;
  const upper = String(section).toUpperCase().trim();
  for (const [key, code] of SECTION_FLAG_MAP) {
    if (upper === key || upper.includes(key)) return `/assets/flags/${code}.png`;
  }
  return null;
}

function tr(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (SEGMENT_FR[trimmed]) return SEGMENT_FR[trimmed];
  for (const [en, fr] of Object.entries(SEGMENT_FR)) {
    if (trimmed.toLowerCase().includes(en.toLowerCase())) {
      return trimmed.replace(new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), fr);
    }
  }
  return text;
}

function nowMeta(template) {
  return { template, revision: Date.now(), updatedAt: new Date().toISOString() };
}

function preserveControl(existingControl) {
  return existingControl
    ? { ...existingControl }
    : { visible: false, state: 'hidden' };
}

// Derive SP / FS / RD / FD short code from segment name
function segmentTypeCode(name) {
  const n = String(name || '').toLowerCase();
  if (/short\s*(program|dance)/.test(n)) return 'SP';
  if (/free\s*(program|skate|skating|dance)/.test(n)) return 'FS';
  if (/rhythm\s*dance/.test(n)) return 'RD';
  if (/free\s*dance/.test(n)) return 'FD';
  if (/pattern\s*dance/.test(n)) return 'PD';
  return '';
}

// Determine start-order row status from entry state
function rowStatus(entry) {
  if (entry.onice) return 'SKATING';
  if (entry.score != null && entry.segmentRank != null) return 'SCORED';
  // Has sortOrder/warmUpGroup assignment but no score yet
  if (entry.sortOrder != null) return '';
  return '';
}

// Best available English category name from a CategoryDto.
// For Singles, gender-level names (Senior Men, Junior Women) are self-describing.
// For Pairs / Ice Dance / Synchro the discipline must be appended because level
// names like "Juvenile" or "Senior" are shared across disciplines.
function catEn(categoryDto) {
  const name       = safeStr(categoryDto?.skatingcategorydefinitions?.name || categoryDto?.categoryName || '');
  const discipline = safeStr(categoryDto?.disciplineName || '');
  if (!name) return discipline;
  // Singles is implicit when name already contains a gender/role word
  if (discipline === 'Singles' && /(men|women|boy|girl)/i.test(name)) return name;
  // Discipline already present in name, or no discipline to add
  if (!discipline || name.toLowerCase().includes(discipline.toLowerCase())) return name;
  return `${name} ${discipline}`;
}

// Best available French category from a CategoryDto.
// Same discipline-appending logic as catEn, using French fields.
function catFr(categoryDto) {
  const name   = safeStr(
    categoryDto?.skatingcategorydefinitions?.nameFr ||
    categoryDto?.categoryFrenchDescription          ||
    categoryDto?.programFrenchName                  ||
    ''
  );
  const disciplineEn = safeStr(categoryDto?.disciplineName || '');
  const disciplineFr = safeStr(categoryDto?.disciplineFrenchName || '');
  const base = name || catEn(categoryDto);
  if (!base) return disciplineFr || disciplineEn;
  if (disciplineEn === 'Singles' && /(hommes|femmes|garçon|fille|men|women)/i.test(base)) return base;
  if (!disciplineFr || base.toLowerCase().includes(disciplineEn.toLowerCase()) || base.toLowerCase().includes(disciplineFr.toLowerCase())) return base;
  return `${base} — ${disciplineFr}`;
}

// ── Exported normalizers ───────────────────────────────────────────────────

/**
 * Event info patch — returns an object suitable for server.js applyEventInfoPatch().
 * Pass eventDto, categoryDto, segmentDto (any can be null).
 */
function normalizeEventInfo(eventDto, categoryDto, segmentDto) {
  const evName    = safeStr(eventDto?.EventName);
  const evNameFr  = safeStr(eventDto?.eventFrenchName) || evName;
  const evLoc     = safeStr(eventDto?.eventLocation);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);

  return {
    eventName:      evName   || undefined,
    eventNameFr:    evNameFr || undefined,
    eventLocation:  evLoc    || undefined,
    categoryName:   catName  || undefined,
    categoryNameFr: catNameFr || undefined,
    segmentName:    segName  || undefined,
    segmentNameFr:  segNameFr || undefined,
  };
}

/**
 * Starting order.
 * Entries are grouped by warmUpGroup, sorted by sortOrder within each group.
 * requestedGroup: which group to display (null = first available).
 */
function normalizeStartingOrder(entries, categoryDto, segmentDto, requestedGroup, lang, existingControl) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  const allEntries = Array.isArray(entries) ? entries : [];
  const active = allEntries.filter(e => {
    const s = safeStr(e.competitorStatus).toUpperCase();
    return s !== 'WITHDRAWN' && s !== 'WDR' && s !== 'WITHDRAW';
  });

  // Group by warmUpGroup
  const groupMap = new Map();
  for (const e of active) {
    const g = e.warmUpGroup ?? 1;
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(e);
  }
  const availableGroups = [...groupMap.keys()].sort((a, b) => a - b);
  const targetGroup = (requestedGroup && availableGroups.includes(Number(requestedGroup)))
    ? Number(requestedGroup)
    : (availableGroups[0] ?? 1);

  const groupEntries = (groupMap.get(targetGroup) || [])
    .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));

  const toRow = (e, g) => ({
    position:    e.sortOrder   ?? null,
    name:        safeStr(e.competitorName),
    club:        safeStr(e.competitorClub || e.competitorCombinedClubNames),
    section:     safeStr(e.competitorSection),
    flagUrl:     sectionFlagUrl(e.competitorSection),
    status:      rowStatus(e),
    entryId:     safeStr(e.competitorEntryId),
    warmUpGroup: g,
  });

  const rows = groupEntries.map(e => toRow(e, targetGroup));

  // allRows stores every active entry across all groups so group-switching
  // can re-slice without re-fetching from the API.
  const allRows = [];
  for (const [g, entries] of [...groupMap.entries()].sort((a, b) => a[0] - b[0])) {
    entries.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99)).forEach(e => allRows.push(toRow(e, g)));
  }

  return {
    meta:    nowMeta('starting-order'),
    control: preserveControl(existingControl),
    data: {
      title:           lang === 'fr' ? segNameFr : segName,
      titleEn:         segName,
      titleFr:         segNameFr,
      segmentName:     segName,
      segmentNameFr:   segNameFr,
      categoryName:    catName,
      categoryNameFr:  catNameFr,
      subtitle:        '',
      groupNumber:     targetGroup,
      groupCount:      availableGroups.length,
      availableGroups,
      rowCount:        rows.length,
      rows,
      allRows,
    },
  };
}

/**
 * Scoring display — for the skater currently on ice.
 * Pass null for entry to clear. Components and adjustments are optional.
 */
function normalizeScoring(entry, components, adjustments, categoryDto, segmentDto, lang, existingControl) {
  if (!entry) return null;

  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  const tes = safeNum(entry.tes);
  const pcs = safeNum(entry.pcs);
  const ded = safeNum(entry.deduction);
  const bon = safeNum(entry.bonus);
  const tot = safeNum(entry.score);

  return {
    meta:    nowMeta('scoring'),
    control: preserveControl(existingControl),
    data: {
      segmentType:    segmentTypeCode(segName),
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      categoryName:   catName,
      categoryNameFr: catNameFr,
      groupNumber:    entry.warmUpGroup ?? null,
      name:           safeStr(entry.competitorName),
      club:           safeStr(entry.competitorClub || entry.competitorCombinedClubNames),
      section:        safeStr(entry.competitorSection),
      flagUrl:        sectionFlagUrl(entry.competitorSection),
      rank:           entry.segmentRank   ?? null,
      catRank:        entry.categoryRank  ?? null,
      tes:            tes  ?? null,
      pcs:            pcs  ?? null,
      bonuses:        bon  ?? 0,
      deductions:     ded  ?? 0,
      total:          tot  ?? null,
      catTotal:       null,
      startOrder:     entry.sortOrder ?? null,
    },
  };
}

/**
 * Lower third name bar — from the on-ice entry.
 */
function normalizeLowerThird(entry, categoryDto, segmentDto, existingControl) {
  if (!entry) return null;

  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  return {
    meta:    nowMeta('lower-third'),
    control: preserveControl(existingControl),
    data: {
      line1:          safeStr(entry.competitorName),
      line2:          safeStr(entry.competitorClub || entry.competitorCombinedClubNames),
      flagUrl:        sectionFlagUrl(entry.competitorSection),
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      groupNumber:    entry.warmUpGroup ?? null,
    },
  };
}

/**
 * Segment leaderboard (full rankings graphic).
 * Sorted by segmentRank.
 */
function normalizeRankings(entries, categoryDto, segmentDto, lang, rowsPerPage, currentPage, existingControl) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  const allEntries = Array.isArray(entries) ? entries : [];
  const ranked = allEntries
    .filter(e => e.segmentRank != null || e.score != null)
    .sort((a, b) => (a.segmentRank ?? 999) - (b.segmentRank ?? 999));

  const allRows = ranked.map(e => ({
    rank:     e.segmentRank  ?? null,
    name:     safeStr(e.competitorName),
    club:     safeStr(e.competitorClub || e.competitorCombinedClubNames),
    section:  safeStr(e.competitorSection),
    flagUrl:  sectionFlagUrl(e.competitorSection),
    total:    safeNum(e.score),
    segScore: safeNum(e.score),
    onIce:    !!e.onice,
    entryId:  safeStr(e.competitorEntryId),
  }));

  const rpp       = Math.max(1, rowsPerPage || 8);
  const pageCount = Math.max(1, Math.ceil(allRows.length / rpp));
  const safePage  = Math.min(Math.max(1, currentPage || 1), pageCount);
  const start     = (safePage - 1) * rpp;

  return {
    meta:    nowMeta('rankings'),
    control: preserveControl(existingControl),
    data: {
      title:          lang === 'fr' ? catNameFr : catName,
      titleEn:        catName,
      titleFr:        catNameFr,
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      subtitle:       '',
      page:           safePage,
      pageCount,
      rowsPerPage:    rpp,
      rowCount:       Math.min(rpp, allRows.length - start),
      allRows,
      rows:           allRows.slice(start, start + rpp),
    },
  };
}

/**
 * Rank-6 corner standings — top 6 by segmentRank.
 */
function normalizeStandings(entries, categoryDto, segmentDto, lang, existingControl) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  const allEntries = Array.isArray(entries) ? entries : [];
  const top6 = allEntries
    .filter(e => e.segmentRank != null || e.score != null)
    .sort((a, b) => (a.segmentRank ?? 999) - (b.segmentRank ?? 999))
    .slice(0, 6);

  const rows = top6.map(e => ({
    rank:    e.segmentRank ?? null,
    name:    safeStr(e.competitorName),
    club:    safeStr(e.competitorClub || e.competitorCombinedClubNames),
    section: safeStr(e.competitorSection),
    flagUrl: sectionFlagUrl(e.competitorSection),
    total:   safeNum(e.score),
    onIce:   !!e.onice,
    entryId: safeStr(e.competitorEntryId),
  }));

  return {
    meta:    nowMeta('standings'),
    control: preserveControl(existingControl),
    data: {
      title:          lang === 'fr' ? catNameFr : catName,
      titleEn:        catName,
      titleFr:        catNameFr,
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      subtitle:       '',
      rowCount:       rows.length,
      rows,
    },
  };
}

/**
 * Officials panel.
 * officials: OfficialAssignmentDto[] — may be bare array from API.
 */
function normalizeOfficials(officials, categoryDto, segmentDto, lang, existingControl) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  const rows = (Array.isArray(officials) ? officials : [])
    .filter(o => safeStr(o.officialFullName))
    .sort((a, b) => (a.officialPosition ?? 99) - (b.officialPosition ?? 99))
    .map(o => {
      // officialRole is an OfficialRoleDto — field names are best-guessed from convention
      const role   = o.officialRole;
      const roleEn = safeStr(
        role?.roleName || role?.officialRoleName || role?.name ||
        (typeof role === 'string' ? role : '')
      );
      const roleFr = safeStr(
        role?.roleFrenchName || role?.officialRoleFrenchName || role?.frenchName
      ) || roleEn;
      const section = safeStr(o.officialSection || o.officialHomeOrg);
      return {
        role:    roleEn,
        roleFr,
        name:    safeStr(o.officialFullName),
        section,
        flagUrl: sectionFlagUrl(section),
      };
    });

  return {
    meta:    nowMeta('officials'),
    control: preserveControl(existingControl),
    data: {
      title:          'Officials',
      titleEn:        'Officials',
      titleFr:        'Officiels',
      subtitle:       '',
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      rowCount:       rows.length,
      rows,
    },
  };
}

/**
 * Elements tracker — SkateElementDto[] for the on-ice skater.
 * Matches the shape produced by csvAdapter's element normalizer.
 */
function normalizeElements(elements, entry, categoryDto, segmentDto, existingControl) {
  const catName    = catEn(categoryDto);
  const catNameFr  = catFr(categoryDto) || catName;
  const segName    = safeStr(segmentDto?.segmentName);
  const segNameFr  = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const skaterName = entry ? safeStr(entry.competitorName) : '';

  const rows = (Array.isArray(elements) ? elements : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(el => {
      const bv  = safeNum(el.base_value);
      const goe = safeNum(el.goe_score ?? el.goe_trimmed_mean);
      const val = (bv != null && goe != null) ? Math.round((bv + goe) * 100) / 100 : bv;
      const goeScores = Array.isArray(el.official_goe_scores)
        ? el.official_goe_scores.map(s => safeNum(s.goe ?? s.score ?? s.value))
        : [];
      return {
        order:     el.order     ?? null,
        code:      safeStr(el.code),
        baseValue: bv,
        goe,
        value:     val,
        halfway:   !!el.halfway_flag,
        repeated:  !!el.repeated_jump,
        goeScores,
      };
    });

  const totalTes = Math.round(rows.reduce((sum, r) => sum + (r.value ?? 0), 0) * 100) / 100;

  return {
    meta:    nowMeta('elements'),
    control: preserveControl(existingControl),
    data: {
      skaterName,
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      totalTes,
      rowCount:       rows.length,
      rows,
    },
  };
}

module.exports = {
  normalizeEventInfo,
  normalizeStartingOrder,
  normalizeScoring,
  normalizeLowerThird,
  normalizeRankings,
  normalizeStandings,
  normalizeOfficials,
  normalizeElements,
  // Shared utilities
  sectionFlagUrl,
  safeStr,
  safeNum,
  tr,
  catEn,
  catFr,
};
