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
  // NOTE: no 'ISU' entry — internationals carry the literal section "ISU",
  // which is NOT a country; their country lives in competitorCombinedClubNames.
];

// International entries: ISU country codes + display names, used to resolve a
// flag from the section token (step 2) or the combined club names (step 3).
// Flag assets live at /assets/flags/<CODE>.png — if an asset doesn't exist the
// graphics hide the flag gracefully, so unmatched countries simply show none.
const COUNTRY_FLAGS = [
  ['USA', ['United States']],           ['JPN', ['Japan']],
  ['KOR', ['South Korea']],             ['PRK', ['North Korea']],
  ['CHN', ['China']],                   ['TPE', ['Chinese Taipei', 'Taiwan']],
  ['ISR', ['Israel']],                  ['GBR', ['Great Britain', 'United Kingdom']],
  ['FRA', ['France']],                  ['GER', ['Germany']],
  ['ITA', ['Italy']],                   ['ESP', ['Spain']],
  ['SUI', ['Switzerland']],             ['AUT', ['Austria']],
  ['BEL', ['Belgium']],                 ['NED', ['Netherlands']],
  ['SWE', ['Sweden']],                  ['NOR', ['Norway']],
  ['DEN', ['Denmark']],                 ['FIN', ['Finland']],
  ['ISL', ['Iceland']],                 ['IRL', ['Ireland']],
  ['POL', ['Poland']],                  ['CZE', ['Czechia', 'Czech Republic']],
  ['SVK', ['Slovakia']],                ['SLO', ['Slovenia']],
  ['HUN', ['Hungary']],                 ['ROU', ['Romania']],
  ['BUL', ['Bulgaria']],                ['CRO', ['Croatia']],
  ['SRB', ['Serbia']],                  ['MNE', ['Montenegro']],
  ['BIH', ['Bosnia and Herzegovina']],  ['MKD', ['North Macedonia']],
  ['GRE', ['Greece']],                  ['CYP', ['Cyprus']],
  ['TUR', ['Turkey']],                  ['UKR', ['Ukraine']],
  ['BLR', ['Belarus']],                 ['RUS', ['Russia']],
  ['EST', ['Estonia']],                 ['LAT', ['Latvia']],
  ['LTU', ['Lithuania']],               ['GEO', ['Georgia']],
  ['ARM', ['Armenia']],                 ['AZE', ['Azerbaijan']],
  ['KAZ', ['Kazakhstan']],              ['UZB', ['Uzbekistan']],
  ['KGZ', ['Kyrgyzstan']],              ['MGL', ['Mongolia']],
  ['IND', ['India']],                   ['PHI', ['Philippines']],
  ['THA', ['Thailand']],                ['MAS', ['Malaysia']],
  ['SGP', ['Singapore']],               ['INA', ['Indonesia']],
  ['VIE', ['Vietnam']],                 ['HKG', ['Hong Kong']],
  ['AUS', ['Australia']],               ['NZL', ['New Zealand']],
  ['MEX', ['Mexico']],                  ['BRA', ['Brazil']],
  ['ARG', ['Argentina']],               ['RSA', ['South Africa']],
  ['MDA', ['Moldova']],                 ['MON', ['Monaco']],
  ['AND', ['Andorra']],                 ['LIE', ['Liechtenstein']],
  ['LUX', ['Luxembourg']],              ['POR', ['Portugal']],
  ['CAN', ['Canada']],
];
const COUNTRY_CODES = new Set(COUNTRY_FLAGS.map(([code]) => code));

// ── Helpers ────────────────────────────────────────────────────────────────

// Collapse ALL internal whitespace to single spaces (skater-override entries
// arrive with a TAB between first/last name) and trim.
function safeStr(v) { return v != null ? String(v).replace(/\s+/g, ' ').trim() : ''; }
function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

/**
 * Club/team display for an entry. competitorClub is mojibake for
 * international entries (non-Latin club names destroyed upstream), so prefer
 * competitorCombinedClubNames, which is clean ("Israel"). A string with no
 * letters/digits at all (e.g. "???? ??? ????") is treated as empty.
 */
function entryClub(e) {
  const readable = s => (s && /[\p{L}\p{N}]/u.test(s)) ? s : '';
  return readable(safeStr(e?.competitorCombinedClubNames))
      || readable(safeStr(e?.competitorClub));
}

/**
 * Flag resolution, strictest first — never defaults:
 *   1. Section vs Canadian provinces (exact / whole-token / multi-word keys)
 *   2. Section tokens vs ISU country codes (whole tokens only — the literal
 *      section "ISU" matches nothing and must not)
 *   3. Country display names vs combinedClubNames with strict word boundaries
 *      ("Georgian Bay" must not match GEORGIA)
 *   4. No match → null (no flag). A missing flag asset also renders as no
 *      flag via the graphics' broken-image fallback.
 */
function sectionFlagUrl(section, combinedClubNames) {
  const upper = safeStr(section).toUpperCase();
  if (upper) {
    const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);
    for (const [key, code] of SECTION_FLAG_MAP) {
      const match = upper === key
        || tokens.includes(key)
        || (key.includes(' ') && upper.includes(key));
      if (match) return `/assets/flags/${code}.png`;
    }
    for (const t of tokens) {
      if (COUNTRY_CODES.has(t)) return `/assets/flags/${t}.png`;
    }
  }
  const combined = safeStr(combinedClubNames);
  if (combined) {
    for (const [code, names] of COUNTRY_FLAGS) {
      for (const name of names) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${esc}\\b`, 'i').test(combined)) {
          return `/assets/flags/${code}.png`;
        }
      }
    }
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
// The API writes divisions and groups in shorthand — "13O", "U13", "Grp A".
// Fine on a result sheet, wrong on air: nobody says "thirteen oh". Expand to
// what a commentator would actually read out.
//
// Sections differ on group naming — some say Group A, others Group 1 — so
// groupStyle picks between them. 'letter' keeps whatever the API sent, which
// means a section whose data already uses numbers is unaffected either way.
// Set once per poll from config by scApiService, so the dozen payload builders
// below don't each need the config threaded through them.
let defaultGroupStyle = 'letter';
function setGroupStyle(style) {
  defaultGroupStyle = style === 'number' ? 'number' : 'letter';
}

function numberGroups(s, word) {
  return s.replace(new RegExp('\\b' + word + '\\s+([A-Z])\\b', 'g'),
    (_m, l) => `${word} ${l.charCodeAt(0) - 64}`);
}

function expandDivisionEn(s, groupStyle) {
  const out = safeStr(s)
    .replace(/\bU\s?(\d+)\b/gi, 'Under $1')
    .replace(/\b(\d+)\s?O\b/g,  '$1 & Over')
    .replace(/\bGrp\b/gi,       'Group');
  return (groupStyle ?? defaultGroupStyle) === 'number' ? numberGroups(out, 'Group') : out;
}

function expandDivisionFr(s, groupStyle) {
  const out = safeStr(s)
    .replace(/\bU\s?(\d+)\b/gi, 'Moins de $1')
    .replace(/\b(\d+)\s?O\b/g,  '$1 ans et plus')
    .replace(/\bGrp\b/gi,       'Groupe');
  return (groupStyle ?? defaultGroupStyle) === 'number' ? numberGroups(out, 'Groupe') : out;
}

// Gender ("Girls"/"Women") and division/group ("13O", "Grp A") both sit on the
// CategoryDto and are what separate the many repeats of a STARSkate level.
// Returned separately so catEn/catFr can drop any part already in the name.
function categoryQualifiers(categoryDto) {
  const labels = categoryDto?.categoryLabels || [];
  const gender   = labels.map(l => safeStr(l?.categoryLabelDefinition?.categoryLabelDefinitionName)).filter(Boolean).join('/');
  const genderFr = labels.map(l => safeStr(l?.categoryLabelDefinition?.categoryLabelDefinitionFrenchName)).filter(Boolean).join('/') || gender;
  const base  = safeStr(categoryDto?.skatingcategorydefinitions?.name || '');
  const raw   = safeStr(categoryDto?.categoryName || '');
  // Where there is no separate level, categoryName IS the name — not a group.
  const group = raw && raw !== base ? raw : '';
  return { gender, genderFr, group };
}

/**
 * Trim official element names for air.
 *
 * The API spells everything out — "Change Foot Combination Spin Level 4" —
 * which wraps to three lines in the tracker's column and reads nothing like
 * the commentary. Skating shorthand says the same thing in one line.
 *
 *   Change Foot Combination Spin Level 4 → Change Foot Combo Spin 4
 *   Choreographic Sequence Level 1       → Choreo Seq 1
 *   Circular Step Sequence A Level 2     → Circular Step Seq A 2
 *
 * "Level" is dropped only where the preceding word is not itself a number:
 * ice dance has "Lift Group 3 Level 3", and "Lift Group 3 3" would be
 * unreadable, so those keep the word.
 */
function shortenElementName(name) {
  return safeStr(name)
    .replace(/\s+Level\s+(\d+|B)\b/gi, (match, level, offset, whole) =>
      /\d$/.test(whole.slice(0, offset).trim()) ? match : ` ${level}`)
    .replace(/\bCombination\b/gi, 'Combo')
    .replace(/\bSequence\b/gi, 'Seq')
    .replace(/\bChoreographic\b/gi, 'Choreo')
    // Ice dance runs long — most of its names wrapped to two lines in the
    // tracker's 194px name column. These are the standard call abbreviations.
    .replace(/\bSynchronized\b/gi, 'Sync')
    .replace(/\bSequential\b/gi,   'Seq')
    .replace(/\bDiagonal\b/gi,     'Diag')
    .replace(/\bCircular\b/gi,     'Circ')
    .replace(/\bMidline\b/gi,      'Mid')
    .replace(/\bOne Foot\b/gi,     '1-Ft')
    // Only the pair "Toe Loop" — the loop is its own jump, so "Triple Loop"
    // and "Throw Triple Loop" must survive untouched.
    .replace(/\bToe Loop\b/gi, 'Toe')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Collapse an ice dance element that was called separately for each partner.
 *
 * Those arrive as one element with two sub-elements naming the same thing
 * twice, differing only in the partner letter and level — so joining them
 * plainly gives "1-Ft Turns Seq A 2 + 1-Ft Turns Seq B 2", which always
 * wraps. Naming it once and listing the calls says the same in half the room:
 *
 *   1-Ft Turns Seq A 2 + 1-Ft Turns Seq B 2 → 1-Ft Turns Seq A2 B2
 *   Curve Lift 4 + Curve Lift 3             → Curve Lift 4 + 3
 *
 * Only collapses when every differing tail is a level marker — a partner
 * letter and/or a level. A jump combination's tails are element names
 * ("Lutz", "Toe"), so "Triple Lutz + Triple Toe" is left exactly as it is.
 */
const LEVEL_TAIL = /^(?:[A-Z]\s+)?(?:\d+|B)$/;

function collapsePartnerCalls(parts) {
  if (parts.length < 2) return parts.join(' + ');
  const words = parts.map(p => p.split(' '));
  let common = 0;
  while (words.every(w => w[common] !== undefined && w[common] === words[0][common])) common++;
  if (common === 0) return parts.join(' + ');

  const tails = words.map(w => w.slice(common).join(' '));
  if (!tails.every(t => LEVEL_TAIL.test(t))) return parts.join(' + ');

  const prefix = words[0].slice(0, common).join(' ');
  const shown  = tails.filter(Boolean);
  if (!shown.length) return prefix;
  // "A 2" → "A2" so the partner letter reads together with its level.
  const tight = shown.map(t => t.replace(/^([A-Z])\s+/, '$1'));
  // Bare levels need a separator or "Curve Lift 4 3" looks like one number.
  const bare = tight.every(t => /^\d+$/.test(t));
  return `${prefix} ${tight.join(bare ? ' + ' : ' ')}`;
}

function catEn(categoryDto, opts) {
  const groupStyle = opts?.groupStyle;
  const name       = safeStr(categoryDto?.skatingcategorydefinitions?.name || categoryDto?.categoryName || '');
  const discipline = safeStr(categoryDto?.disciplineName || '');
  if (!name) return discipline;

  // Qualified categories name themselves fully — "STAR 4 Girls 13 & Over".
  // The discipline is dropped there: it duplicates the segment line ("Free
  // Skating" above "Free Program") and pushes the header past the bar width.
  const { gender, group } = categoryQualifiers(categoryDto);
  const quals = [gender, expandDivisionEn(group, groupStyle)]
    .filter(Boolean)
    .filter(q => !name.toLowerCase().includes(q.toLowerCase()));
  if (quals.length) return [name, ...quals].join(' ');

  // Unqualified: keep the long-standing discipline behaviour.
  // Singles is implicit when name already contains a gender/role word
  if (discipline === 'Singles' && /(men|women|boy|girl)/i.test(name)) return name;
  // Discipline already present in name, or no discipline to add
  if (!discipline || name.toLowerCase().includes(discipline.toLowerCase())) return name;
  return `${name} ${discipline}`;
}

// Best available French category from a CategoryDto.
// Same discipline-appending logic as catEn, using French fields.
function catFr(categoryDto, opts) {
  const groupStyle = opts?.groupStyle;
  const name   = safeStr(
    categoryDto?.skatingcategorydefinitions?.nameFr ||
    categoryDto?.categoryFrenchDescription          ||
    categoryDto?.programFrenchName                  ||
    ''
  );
  const disciplineEn = safeStr(categoryDto?.disciplineName || '');
  const disciplineFr = safeStr(categoryDto?.disciplineFrenchName || '');
  const base = name || catEn(categoryDto, opts);
  if (!base) return disciplineFr || disciplineEn;

  // Mirror catEn: a qualified category names itself, discipline dropped.
  const { genderFr, group } = categoryQualifiers(categoryDto);
  const qualsFr = [genderFr, expandDivisionFr(group, groupStyle)]
    .filter(Boolean)
    .filter(q => !base.toLowerCase().includes(q.toLowerCase()));
  if (qualsFr.length) return [base, ...qualsFr].join(' ');

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
    club:        entryClub(e),
    section:     safeStr(e.competitorSection),
    flagUrl:     sectionFlagUrl(e.competitorSection, e.competitorCombinedClubNames),
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
function normalizeScoring(entry, components, adjustments, categoryDto, segmentDto, lang, existingControl, catTotal = null) {
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
      club:           entryClub(entry),
      section:        safeStr(entry.competitorSection),
      flagUrl:        sectionFlagUrl(entry.competitorSection, entry.competitorCombinedClubNames),
      rank:           entry.segmentRank   ?? null,
      catRank:        entry.categoryRank  ?? null,
      tes:            tes  ?? null,
      pcs:            pcs  ?? null,
      bonuses:        bon  ?? 0,
      deductions:     ded  ?? 0,
      total:          tot  ?? null,
      // Cumulative category total (computed by the service from the
      // category's other segments) — the graphic reveals it after the
      // operator's delay when it exceeds the segment total.
      catTotal:       safeNum(catTotal),
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
      line2:          entryClub(entry),
      flagUrl:        sectionFlagUrl(entry.competitorSection, entry.competitorCombinedClubNames),
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
function normalizeRankings(entries, categoryDto, segmentDto, lang, rowsPerPage, currentPage, existingControl, priorBySkater) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  // Final rankings = CATEGORY standings: categoryRank + cumulative total
  // (prior segments + this one). First segment: prior map is empty, so this
  // degrades to segment rank/score naturally.
  const prior = priorBySkater instanceof Map ? priorBySkater : new Map();
  const allEntries = Array.isArray(entries) ? entries : [];
  const ranked = allEntries
    .filter(e => e.score != null && (e.categoryRank != null || e.segmentRank != null))
    .sort((a, b) => (a.categoryRank ?? a.segmentRank ?? 999) - (b.categoryRank ?? b.segmentRank ?? 999));

  const allRows = ranked.map(e => {
    const sc = safeNum(e.score) ?? 0;
    const priorSum = prior.get(safeStr(e.skaterId || e.skatingCompetitorId)) || 0;
    return {
      rank:     e.categoryRank ?? e.segmentRank ?? null,
      name:     safeStr(e.competitorName),
      club:     entryClub(e),
      section:  safeStr(e.competitorSection),
      flagUrl:  sectionFlagUrl(e.competitorSection, e.competitorCombinedClubNames),
      total:    Math.round((priorSum + sc) * 100) / 100,
      segScore: safeNum(e.score),
      onIce:    !!e.onice,
      entryId:  safeStr(e.competitorEntryId),
    };
  });

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
function normalizeStandings(entries, categoryDto, segmentDto, lang, existingControl, pivotEntryId, priorBySkater) {
  const segName   = safeStr(segmentDto?.segmentName);
  const segNameFr = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const catName   = catEn(categoryDto);
  const catNameFr = catFr(categoryDto) || catName;

  // CATEGORY standings: rank by categoryRank and show the cumulative total
  // (prior segments' scores + this segment's). During the first segment the
  // prior map is empty, so this degrades to segment rank/score naturally.
  const prior = priorBySkater instanceof Map ? priorBySkater : new Map();
  const allEntries = Array.isArray(entries) ? entries : [];
  const allRows = allEntries
    .filter(e => e.score != null && (e.categoryRank != null || e.segmentRank != null))
    .map(e => {
      const sc = safeNum(e.score) ?? 0;
      const priorSum = prior.get(safeStr(e.skaterId || e.skatingCompetitorId)) || 0;
      return {
        rank:    e.categoryRank ?? e.segmentRank,
        name:    safeStr(e.competitorName),
        club:    entryClub(e),
        section: safeStr(e.competitorSection),
        flagUrl: sectionFlagUrl(e.competitorSection, e.competitorCombinedClubNames),
        total:   Math.round((priorSum + sc) * 100) / 100,
        onIce:   !!e.onice,
        entryId: safeStr(e.competitorEntryId),
      };
    })
    .sort((a, b) => a.rank - b.rank);

  // Rank-6 CONTEXT rules (ported from the legacy adapter): always show the
  // top 3, then the just-skated skater with their neighbours above and below
  // (with a "···" separator when there's a gap), filled to 6 rows.
  // Pivot = the skater whose score most recently posted (the scoring-hold
  // entry), falling back to the last-ranked row like the old mode did.
  const pivotIdx  = pivotEntryId ? allRows.findIndex(r => r.entryId === pivotEntryId) : -1;
  const pivot     = allRows[pivotIdx >= 0 ? pivotIdx : allRows.length - 1] || null;
  const pivotRank = pivot ? pivot.rank : null;

  // Red row highlight (the graphic's `on-ice` style): the API's onice flag
  // points at the NEXT skater by the time scores post, so re-point it at the
  // pivot — the most recently scored skater — matching the old mode's look.
  allRows.forEach(r => { r.onIce = pivot ? r.entryId === pivot.entryId : false; });

  const selected = new Set();
  const result   = [];
  allRows.filter(r => r.rank <= 3).forEach(r => {
    selected.add(r.rank);
    result.push({ ...r, separator: false });
  });

  if (pivotRank != null) {
    const contextRanks = [pivotRank - 1, pivotRank, pivotRank + 1]
      .filter(n => n >= 1)
      .filter(n => !selected.has(n));
    const contextRows = allRows.filter(r => contextRanks.includes(r.rank));

    const lastTop3Rank = result.length ? result[result.length - 1].rank : 0;
    const firstCtxRank = contextRows.length ? contextRows[0].rank : null;
    const needsSep     = firstCtxRank !== null && firstCtxRank > lastTop3Rank + 1;

    contextRows.forEach((r, i) => {
      selected.add(r.rank);
      result.push({ ...r, separator: i === 0 && needsSep });
    });
  }

  // Fill to at least 6 rows (or total ranked skaters if fewer)
  const targetCount = Math.min(6, allRows.length);
  while (result.length < targetCount) {
    const lastRank = result[result.length - 1]?.rank ?? 0;
    const nextRow  = allRows.find(r => r.rank > lastRank && !selected.has(r.rank));
    if (!nextRow) break;
    result.push({ ...nextRow, separator: nextRow.rank > lastRank + 1 });
    selected.add(nextRow.rank);
  }

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
      pivotRank,
      rowCount:       result.length,
      rows:           result,
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

  // Broadcast listing order: judges first, then Technical Controller, then the
  // Technical Specialists (officialPosition is a within-role number, so TS1
  // sorts before TS2 even though the numbers aren't displayed), then everyone
  // else (Referee, Data Input, Video Replay…).
  function roleRank(roleEn) {
    const r = roleEn.toLowerCase();
    if (r.includes('judge'))                 return 0;
    if (r.includes('technical controller'))  return 1;
    if (r.includes('technical specialist'))  return 2;
    return 3;
  }

  const rows = (Array.isArray(officials) ? officials : [])
    .filter(o => safeStr(o.officialFullName))
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
        _rank:   roleRank(roleEn),
        _pos:    o.officialPosition ?? 99,
      };
    })
    .sort((a, b) => (a._rank - b._rank) || (a._pos - b._pos))
    .map(({ _rank, _pos, ...row }) => row);

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
function normalizeElements(elements, entry, categoryDto, segmentDto, existingControl, segmentStats) {
  const catName    = catEn(categoryDto);
  const catNameFr  = catFr(categoryDto) || catName;
  const segName    = safeStr(segmentDto?.segmentName);
  const segNameFr  = safeStr(segmentDto?.segmentFrenchName) || tr(segName);
  const skaterName = entry ? safeStr(entry.competitorName) : '';

  const rows = (Array.isArray(elements) ? elements : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(el => {
      const bv  = safeNum(el.base_value);
      // Field semantics (verified against live data): goe_trimmed_mean is the
      // GOE in points (signed); goe_score is the element's TOTAL scored value
      // (base_value + GOE) — NOT a GOE, despite the name. Using goe_score as
      // the GOE showed positive numbers on negative-GOE elements and
      // double-counted the base value in totals.
      const goe    = safeNum(el.goe_trimmed_mean);
      const scored = safeNum(el.goe_score);
      const val = scored != null
        ? Math.round(scored * 100) / 100
        : (bv != null && goe != null) ? Math.round((bv + goe) * 100) / 100 : bv;
      const goeScores = Array.isArray(el.official_goe_scores)
        ? el.official_goe_scores.map(s => safeNum(s.goe_value ?? s.goe ?? s.score ?? s.value))
        : [];
      // Full element name for the operator's "Full Name" display mode —
      // lives in subElements[].elementDefinition.name; combos join per-jump.
      // The official names append tech-panel call flags spelled out
      // ("Triple Flip Attention and Quarter") — strip the trailing call
      // chain so only the element name airs. Spin/step levels are kept
      // (they're part of the element, not a call).
      const CALL = '(?:Attention|Wrong Edge|Quarter|Under[ -]?Rotated?|Downgraded?|Invalid|No Value)';
      const CALL_CHAIN = new RegExp('\\s+' + CALL + '(?:\\s+and\\s+' + CALL + ')*\\s*$', 'i');
      const cleanElementName = n => n.replace(CALL_CHAIN, '').trim();
      const fullName = Array.isArray(el.subElements)
        ? collapsePartnerCalls(
            el.subElements
              .slice()
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map(s => shortenElementName(cleanElementName(safeStr(s.elementDefinition?.name))))
              .filter(Boolean)
          )
        : '';
      return {
        order:     el.order     ?? null,
        code:      safeStr(el.code),
        name:      fullName,
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
      // Field names the elements graphic actually renders (name /
      // runningTotal / currentIndex / elements). The old skaterName /
      // totalTes / rows keys are kept as aliases for anything else reading
      // this file.
      name:           skaterName,
      skaterName,
      categoryName:   catName,
      categoryNameFr: catNameFr,
      segmentName:    segName,
      segmentNameFr:  segNameFr,
      // Ice dance element names run far longer than singles or pairs, so the
      // graphic sizes its name column by discipline.
      discipline:     safeStr(categoryDto?.disciplineName),
      groupNumber:    entry?.warmUpGroup ?? null,
      runningTotal:   totalTes,
      totalTes,
      currentIndex:   rows.length - 1,
      elements:       rows,
      rowCount:       rows.length,
      rows,
      // Segment-wide benchmark, computed server-side from the segment's
      // entries (official per-skater TES) — authoritative, unlike the old
      // client-side inference from panel changes.
      highestTes:     segmentStats?.highestTes ?? null,
      highestTesName: segmentStats?.highestTesName ?? '',
      scoredCount:    segmentStats?.scoredCount ?? 0,
    },
  };
}

module.exports = {
  setGroupStyle,
  expandDivisionEn,
  expandDivisionFr,
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
  entryClub,
  safeStr,
  safeNum,
  tr,
  catEn,
  catFr,
};
