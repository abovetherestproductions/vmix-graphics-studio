'use strict';

/**
 * Skate Canada's bilingual glossary writes French category names one way:
 *
 *   Hommes / Femmes   → the level follows in lower case and agrees in number:
 *                       "Hommes pré-novices", "Femmes seniors"
 *   Danse sur glace,
 *   Patinage en couple,
 *   Patinage synchronisé → the level is lower case and singular:
 *                       "Danse sur glace junior", "Patinage en couple senior"
 *
 * The API (and the older feeds) send "Hommes Pré-novice" and "Femmes Senior",
 * so the category goes through here on its way out. Anything that does not
 * start with one of those disciplines followed by a level is returned as it
 * came - "Pré-juvénile" on its own, a custom name, an English string - and the
 * rule is idempotent, so text that is already in the glossary's form is
 * unchanged. Whatever follows the level ("Groupe A") is kept.
 */

const GENDERED = '(hommes|femmes)';
const LEVELS_GENDERED = '(pr[ée]-?novice|novice|junior|senior)';
const DISCIPLINES = '(danse sur glace|patinage en couple|patinage synchronis[ée])';
const LEVELS_OTHER = '(pr[ée]-?novice|novice|junior|senior|interm[ée]diaire|ouvert)';

// The API sends dance and pairs categories as a bare level, and the app adds the
// discipline after a dash: "Pré-novice — Danse sur glace". The glossary puts
// the discipline first.
const TRAILING_DISCIPLINE_RE =
  new RegExp(`^${LEVELS_OTHER}\\s+[\u2014\u2013-]\\s+${DISCIPLINES}(.*)$`, 'i');

const GENDERED_RE = new RegExp(`^${GENDERED}\\s+${LEVELS_GENDERED}s?(?=\\s|$)(.*)$`, 'i');
const OTHER_RE    = new RegExp(`^${DISCIPLINES}\\s+${LEVELS_OTHER}s?(?=\\s|$)(.*)$`, 'i');

const capitalised = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function discipline(phrase) {
  return capitalised(phrase).replace(/synchronise$/, 'synchronisé');
}

function level(word) {
  const w = word.toLowerCase();
  return /^pr[ée]-?novice$/.test(w) ? 'pré-novice' : w.replace('intermediaire', 'intermédiaire');
}

function frenchLevelStyle(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return text;
  let m = s.match(GENDERED_RE);
  if (m) return `${capitalised(m[1])} ${level(m[2])}s${m[3]}`;
  m = s.match(OTHER_RE);
  if (m) return `${discipline(m[1])} ${level(m[2])}${m[3]}`;
  m = s.match(TRAILING_DISCIPLINE_RE);
  if (m) return `${discipline(m[2])} ${level(m[1])}${m[3]}`;
  return text;
}

module.exports = { frenchLevelStyle };
