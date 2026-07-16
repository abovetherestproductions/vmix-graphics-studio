'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/**
 * Skater Extras — quotes + program music lookup.
 *
 * Reads two event-supplied workbooks (Skate Canada "Registration Custom
 * Fields" reports) and builds a normalized name → { quote, shortMusic,
 * freeMusic } map used to enrich the manual-skater graphic when a skater is
 * selected in sc-api.html.
 *
 * Music sheet: one skater appears on TWO rows — one row carries
 * "Music Title-Free Program", the other "Music Title-Short Program".
 * Quotes sheet: one row per skater, "Quote for Streaming" column.
 *
 * Config (event-config.json):
 *   skaterExtras: { musicWorkbookPath: '', quotesWorkbookPath: '' }
 *
 * Both paths may be absolute or relative to the project root. Files are
 * re-read automatically when their mtime changes, so replacing the files
 * for a new event needs no restart.
 */

function isAbsoluteLike(p) {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(String(p || '')) || /^\\\\/.test(String(p || ''));
}

// Normalize a person name for matching: lowercase, strip diacritics,
// collapse whitespace (skater-override entries carry tabs).
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Hyphens are treated as spaces for MATCHING only: the API sometimes
    // returns hyphenated given names ("Chantalle-Elizabeth") that the event's
    // registration sheets record with a plain space instead. Without this,
    // those skaters silently fail to match and lose their coaches/quote/music.
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Display normalization ──────────────────────────────────────────────────
// Skater-supplied text arrives as-typed ("all of me", "Trust the process",
// "Lalaland soundtrack,Justin Hurwitz"). Clean it for broadcast without
// touching anything that already looks intentional.

// Words kept lowercase mid-title (broadcast style: only short function words —
// prepositions of 4+ letters like "over"/"with" get capitalized), plus common
// foreign particles and credit markers.
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in',
  'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'vs', 'yet',
  'du', 'de', 'da', 'di', 'le', 'la', 'les', 'des', 'von', 'van',
  'feat', 'ft',
]);

// Fix typing-artifact spacing around punctuation: "word,word" → "word, word",
// "word( x)" → "word (x)", doubled spaces, stray space before , or ).
function normalizeMusicSpacing(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,)\].;:])/g, '$1')
    .replace(/([,;:])(?=\S)/g, '$1 ')
    .replace(/(\S)\(/g, '$1 (')
    .replace(/\(\s+/g, '(')
    .trim();
}

// Capitalize the first alphabetic character, skipping leading quotes/parens.
function capFirstAlpha(word) {
  const i = word.search(/[a-zà-öø-ÿ]/i);
  if (i < 0) return word;
  return word.slice(0, i) + word[i].toUpperCase() + word.slice(i + 1);
}

/**
 * Smart title case for music titles. Conservative by design:
 *  - a word containing ANY existing uppercase is left untouched
 *    (preserves TRON, ABBA, McCartney, mid-title names, acronyms)
 *  - fully-lowercase words are capitalized, except AP small words mid-title
 *  - the first word, last word, and the word after a separator
 *    ( / , - – — : ; & + ( " ) are always capitalized
 */
function smartTitleCase(input) {
  const s = normalizeMusicSpacing(input);
  if (!s) return '';
  const words = s.split(' ');
  const out = words.map((word, i) => {
    const prev = i > 0 ? words[i - 1] : '';
    // Commas are deliberately NOT segment separators: ", by Artist" credits
    // keep their small words lowercase. Slashes/colons/dashes start fresh.
    const segStart = i === 0 || /[\/:;&+\-–—("“\[]$/.test(prev);
    const isLast = i === words.length - 1;
    // Process slash/hyphen-joined parts inside one token ("criminal/bad")
    return word.split(/([\/–—-])/).map((part, j, arr) => {
      if (/^[\/–—-]$/.test(part) || !part) return part;
      const partStart = segStart || j > 0;
      if (/[A-ZÀ-ÖØ-Þ]/.test(part)) return part; // has caps — intentional, keep
      const bare = part.replace(/[^a-zà-öø-ÿ'’]/gi, '');
      if (!partStart && !isLast && SMALL_WORDS.has(bare)) return part;
      return capFirstAlpha(part);
    }).join('');
  });
  return out.join(' ');
}

// Kept lowercase in coach lists: list connectors and surname particles
// ("van der Berg", "de la Cruz"). Anything already carrying a capital is
// never touched, so this only decides what happens to fully-lowercase words.
const NAME_CONNECTORS = new Set(['and', 'et', '&', 'with']);
const NAME_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'ter', 'ten', 'te', 'de', 'del', 'della',
  'di', 'da', 'dos', 'do', 'du', 'la', 'le', 'les', 'des', 'el', 'al', 'y',
]);

/**
 * Guard rail for person-name lists typed in lowercase ("yvan desjardins",
 * "Jason and karen Mongrain"). Capitalizes fully-lowercase words — including
 * after hyphens and apostrophes (moore-towers → Moore-Towers, o'brien →
 * O'Brien) — while leaving connectors ("and"), surname particles ("van",
 * "de"), and anything already capitalized (McLeod, DiCaprio) untouched.
 */
function capNameWords(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  return s.split(' ').map(word => {
    if (/[A-ZÀ-ÖØ-Þ]/.test(word)) return word;           // has caps — intentional
    const bare = word.replace(/[^a-zà-öø-ÿ]/g, '');
    if (NAME_CONNECTORS.has(bare) || NAME_PARTICLES.has(bare)) return word;
    // Capitalize the first letter and letters following hyphens/apostrophes
    return word.replace(/(^|[-'’])([a-zà-öø-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }).join(' ');
}

/**
 * Quote cleanup: collapse whitespace, capitalize the first letter and any
 * lone "i", and finish with a period when no terminal punctuation exists.
 * Never rewrites wording or fixes spelling — the skater's voice stays.
 */
function cleanQuote(input) {
  let s = String(input || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\bi\b/g, 'I');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?…"”')\]]$/.test(s)) s += '.';
  return s;
}

// Find a row value by fuzzy header match (case/punctuation-insensitive
// substring) so future event reports with slightly different header text
// still parse.
function headerValue(row, ...needles) {
  const keys = Object.keys(row);
  for (const key of keys) {
    const k = key.toLowerCase();
    if (needles.every(n => k.includes(n))) return String(row[key] ?? '').trim();
  }
  return '';
}

function createSkaterExtrasService({ rootDir, readConfig }) {
  const cache = {
    musicPath: null, musicMtime: 0,
    quotesPath: null, quotesMtime: 0,
    map: new Map(),
    counts: { skaters: 0, quotes: 0 },
    errors: [],
  };

  function settings() {
    return readConfig().skaterExtras || {};
  }

  function resolvePath(p) {
    if (!p) return '';
    return isAbsoluteLike(p) ? p : path.resolve(rootDir, p);
  }

  function mtimeOf(p) {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
  }

  function readSheetRows(filePath) {
    const wb = XLSX.readFile(filePath, { cellDates: false });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  }

  function ensureLoaded() {
    const cfg = settings();
    const musicPath = resolvePath(cfg.musicWorkbookPath);
    const quotesPath = resolvePath(cfg.quotesWorkbookPath);
    const coachesPath = resolvePath(cfg.coachesWorkbookPath);
    const musicMtime = musicPath ? mtimeOf(musicPath) : 0;
    const quotesMtime = quotesPath ? mtimeOf(quotesPath) : 0;
    const coachesMtime = coachesPath ? mtimeOf(coachesPath) : 0;

    const unchanged = musicPath === cache.musicPath && musicMtime === cache.musicMtime
      && quotesPath === cache.quotesPath && quotesMtime === cache.quotesMtime
      && coachesPath === cache.coachesPath && coachesMtime === cache.coachesMtime;
    if (unchanged) return;

    cache.musicPath = musicPath;
    cache.musicMtime = musicMtime;
    cache.quotesPath = quotesPath;
    cache.quotesMtime = quotesMtime;
    cache.coachesPath = coachesPath;
    cache.coachesMtime = coachesMtime;
    cache.map = new Map();
    cache.counts = { skaters: 0, quotes: 0, coaches: 0 };
    cache.errors = [];

    function entryFor(first, last) {
      const key = normName(`${first} ${last}`);
      if (!key) return null;
      if (!cache.map.has(key)) cache.map.set(key, { quote: '', shortMusic: '', freeMusic: '', coaches: '' });
      return cache.map.get(key);
    }

    if (musicPath) {
      if (!musicMtime) {
        cache.errors.push(`Music workbook not found: ${musicPath}`);
      } else {
        try {
          for (const row of readSheetRows(musicPath)) {
            const entry = entryFor(
              headerValue(row, 'first name'),
              headerValue(row, 'last name')
            );
            if (!entry) continue;
            const shortT = headerValue(row, 'music', 'short');
            const freeT = headerValue(row, 'music', 'free');
            if (shortT) entry.shortMusic = smartTitleCase(shortT);
            if (freeT) entry.freeMusic = smartTitleCase(freeT);
          }
          cache.counts.skaters = cache.map.size;
        } catch (err) {
          cache.errors.push(`Music workbook read error: ${err.message}`);
        }
      }
    }

    if (quotesPath) {
      if (!quotesMtime) {
        cache.errors.push(`Quotes workbook not found: ${quotesPath}`);
      } else {
        try {
          let quoteCount = 0;
          for (const row of readSheetRows(quotesPath)) {
            const entry = entryFor(
              headerValue(row, 'first name'),
              headerValue(row, 'last name')
            );
            if (!entry) continue;
            const quote = headerValue(row, 'quote');
            if (quote) { entry.quote = cleanQuote(quote); quoteCount++; }
          }
          cache.counts.quotes = quoteCount;
        } catch (err) {
          cache.errors.push(`Quotes workbook read error: ${err.message}`);
        }
      }
    }

    if (coachesPath) {
      if (!coachesMtime) {
        cache.errors.push(`Coaches workbook not found: ${coachesPath}`);
      } else {
        try {
          let coachCount = 0;
          for (const row of readSheetRows(coachesPath)) {
            const entry = entryFor(
              headerValue(row, 'first name'),
              headerValue(row, 'last name')
            );
            if (!entry) continue;
            const coaches = headerValue(row, 'coach');
            if (coaches) {
              // Tidy separator spacing, then fix lowercase-typed names
              // ("yvan desjardins" → "Yvan Desjardins") without touching
              // connectors, particles, or intentional caps.
              entry.coaches = capNameWords(
                coaches.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
              );
              coachCount++;
            }
          }
          cache.counts.coaches = coachCount;
        } catch (err) {
          cache.errors.push(`Coaches workbook read error: ${err.message}`);
        }
      }
    }

    if (cache.errors.length) {
      cache.errors.forEach(e => console.warn('[skater-extras]', e));
    } else if (cache.map.size) {
      console.log(`[skater-extras] loaded ${cache.counts.skaters} skaters, ${cache.counts.quotes} quotes, ${cache.counts.coaches} coach lists`);
    }
  }

  /**
   * Look up extras for an API competitor name. Pairs/dance teams arrive as
   * "Name A / Name B" — falls back to matching either partner.
   * Returns { quote, shortMusic, freeMusic } or null.
   */
  function lookup(apiName) {
    try { ensureLoaded(); } catch (err) {
      console.warn('[skater-extras] load error:', err.message);
      return null;
    }
    if (!cache.map.size) return null;
    const full = normName(apiName);
    if (cache.map.has(full)) return cache.map.get(full);
    for (const part of String(apiName || '').split(/[\/&]/)) {
      const p = normName(part);
      if (p && cache.map.has(p)) return cache.map.get(p);
    }
    return null;
  }

  /** Pick the right program's music for the active segment name. */
  function musicForSegment(extras, segmentName) {
    if (!extras) return '';
    const seg = String(segmentName || '').toLowerCase();
    if (/short|rhythm/.test(seg)) return extras.shortMusic;
    if (/free|libre/.test(seg)) return extras.freeMusic;
    return extras.shortMusic || extras.freeMusic;
  }

  function status() {
    try { ensureLoaded(); } catch { /* reported via errors */ }
    return {
      settings: settings(),
      musicPath: cache.musicPath || '',
      quotesPath: cache.quotesPath || '',
      coachesPath: cache.coachesPath || '',
      skaters: cache.counts.skaters,
      quotes: cache.counts.quotes,
      coaches: cache.counts.coaches || 0,
      errors: cache.errors,
    };
  }

  return { lookup, musicForSegment, status };
}

module.exports = { createSkaterExtrasService, smartTitleCase, cleanQuote, capNameWords };
