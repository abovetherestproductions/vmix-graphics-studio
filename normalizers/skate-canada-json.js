/**
 * Skate Canada live-stream API normalizer.
 *
 * Field mappings reverse-engineered from the actual lamp.skatecanada.ca
 * live-stream endpoints (css23LiveStream-dev).
 *
 * Key API quirks:
 *  - Arrays contain a mix of real skater objects, empty-slot sentinels, and
 *    bare [] separators between groups.
 *  - NoEntry === "#0dff00"  → empty slot (GT Titles bright-green mask)
 *  - NoEntry === "#00000000" → real row (transparent = show it)
 *  - Group === 99           → withdrawn / no-entry group — always skip
 *  - CurrentSkater === "#E4002B" → this skater is currently on ice (ranking)
 *  - Flag field is just "BC.png"; prepend /assets/flags/
 *  - Deductions come as a negative string e.g. "-1.00"
 */

'use strict';

// ── French / English translations ──────────────────────────────────────────

const SEGMENT_FR = {
  // Segments
  'Short Program':    'Programme court',
  'Free Program':     'Programme libre',
  'Free Skate':       'Programme libre',
  'Free Skating':     'Programme libre',
  'Rhythm Dance':     'Danse rythmique',
  'Free Dance':       'Danse libre',
  'Short Dance':      'Danse courte',
  'Original Dance':   'Danse originale',
  'Pairs Short Program': 'Programme court en couple',
  'Pairs Free Program':  'Programme libre en couple',
  'Pairs Short':      'Programme court en couple',
  'Pairs Free':       'Programme libre en couple',
  'Pattern Dance':    'Danse imposée',
  'Interpretive':     'Programme d\u2019interprétation',
  'Artistic':         'Artistique',
  'Creative':         'Créatif',
  'Solo Dance':       'Danse en solo',
  // Graphic/header labels
  'Starting Order':   'Ordre de départ',
  'Final Rankings':   'Classement final',
  'Officials Panel':  'Officiels',
  'Rankings':         'Classement',
  // Category modifiers (used by substring matcher)
  'Women':            'Femmes',
  'Men':              'Hommes',
  'Ladies':           'Dames',
  'Pairs':            'Patinage en couple',
  'Ice Dance':        'Danse sur glace',
  'Senior':           'Senior',
  'Junior':           'Junior',
  'Novice':           'Novice',
  'Pre-Novice':       'Pré-novice',
  'Juvenile':         'Juvénile',
};

// Case-insensitive lookup table built once at module load
const SEGMENT_FR_LC = Object.fromEntries(
  Object.entries(SEGMENT_FR).map(([en, fr]) => [en.toLowerCase(), fr])
);

/**
 * Translate a segment / graphic title string.
 * Tries exact phrase (case-insensitive), then substring match, then falls back to original.
 */
/**
 * Returns true when the given French category string is "sparse" — just a
 * discipline marker like "Patinage en simple" with no actual age/discipline
 * detail. Used to decide whether to fall back to an EN→FR translation.
 */
function isSparseFrCategory(s) {
  if (!s) return true;
  const cleaned = String(s).trim()
    .replace(/\s+\d+$/, '')
    .replace(/\s*\ben\s+simples?\b\s*/gi, ' ')
    .replace(/\s*\bsimples?\b\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(/\s+/).filter(Boolean).length < 2;
}

/**
 * Reorder a French category so the discipline term (Femmes, Hommes, Dames,
 * Couples, Danse sur glace) appears first, followed by the level/age
 * (Pré-novice, Senior, etc.). EN-to-FR substring translation preserves the
 * source word order ("Pré-novice Femmes"), but the Canadian broadcast
 * convention is "Femmes Pré-novice".
 */
function reorderFrCategory(s) {
  if (!s) return s;
  // Multi-word discipline phrases come first so the longest match wins —
  // "Patinage en couple" before "Couples", "Danse sur glace" before "Danse".
  const re = /\b(Patinage en couple|Danse sur glace|Danse|Femmes|Hommes|Dames|Couples?)\b/i;
  const m = s.match(re);
  if (!m) return s;
  const discipline = m[0];
  const rest = s.replace(re, '').replace(/\s+/g, ' ').trim();
  return rest ? `${discipline} ${rest}` : discipline;
}

/**
 * If the French category value is sparse (e.g. just "Patinage en simple"
 * from a SC feed that only labels the discipline), translate the English
 * category to French via the substring dictionary instead. Preserves the
 * original FR when it's already rich. Always re-orders so the discipline
 * (Femmes / Hommes / Couples / Danse sur glace) leads the string.
 */
function enrichFrCategory(catEn, catFr) {
  if (!isSparseFrCategory(catFr)) return reorderFrCategory(catFr);
  if (!catEn) return reorderFrCategory(catFr || '');
  const translated = tr(catEn, 'fr') || catFr || '';
  return reorderFrCategory(translated);
}

function tr(text, lang) {
  if (!text || lang !== 'fr') return text;
  const key = text.toLowerCase();
  if (SEGMENT_FR_LC[key]) return SEGMENT_FR_LC[key];
  // Substring match — longest keys first so "Pairs Short Program" wins over "Pairs"
  const keys = Object.keys(SEGMENT_FR).sort((a, b) => b.length - a.length);
  let result = text;
  for (const en of keys) {
    const re = new RegExp(en.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    if (re.test(result)) {
      result = result.replace(re, SEGMENT_FR[en]);
    }
  }
  return result;
}

/**
 * Pick the French field if available and lang=fr, else English field.
 * e.g. frField(e.PositionFr, e.Position, 'fr') → PositionFr when set
 */
function frField(frVal, enVal, lang) {
  const f = safeStr(frVal);
  return (lang === 'fr' && f) ? f : safeStr(enVal);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function flagUrl(flagFile) {
  if (!flagFile) return null;
  // Strip any Windows path prefix the API sometimes includes
  const base = String(flagFile).replace(/^.*[/\\]/, '').trim();
  if (!base || base === '') return null;
  return `/assets/flags/${base}`;
}

function safeStr(v) { return v != null ? String(v).trim() : ''; }
function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ── Name normalisation ─────────────────────────────────────────────────────
// Parents (and the federation data-entry workflow) sometimes submit names
// as "christiana lock" or "CHRISTIANA LOCK". Graphics that don't force CSS
// uppercase then render that abnormal casing on air. This helper fixes it
// at the data layer so every downstream renderer is consistent.
//
// Strategy: only re-case when the input is clearly "off" — entirely
// lowercase OR entirely uppercase across ALL its letters. Strings that
// already mix cases (e.g. "McDonald", "CBS Skating Club", "iPhone SC")
// are left untouched.
function _capitalize(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
function _titleCaseWord(word) {
  if (!word) return word;
  if (word.includes('-')) {
    return word.split('-').map(_titleCaseWord).join('-');
  }
  // Straight and curly apostrophes (O'Brien, L'Heureux, D'Arcy, O’Connor)
  for (const apos of ["'", '’']) {
    if (word.includes(apos)) {
      return word.split(apos).map(_capitalize).join(apos);
    }
  }
  // Mc-prefix: capitalise the letter after "Mc" (McDonald). Skipping "Mac-"
  // on purpose — Mac names are ambiguous (Mackenzie, Macey, MacDonald),
  // and getting them wrong is worse than leaving Mac-prefixed names as a
  // safe "Mac" + lowercase.
  const lower = word.toLowerCase();
  if (lower.startsWith('mc') && lower.length > 2) {
    return 'Mc' + lower.charAt(2).toUpperCase() + lower.slice(3);
  }
  return _capitalize(word);
}
function safeName(v) {
  const s = safeStr(v);
  if (!s) return '';
  // Pair skaters: "First Last / First Last" — normalise each half.
  if (s.includes(' / ')) {
    return s.split(' / ').map(safeName).join(' / ');
  }
  // Pair clubs / combined club names: "Club A & Club B".
  if (s.includes(' & ')) {
    return s.split(' & ').map(safeName).join(' & ');
  }
  // Only re-case when input is entirely upper-case or entirely lower-case
  // across its letters. Anything mixed (already-cased) is preserved as-is.
  const hasLower = /\p{Ll}/u.test(s);
  const hasUpper = /\p{Lu}/u.test(s);
  if (hasLower && hasUpper) return s;
  return s.split(/(\s+)/).map(tok => /^\s+$/.test(tok) ? tok : _titleCaseWord(tok)).join('');
}
function revisionNow() { return Date.now(); }

/** Returns true for real skater rows; false for empty slots / separators */
function isRealRow(entry) {
  if (!entry || Array.isArray(entry)) return false;
  if (typeof entry !== 'object') return false;
  if (entry.NoEntry === '#0dff00') return false;   // empty GT Titles slot
  if (entry.Group === 99) return false;             // withdrawn group
  if (!entry.Skater && !entry.JudgeName) return false; // no useful content
  return true;
}

// Detect segment type abbreviation from segment name
function segTypeFromName(name) {
  const n = safeStr(name).toUpperCase();
  if (n.includes('FREE') || n.includes('FS')) return 'FS';
  if (n.includes('RHYTHM') || n.includes('RD')) return 'RD';
  if (n.includes('FREE DANCE') || n.includes('FD')) return 'FD';
  if (n.includes('SHORT DANCE') || n.includes('SD')) return 'SD';
  return 'SP'; // default to short program
}

// ── Start Order ────────────────────────────────────────────────────────────

/**
 * Normalizes the startOrder.php flat array into a starting-order payload.
 *
 * @param {Array}  raw           - raw API response array
 * @param {number} groupNumber   - if provided, filter to this group only
 * @param {string} lang          - 'en' | 'fr'
 * @param {Object} categoryInfo  - optional { en, fr } from eventInfo.php (since
 *                                 startOrder.php does NOT include CategoryName)
 */
function normalizeStartingOrder(raw, groupNumber = null, lang = 'en', categoryInfo = null) {
  const entries = Array.isArray(raw) ? raw : [];

  const rows = entries
    .filter(e => {
      if (!isRealRow(e)) return false;
      if (e.competitorStatus === 'WITHDRAW') return false;
      if (groupNumber !== null && Number(e.Group) !== Number(groupNumber)) return false;
      return true;
    })
    .map(e => ({
      position: e.Position ?? null,
      name:     safeName(e.Skater),
      club:     safeName(e.Club),
      section:  safeStr(e.Section),
      flagUrl:  flagUrl(e.Flag),
      status:   safeStr(e.competitorStatus).toUpperCase() || null,
    }))
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  // Derive title / subtitle from real rows — store both languages.
  // SegmentName and CategoryName may live on different entries, so scan separately.
  const segRow = entries.find(e => isRealRow(e) && e.SegmentName) || {};
  const catRow = entries.find(e => isRealRow(e) && e.CategoryName) || {};
  const segNameEn = segRow.SegmentName
    ? tr(safeStr(segRow.SegmentName), 'en')
    : 'Starting Order';
  const segNameFr = segRow.SegmentNameFr
    ? safeStr(segRow.SegmentNameFr)
    : (segRow.SegmentName ? tr(safeStr(segRow.SegmentName), 'fr') : 'Ordre de départ');
  const segName   = lang === 'fr' ? segNameFr : segNameEn;
  // Group subtitle removed by request — header shows the segment/category title only.
  // groupNumber is still tracked on data.groupNumber for animations and state.
  const subtitle  = '';

  // Detect all groups present in the data (for auto-detection)
  const groups = [...new Set(
    entries.filter(e => isRealRow(e) && e.Group && e.Group !== 99).map(e => e.Group)
  )].sort((a, b) => a - b);

  // Extract category name (independently from segment row) so titleSource='category' works.
  // startOrder.php normally does NOT carry CategoryName — fall back to eventInfo.php
  // (passed in as `categoryInfo`) so the operator's "Category" pick resolves to a real value.
  const catFromRowEn = safeStr((catRow.CategoryName || '').replace(/\s*\d+$/, ''));
  const catFromRowFr = safeStr((catRow.CategoryNameFr || catRow.CategoryName || '').replace(/\s*\d+$/, ''));
  const catNameEn = catFromRowEn || safeStr(categoryInfo?.en) || '';
  // If the feed's French is just a discipline marker, translate from EN
  const catFrRaw  = catFromRowFr || safeStr(categoryInfo?.fr) || tr(catNameEn, 'fr') || '';
  const catNameFr = enrichFrCategory(catNameEn, catFrRaw);

  return {
    meta:    { template: 'starting-order', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 700 },
    data: {
      title:          segName,
      titleEn:        segNameEn,
      titleFr:        segNameFr,
      segmentName:    segNameEn,
      segmentNameFr:  segNameFr,
      categoryName:   catNameEn,
      categoryNameFr: catNameFr,
      subtitle,
      groupNumber: groupNumber ?? null,
      groupCount:  groups.length,
      availableGroups: groups,
      rowCount:    rows.length,
      rows,
    },
  };
}

// ── Scoring / Current Skater ───────────────────────────────────────────────

/**
 * Normalizes currentSkater.php response into a scoring payload.
 * Takes the first element of the array.
 *
 * Fields: SegmentName, CategoryName, Skater, PCScore, TEScore,
 *         Bonuses, Deductions, SegScore, SegRank, CatScore, CatRank,
 *         Section, Club, Flag, Group
 */
function normalizeScoring(raw, lang = 'en') {
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry || !entry.Skater) return null;

  const deductions = Math.abs(safeNum(entry.Deductions) ?? 0);
  const rawSeg  = frField(entry.SegmentNameFr, entry.SegmentName, lang);
  const rawCat  = frField(entry.CategoryNameFr, entry.CategoryName, lang);
  // Always emit BOTH language pairs so cross-template borrowers
  // (pickRichestCategory, lower-third dual-write) can render in either
  // language regardless of which one this graphic is currently set to.
  // Strip the trailing sub-category number (" 1" / " 2") to match what
  // other normalizers do at ingest.
  const catEnRaw = safeStr((entry.CategoryName   || '').replace(/\s*\d+$/, ''));
  const catFrRaw = safeStr((entry.CategoryNameFr || '').replace(/\s*\d+$/, ''));
  const catEn = catEnRaw;
  const catFr = enrichFrCategory(catEn, catFrRaw);
  const segEn = safeStr(entry.SegmentName);
  const segFr = entry.SegmentNameFr ? safeStr(entry.SegmentNameFr) : tr(segEn, 'fr');

  return {
    meta:    { template: 'scoring', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 600 },
    data: {
      segmentType:    segTypeFromName(entry.SegmentName),
      segmentName:    tr(rawSeg, lang),
      segmentNameFr:  segFr,
      categoryName:   catEn,
      categoryNameFr: catFr,
      groupNumber:   entry.Group ?? entry.GroupNumber ?? entry.GroupNo ?? null,
      name:          safeName(entry.Skater),
      club:          safeName(entry.Club),
      section:       safeStr(entry.Section),
      flagUrl:       flagUrl(entry.Flag),
      rank:          entry.SegRank   ?? null,
      catRank:       entry.CatRank   ?? null,
      tes:           safeNum(entry.TEScore)  ?? 0,
      pcs:           safeNum(entry.PCScore)  ?? 0,
      bonuses:       safeNum(entry.Bonuses)  ?? 0,
      deductions,
      total:         safeNum(entry.SegScore) ?? 0,
      catTotal:      safeNum(entry.CatScore) ?? 0,
    },
  };
}

// ── Standings / Ranking ────────────────────────────────────────────────────

/** Shared row builder for all ranking functions */
function buildRankingRow(e) {
  return {
    // Rank: try all known field names across SC endpoints
    rank:     e.Position ?? e.Rank ?? e.CatRank ?? null,
    name:     safeName(e.Skater),
    club:     safeName(e.Club),
    section:  safeStr(e.Section),
    flagUrl:  flagUrl(e.Flag),
    // Total: cumulative category score across segments
    total:    safeNum(e.CatScore ?? e.TotScore ?? e.TotalScore),
    // Segment score: this segment only
    segScore: safeNum(e.SegScore ?? e.SegTotal),
    onIce:    e.CurrentSkater === '#E4002B',
  };
}

/**
 * Normalizes ranking.php into a FULL leaderboard payload used by the
 * large center-panel "rankings" template.
 *
 * Stores allRows for server-side paging. The `rows` field contains only
 * the first page; callers slice allRows to produce other pages.
 *
 * @param {Array}  raw         - raw ranking array
 * @param {number} rowsPerPage - rows per page (default 8)
 * @param {number} page        - initial page to return (default 1)
 */
function normalizeRankings(raw, rowsPerPage = 8, page = 1, lang = 'en') {
  const entries = Array.isArray(raw) ? raw : [];

  // Include ALL named skater rows regardless of whether they have a rank yet.
  // During live events the SC API may only return the context-view subset;
  // for completed segments it returns the full list. Unranked skaters sort last.
  const allRows = entries
    .filter(e => isRealRow(e) && e.Skater)
    .map(buildRankingRow)
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return 0;
      if (a.rank == null) return 1;   // unranked → bottom
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });

  const first    = entries.find(e => isRealRow(e)) || {};
  // Separate the "header label" from the "real category" — when the feed
  // doesn't carry a CategoryName, leave categoryName EMPTY so Title Source =
  // "Category" falls through to the cross-template mirror (cfg.categoryName
  // populated by currentSkater.php), rather than stamping the template's own
  // label ("Final Rankings") as if it were a real category.
  const rawCatEn = safeStr((first.CategoryName   || '').replace(/\s*\d+$/, ''));
  const rawCatFr = safeStr((first.CategoryNameFr || '').replace(/\s*\d+$/, ''));
  const catNameEn = rawCatEn;
  const catNameFr = rawCatEn || rawCatFr ? enrichFrCategory(rawCatEn, rawCatFr) : '';
  // Title / header label — used by resolveTitle as the LAST-resort fallback
  // (or when titleSource='fixed'). Always set so the graphic has a sensible
  // default before any custom override.
  const headerEn = catNameEn || 'Final Rankings';
  const headerFr = catNameFr || 'Classement final';
  const headerNow = lang === 'fr' ? headerFr : headerEn;

  const pageCount = Math.max(1, Math.ceil(allRows.length / rowsPerPage));
  const safePage  = Math.min(Math.max(1, page), pageCount);
  const start     = (safePage - 1) * rowsPerPage;
  const pageRows  = allRows.slice(start, start + rowsPerPage);

  // Extract segment name separately — allows titleSource='segment' to resolve
  const segmentNameEn = first.SegmentName ? tr(safeStr(first.SegmentName), 'en') : '';
  const segmentNameFr = first.SegmentNameFr
    ? safeStr(first.SegmentNameFr)
    : (first.SegmentName ? tr(safeStr(first.SegmentName), 'fr') : '');

  return {
    meta:    { template: 'rankings', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 700 },
    data: {
      title:           headerNow,
      titleEn:         headerEn,
      titleFr:         headerFr,
      categoryName:    catNameEn,
      categoryNameFr:  catNameFr,
      segmentName:     segmentNameEn,
      segmentNameFr:   segmentNameFr,
      subtitle:    '',
      page:        safePage,
      pageCount,
      rowsPerPage,
      rowCount:    pageRows.length,
      rows:        pageRows,
      allRows,               // stored for server-side paging
    },
  };
}

/**
 * Normalizes ranking.php into the contextual "Rank 6" bottom-corner payload.
 *
 * Always shows:
 *   • Top 3 (ranks 1–3)
 *   • The rank immediately above the current/on-ice skater
 *   • The current/on-ice skater (highlighted)
 *   • The rank immediately below
 *
 * When there's a gap between the top-3 block and the context block, the
 * first context row carries `separator: true` so the graphic can draw a
 * visual break.
 */
function normalizeRank6(raw, lang = 'en') {
  const entries = Array.isArray(raw) ? raw : [];

  const allRows = entries
    .filter(e => isRealRow(e) && e.Skater && (e.Position != null || e.Rank != null || e.CatRank != null))
    .map(buildRankingRow)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  const first    = entries.find(e => isRealRow(e)) || {};
  // Same separation as normalizeRankings — categoryName empty when the feed
  // doesn't carry one, so Title Source = "Category" falls through to the
  // cross-template mirror (cfg.categoryName). title/titleEn/titleFr always
  // carry the template header label as a safe default.
  const rawCatEn = safeStr((first.CategoryName   || '').replace(/\s*\d+$/, ''));
  const rawCatFr = safeStr((first.CategoryNameFr || '').replace(/\s*\d+$/, ''));
  const catNameEn = rawCatEn;
  const catNameFr = rawCatEn || rawCatFr ? enrichFrCategory(rawCatEn, rawCatFr) : '';
  const headerEn  = catNameEn || 'Rankings';
  const headerFr  = catNameFr || 'Classement';
  const headerNow = lang === 'fr' ? headerFr : headerEn;

  if (allRows.length === 0) {
    return {
      meta:    { template: 'standings', revision: revisionNow(), updatedAt: new Date().toISOString() },
      control: { visible: false, state: 'hidden' },
      data:    {
        title: headerNow, titleEn: headerEn, titleFr: headerFr,
        categoryName: catNameEn, categoryNameFr: catNameFr,
        segmentName: '', segmentNameFr: '',
        subtitle: '', rows: [], pivotRank: null,
      },
    };
  }

  // Pivot = on-ice skater, or last-ranked if nobody on ice yet
  const pivotIdx  = allRows.findIndex(r => r.onIce);
  const pivot     = allRows[pivotIdx >= 0 ? pivotIdx : allRows.length - 1];
  const pivotRank = pivot.rank;

  // Always include top 3
  const selected = new Set();
  const result   = [];
  allRows.filter(r => r.rank <= 3).forEach(r => {
    selected.add(r.rank);
    result.push({ ...r, separator: false });
  });

  // Context rows around pivot (de-duplicated)
  const contextRanks = [pivotRank - 1, pivotRank, pivotRank + 1]
    .filter(n => n >= 1)
    .filter(n => !selected.has(n));
  const contextRows  = allRows.filter(r => contextRanks.includes(r.rank));

  // Insert separator if there's a gap between top-3 and context
  const lastTop3Rank = result.length ? result[result.length - 1].rank : 0;
  const firstCtxRank = contextRows.length ? contextRows[0].rank : null;
  const needsSep     = firstCtxRank !== null && firstCtxRank > lastTop3Rank + 1;

  contextRows.forEach((r, i) => {
    selected.add(r.rank);
    result.push({ ...r, separator: i === 0 && needsSep });
  });

  // ── Fill to at least 6 rows (or total skaters if fewer) ───────────────
  // When the on-ice skater is in the top 3, context block is empty and we'd
  // only show 3 rows. Keep adding the next-ranked unselected rows until we
  // reach 6, so the standings panel always looks full.
  const targetCount = Math.min(6, allRows.length);
  while (result.length < targetCount) {
    const lastRank  = result[result.length - 1]?.rank ?? 0;
    const nextRow   = allRows.find(r => r.rank > lastRank && !selected.has(r.rank));
    if (!nextRow) break;
    const gapSep    = nextRow.rank > lastRank + 1;
    result.push({ ...nextRow, separator: gapSep });
    selected.add(nextRow.rank);
  }

  // Extract segment name separately so titleSource='segment' can resolve
  const segmentNameEn = first.SegmentName ? tr(safeStr(first.SegmentName), 'en') : '';
  const segmentNameFr = first.SegmentNameFr
    ? safeStr(first.SegmentNameFr)
    : (first.SegmentName ? tr(safeStr(first.SegmentName), 'fr') : '');

  return {
    meta:    { template: 'standings', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 700 },
    data:    {
      title:           headerNow,
      titleEn:         headerEn,
      titleFr:         headerFr,
      categoryName:    catNameEn,
      categoryNameFr:  catNameFr,
      segmentName:     segmentNameEn,
      segmentNameFr:   segmentNameFr,
      subtitle: '', rows: result, pivotRank,
    },
  };
}

/**
 * Legacy alias — kept for any direct callers; prefer normalizeRankings / normalizeRank6.
 * @deprecated
 */
function normalizeStandings(raw, maxRows = 6, lang = 'en') {
  return normalizeRank6(raw, lang);
}

// ── Officials ──────────────────────────────────────────────────────────────

/**
 * Normalizes officials.php response.
 *
 * Fields: Position, PositionFr, JudgeName, Flag, Section, NoEntry
 * Empty [] arrays are separators between judges and panel officials — skip them.
 */
function normalizeOfficials(raw, lang = 'en', context = {}) {
  const entries = Array.isArray(raw) ? raw : [];

  const rows = entries
    .filter(e => isRealRow(e) && e.JudgeName && e.Position)
    .map(e => ({
      // Store both languages — graphic JS picks at render time
      role:    safeStr(e.Position),
      roleFr:  safeStr(e.PositionFr) || safeStr(e.Position),
      name:    safeName(e.JudgeName),
      section: safeStr(e.Section),
      flagUrl: flagUrl(e.Flag),
    }));

  const titleEn = 'Officials';
  const titleFr = 'Officiels';

  // officials.php carries no category/segment context, so the server passes
  // the active event context in via `context`. These are what the operator's
  // Title Source dropdown 'Category' / 'Segment' options read from.
  const catEn = safeStr(context.categoryEn) || '';
  const catFr = safeStr(context.categoryFr) || tr(catEn, 'fr') || '';
  const segEn = safeStr(context.segmentEn) || '';
  const segFr = safeStr(context.segmentFr) || tr(segEn, 'fr') || '';

  return {
    meta:    { template: 'officials', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: 'animateIn', durationMs: 600 },
    data: {
      title:    lang === 'fr' ? titleFr : titleEn,
      titleEn,
      titleFr,
      subtitle: '',
      categoryName:   catEn,
      categoryNameFr: catFr,
      segmentName:    segEn,
      segmentNameFr:  segFr,
      rows,
    },
  };
}

// ── Live Element Tracker ───────────────────────────────────────────────────

/**
 * Normalizes liveElementTracker.php response.
 *
 * Fields: Element, SkaterID, Base, GOE, GOECode, Score, TES,
 *         ElementStringEn, OnIce
 *
 * The array contains all elements completed so far in the current program.
 * TES on the last entry is the running technical total.
 * OnIce:true means this element is currently being called/reviewed.
 */
function normalizeLiveElements(raw, context = {}) {
  const entries = Array.isArray(raw) ? raw : [];

  if (entries.length === 0) {
    return {
      meta:    { template: 'elements', revision: revisionNow(), updatedAt: new Date().toISOString() },
      control: { visible: false, state: 'hidden' },
      data:    { name: '', runningTotal: 0, currentIndex: -1, elements: [] },
    };
  }

  // The skater name comes from any entry's SkaterID
  const skaterName = safeStr(entries.find(e => e.SkaterID)?.SkaterID || '');

  // Running total = TES from the last entry
  const lastEntry   = entries[entries.length - 1];
  const runningTotal = safeNum(lastEntry?.TES) ?? 0;

  // Current element = the one with OnIce:true, else the last one
  const currentIndex = (() => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].OnIce === true || /^true$/i.test(String(entries[i].OnIce || ''))) return i;
    }
    return entries.length - 1;
  })();

  const elements = entries.map(e => ({
    code:        safeStr(e.Element),
    // Try multiple known field names for the full element name (API variations)
    name:        safeStr(e.ElementStringEn || e.ElementString || e.ElementName || e.Name),
    nameFr:      safeStr(e.ElementStringFr || e.ElementNameFr),
    baseValue:   safeNum(e.Base),
    goe:         safeNum(e.GOE),
    score:       safeNum(e.Score),
    onIce:       e.OnIce === true || /^true$/i.test(String(e.OnIce || '')),
  }));

  return {
    meta:    { template: 'elements', revision: revisionNow(), updatedAt: new Date().toISOString() },
    control: { visible: true, state: entries.length === 1 ? 'animateIn' : 'animateUpdate' },
    data:    {
      name: skaterName,
      runningTotal,
      currentIndex,
      elements,
      // Category/segment carry-through so the Highest TES tracker can bucket
      // by category. liveElementTracker.php doesn't include these per-row,
      // so the server passes them in from the current scoring payload.
      categoryName:   safeStr(context.categoryEn || context.categoryName || ''),
      categoryNameFr: safeStr(context.categoryFr || context.categoryNameFr || ''),
      segmentName:    safeStr(context.segmentEn  || context.segmentName  || ''),
      segmentNameFr:  safeStr(context.segmentFr  || context.segmentNameFr || ''),
      groupNumber:    context.groupNumber ?? null,
    },
  };
}

// ── Event Info ─────────────────────────────────────────────────────────────

/**
 * Normalizes eventInfo.php response into an event-config theme patch.
 */
// Recognise upstream values that are just the bare DISCIPLINE marker
// ("Singles", "Patinage en simple", "Simples") rather than a real category
// like "Pre-Novice Men Singles". On some events (e.g. BC/YT Section Super
// Series 2026) the upstream's eventInfo.Category is set to "Singles" with
// no men/women/level info, which would poison event-config.categoryName
// for every graphic. Reject those at ingest so per-row data (richer) wins.
function isBareDisciplineMarker(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  // English: standalone "Single" / "Singles" / "Pairs" / "Ice Dance"
  if (/^singles?$/i.test(t)) return true;
  if (/^pairs?$/i.test(t)) return true;
  if (/^ice\s*dance$/i.test(t)) return true;
  if (/^synchro(nized\s*skating)?$/i.test(t)) return true;
  // French: "Patinage en simple" / "Simple" / "Simples" / "Patinage en couple"
  if (/^patinage\s+(en\s+)?simples?$/i.test(t)) return true;
  if (/^simples?$/i.test(t)) return true;
  if (/^patinage\s+(en\s+)?couples?$/i.test(t)) return true;
  if (/^danse\s+sur\s+glace$/i.test(t)) return true;
  return false;
}

function normalizeEventInfo(raw) {
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry) return null;
  // If the upstream's Category/Segment is just a bare discipline marker,
  // emit empty so applyEventInfoPatch's truthy-check skips writing it —
  // graphics will fall back to richer per-row data (currentSkater, ranking)
  // via pickRichestCategory().
  const rawCatEn = safeStr(entry.Category).replace(/\s*\d+$/, '');
  const rawCatFr = safeStr(entry.FRCategory).replace(/\s*\d+$/, '');
  const rawSegEn = safeStr(entry.Segment);
  const rawSegFr = safeStr(entry.FRSegment);
  const catEn = isBareDisciplineMarker(rawCatEn) ? '' : rawCatEn;
  const catFr = isBareDisciplineMarker(rawCatFr) ? '' : rawCatFr;
  const segEn = isBareDisciplineMarker(rawSegEn) ? '' : rawSegEn;
  const segFr = isBareDisciplineMarker(rawSegFr) ? '' : rawSegFr;
  // Subtitle still uses raw values — it's only the *fallback* category that
  // we're protecting. The subtitle field on the event-config is editable by
  // the operator anyway.
  return {
    eventName:      safeStr(entry.EventName),
    eventSubtitle:  [catEn || rawCatEn, segEn || rawSegEn].filter(Boolean).join(' — '),
    eventLocation:  safeStr(entry.EventLocation),
    logoPath:       safeStr(entry.EventlogoPath) || null,
    categoryName:   catEn,
    categoryNameFr: catFr,
    segmentName:    segEn,
    segmentNameFr:  segFr,
  };
}

module.exports = {
  normalizeStartingOrder,
  normalizeScoring,
  normalizeRankings,
  normalizeRank6,
  normalizeStandings,   // legacy alias → normalizeRank6
  normalizeOfficials,
  normalizeLiveElements,
  normalizeEventInfo,
  flagUrl,
  isRealRow,
  safeName,
  enrichFrCategory,
  isSparseFrCategory,
  tr,
};
