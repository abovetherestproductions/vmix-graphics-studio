'use strict';

/**
 * ISU practice-event data source ("isu-db" mode).
 *
 * Reads the standalone profile-database service (a small Python app that owns
 * the event roster, editorial overrides, and the start-order desk) and writes
 * the same JSON payload files every other data source writes. The graphics
 * themselves are unchanged and unaware.
 *
 * Why this exists: international events run by the ISU give us no scoring
 * feed, so the Skate Canada CSS path has nothing to talk to. We cover the
 * practice sessions instead - start order, skater name bar, skater profile -
 * and the profile database supplies all three.
 *
 * DELIBERATELY NARROW. This mode feeds three templates and nothing else.
 * There is no scoring, ranking, element, or officials source at an ISU
 * practice, so those templates are blanked on activation rather than left
 * showing whatever the last Skate Canada event put in them.
 *
 * Division of labour with the profile desk:
 *   - The desk owns the start order. Whichever board it has published is the
 *     one we show; we never pick a category or segment ourselves. Two things
 *     choosing what is live is how you end up with the wrong board on air.
 *   - We own athlete selection during a session, because that is the part
 *     under airtime pressure. We mirror it back to the desk afterwards so its
 *     own preview and any directly-bound vMix titles follow along.
 *
 * Read once a year, most likely in a hurry, so it is written to be obvious
 * rather than clever.
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const { fetchJson } = require('../../normalizers');
const newApi = require('../../normalizers/skate-canada-new-api');

// Portraits are copied here so the browser source only ever talks to our own
// server. The profile desk can then sleep, move, or change address mid-session
// without taking an image off air.
const PORTRAIT_DIR      = path.join(__dirname, '..', '..', 'public', 'assets', 'portraits');
const PORTRAIT_URL_BASE = '/assets/portraits';
const FLAG_DIR          = path.join(__dirname, '..', '..', 'public', 'assets', 'flags');
const FLAG_URL_BASE     = '/assets/flags';

// Templates this mode has no source for. See blankUnfedTemplates().
const UNFED_TEMPLATES = ['scoring', 'rankings', 'standings', 'elements', 'officials'];

// The database is an international entry list, so categories are the four ISU
// disciplines rather than Skate Canada's level names. Segment names go through
// the shared translator, which already knows them.
const CATEGORY_FR = {
  'Men':       'Hommes',
  'Women':     'Femmes',
  'Pairs':     'Couples',
  'Ice Dance': 'Danse sur glace',
};

/**
 * What goes on air as the header.
 *
 * The desk's boards are per segment because they are built from the
 * competition start order, but a practice session is not a segment: skaters
 * run whichever program they feel like, so "Short Program" over a practice
 * would be wrong as often as right. The session is named for the discipline
 * instead, and the segment becomes simply "Practice".
 *
 * That also gives the recording sorter a sane folder - "Men Practice" rather
 * than "Men Short" - since it builds the folder from category plus segment.
 *
 * If this mode is ever pointed at a real competition segment, this is the one
 * place to undo: pass the board's own segment through instead.
 */
const PRACTICE_TITLE = {
  'Men':       { en: "Men's Practice",     fr: 'Entraînement hommes' },
  'Women':     { en: "Women's Practice",   fr: 'Entraînement femmes' },
  'Pairs':     { en: 'Pairs Practice',     fr: 'Entraînement couples' },
  'Ice Dance': { en: 'Ice Dance Practice', fr: 'Entraînement danse sur glace' },
};
const PRACTICE_SEGMENT_EN = 'Practice';
const PRACTICE_SEGMENT_FR = 'Entraînement';

function practiceTitle(category, lang) {
  const named = PRACTICE_TITLE[String(category || '').trim()];
  if (named) return lang === 'fr' ? named.fr : named.en;
  const cat = String(category || '').trim();
  if (!cat) return lang === 'fr' ? PRACTICE_SEGMENT_FR : PRACTICE_SEGMENT_EN;
  return lang === 'fr' ? `${PRACTICE_SEGMENT_FR} ${cat.toLowerCase()}` : `${cat} Practice`;
}

function createIsuDbService({ getConfig, readData, writeAndBroadcast, applyEventInfoPatch, logger }) {

  let pollTimer      = null;
  let pollGeneration = 0;          // invalidates in-flight polls after stop()
  let rosterCache    = { rows: [], fetchedAt: 0 };
  const portraitsInFlight = new Set();
  let flagSet = null;

  // ── Config ────────────────────────────────────────────────────────────────

  function isuCfg() {
    return getConfig().dataSource?.isuDb || {};
  }

  function baseUrl() {
    return String(isuCfg().baseUrl || 'http://127.0.0.1:8766').replace(/\/$/, '');
  }

  function apiUrl(pathname) {
    return `${baseUrl()}${pathname}`;
  }

  function pollIntervalMs() {
    return Math.max(1000, Number(isuCfg().pollIntervalMs) || 3000);
  }

  // ── Fetch helpers ─────────────────────────────────────────────────────────

  /**
   * The database's JSON feeds come back either as a bare array or wrapped as
   * { Profiles: [...] }, depending on the endpoint. Accept both rather than
   * depending on which one a given feed happens to use.
   */
  function rowsFrom(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.Profiles)) return payload.Profiles;
    if (payload && typeof payload === 'object') {
      const firstArray = Object.values(payload).find(Array.isArray);
      if (firstArray) return firstArray;
    }
    return [];
  }

  async function fetchRows(pathname) {
    return rowsFrom(await fetchJson(apiUrl(pathname)));
  }

  function download(url, destPath, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, res => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return download(new URL(res.headers.location, url).toString(), destPath, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        // Write to a .part file and rename, so a half-downloaded image is
        // never served or mistaken for a complete cache entry.
        const tmp = `${destPath}.part`;
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          try { fs.renameSync(tmp, destPath); resolve(destPath); }
          catch (err) { reject(err); }
        }));
        out.on('error', err => { try { fs.unlinkSync(tmp); } catch {} reject(err); });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('portrait download timed out')));
    });
  }

  // ── Assets ────────────────────────────────────────────────────────────────

  function flagUrlFor(countryCode) {
    const code = String(countryCode || '').trim().toUpperCase();
    if (!code) return '';
    if (!flagSet) {
      try {
        flagSet = new Set(fs.readdirSync(FLAG_DIR)
          .filter(f => f.toLowerCase().endsWith('.png'))
          .map(f => f.slice(0, -4).toUpperCase()));
      } catch {
        flagSet = new Set();
      }
    }
    return flagSet.has(code) ? `${FLAG_URL_BASE}/${code}.png` : '';
  }

  /**
   * Turn one of the database's absolute portrait URLs into a URL on OUR server,
   * downloading it the first time we see it.
   *
   * Returns the local URL immediately even when the download is still running:
   * the miss only costs one skater one broken image once, the cache is warmed
   * by the poll loop long before an operator selects anybody, and blocking a
   * graphic write on an image fetch is the worse trade.
   */
  function localPortraitUrl(sourceUrl) {
    const src = String(sourceUrl || '').trim();
    if (!src) return '';

    let fileName;
    try {
      fileName = path.basename(new URL(src).pathname);
    } catch {
      return ''; // not a URL we can make sense of
    }
    if (!fileName || !/\.(jpe?g|png|webp)$/i.test(fileName)) return '';
    fileName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');

    const dest      = path.join(PORTRAIT_DIR, fileName);
    const publicUrl = `${PORTRAIT_URL_BASE}/${fileName}`;

    if (fs.existsSync(dest)) return publicUrl;

    if (!portraitsInFlight.has(fileName)) {
      portraitsInFlight.add(fileName);
      fs.promises.mkdir(PORTRAIT_DIR, { recursive: true })
        .then(() => download(src, dest))
        .catch(err => console.warn(`[isu-db] portrait ${fileName}: ${err.message}`))
        .finally(() => portraitsInFlight.delete(fileName));
    }
    return publicUrl;
  }

  function warmPortraitCache(rows) {
    for (const r of rows) {
      localPortraitUrl(r.Skater1PortraitAsset);
      localPortraitUrl(r.Skater2PortraitAsset);
    }
  }

  // ── Row mapping ───────────────────────────────────────────────────────────

  const str = v => (v == null ? '' : String(v).trim());

  function categoryFr(category) {
    const c = str(category);
    return CATEGORY_FR[c] || c;
  }

  /**
   * One start-order row in the shape the starting-order graphic already reads.
   * Country stands in for club: at an international event the second line is
   * the country, and the recording sorter reads the same field.
   */
  function toStartingOrderRow(r) {
    return {
      position:    Number(r.StartNumber) || null,
      name:        str(r.Name),
      club:        str(r.Country),
      section:     str(r.CountryCode),
      flagUrl:     flagUrlFor(r.CountryCode),
      status:      '',                       // practice sessions are not scored
      entryId:     str(r.EntryID),
      warmUpGroup: Number(r.WarmupGroup) || 1,
    };
  }

  function buildStartingOrderPayload(feedRows, existingControl, requestedGroup) {
    const rowsByGroup = new Map();
    for (const r of feedRows) {
      const g = Number(r.WarmupGroup) || 1;
      if (!rowsByGroup.has(g)) rowsByGroup.set(g, []);
      rowsByGroup.get(g).push(r);
    }

    const availableGroups = [...rowsByGroup.keys()].sort((a, b) => a - b);
    const targetGroup = (requestedGroup && availableGroups.includes(Number(requestedGroup)))
      ? Number(requestedGroup)
      : (availableGroups[0] ?? 1);

    const bySortOrder = (a, b) => (Number(a.StartNumber) || 0) - (Number(b.StartNumber) || 0);

    const rows = (rowsByGroup.get(targetGroup) || []).slice().sort(bySortOrder).map(toStartingOrderRow);

    const allRows = [];
    for (const g of availableGroups) {
      rowsByGroup.get(g).slice().sort(bySortOrder).forEach(r => allRows.push(toStartingOrderRow(r)));
    }

    // The category comes off the feed rows themselves - the desk owns which
    // board is published, so the rows are the authority on what it is. The
    // board's segment is deliberately NOT aired; see PRACTICE_TITLE.
    const first   = feedRows[0] || {};
    const catName = str(first.Category);
    const lang    = getConfig().language === 'fr' ? 'fr' : 'en';
    const titleEn = practiceTitle(catName, 'en');
    const titleFr = practiceTitle(catName, 'fr');

    return {
      meta:    { template: 'starting-order', revision: Date.now(), updatedAt: new Date().toISOString() },
      control: existingControl ? { ...existingControl } : { visible: false, state: 'hidden' },
      data: {
        title:          lang === 'fr' ? titleFr : titleEn,
        titleEn,
        titleFr,
        // The session name goes on air as the CATEGORY, with no segment
        // beside it. That is not a trick: for a practice, "Men's Practice"
        // is the whole answer to "what is this", and the header's automatic
        // mode composes its title from category plus segment. Leaving the
        // segment blank makes it render the session name alone, correctly
        // for all four disciplines in both languages, with no change to the
        // shared header code. (Passing "Men" here would not work - the
        // header cleans bare discipline words out of category names, so
        // Men, Women and Pairs would vanish and leave a naked "Practice",
        // while Ice Dance survived. That inconsistency is what this avoids.)
        categoryName:   titleEn,
        categoryNameFr: titleFr,
        segmentName:    '',
        segmentNameFr:  '',
        // Not aired. The discipline on its own, and the board the desk
        // actually published - the operator page shows the latter so you can
        // confirm you are on the right one, and pollOnce() uses the former
        // for the recording folder.
        discipline:     catName,
        boardSegment:   str(first.Segment),
        subtitle:       '',
        groupNumber:    targetGroup,
        groupCount:     availableGroups.length,
        availableGroups,
        rowCount:       rows.length,
        rows,
        allRows,
      },
    };
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  /**
   * One pass: read the published board and write the starting-order graphic.
   *
   * An empty feed is meaningful, not a failure - the desk's "Clear order feed"
   * button produces exactly that - so it blanks the graphic rather than
   * leaving the previous board up.
   */
  async function pollOnce() {
    const myGen = pollGeneration;
    const feedRows = await fetchRows('/feeds/start-order.json');
    if (myGen !== pollGeneration) return null;

    const existing = readData('starting-order');
    const payload  = buildStartingOrderPayload(
      feedRows,
      existing?.control,
      existing?.data?.groupNumber,
    );
    writeAndBroadcast('starting-order', payload);

    // Push the board's category and segment into event config, the same way
    // the Skate Canada path does. This is what the graphics headers read, and
    // what the recording sorter derives its folder from - without it a
    // practice session would record into a folder named after whatever event
    // ran here last. Doing it from the poll loop means republishing a
    // different board on the desk moves everything with it.
    if (typeof applyEventInfoPatch === 'function' && payload.data.discipline) {
      // Deliberately the discipline and "Practice" as separate pieces, not
      // the aired title: the sorter joins them into the folder name, giving
      // "Men Practice" rather than "Men's Practice" with its apostrophe.
      applyEventInfoPatch({
        categoryName:   payload.data.discipline,
        categoryNameFr: categoryFr(payload.data.discipline),
        segmentName:    PRACTICE_SEGMENT_EN,
        segmentNameFr:  PRACTICE_SEGMENT_FR,
      });
    }

    // Warm the image cache for everyone on the board so a selection later is
    // instant. Fire-and-forget by design.
    warmPortraitCache(feedRows);

    return payload;
  }

  function start() {
    stop();
    pollOnce().catch(err => console.warn('[isu-db] first poll:', err.message));
    pollTimer = setInterval(() => {
      pollOnce().catch(err => console.warn('[isu-db] poll:', err.message));
    }, pollIntervalMs());
    if (logger?.log) logger.log('isu-db polling started', { baseUrl: baseUrl(), intervalMs: pollIntervalMs() });
  }

  function stop() {
    pollGeneration++;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function isActive() {
    return !!pollTimer;
  }

  // ── Roster and selection ──────────────────────────────────────────────────

  async function getRoster({ maxAgeMs = 60000 } = {}) {
    if (rosterCache.rows.length && Date.now() - rosterCache.fetchedAt < maxAgeMs) {
      return rosterCache.rows;
    }
    const rows = rowsFrom(await fetchJson(apiUrl('/api/entries')));
    rosterCache = { rows, fetchedAt: Date.now() };
    warmPortraitCache(rows);
    return rows;
  }

  async function findEntry(entryId) {
    const wanted = str(entryId);
    const roster = await getRoster();
    return roster.find(r => str(r.EntryID) === wanted) || null;
  }

  /**
   * Program music for the name bar's slide-down card.
   *
   * Blank during practice, on purpose. The database holds a short and a free
   * title per athlete, and in a practice session there is no way to know
   * which one a skater is about to run - they choose. Naming the wrong piece
   * on air is worse than naming none, and the card falls back to the category
   * line when this is empty.
   *
   * If a real segment is ever aired through this mode, the pairing is: short
   * program and rhythm dance read ShortMusic, free skate and free dance read
   * FreeMusic.
   */
  function musicForSegment(entry, segmentName) {
    if (!segmentName || segmentName === PRACTICE_SEGMENT_EN) return '';
    const isShort = /\b(short|rhythm)\b/i.test(segmentName);
    return isShort ? str(entry.ShortMusic) : str(entry.FreeMusic);
  }

  /**
   * Everything the name bar and the profile graphic need for one athlete.
   * Called when the operator picks somebody; server.js turns it into the two
   * payloads and writes them.
   */
  async function buildSkaterData(entryId) {
    const entry = await findEntry(entryId);
    if (!entry) throw new Error(`Unknown EntryID: ${entryId}`);

    // Start number and segment come from the published board when the athlete
    // is on it. A skater called up out of order still gets a correct bar, just
    // without a start number.
    const board     = readData('starting-order')?.data?.allRows || [];
    const boardRow  = board.find(r => str(r.entryId) === str(entryId)) || null;
    const boardData = readData('starting-order')?.data || {};

    // The bar's detail card reads the same as the start-order header: the
    // session name, no segment beside it.
    const discipline   = str(entry.Category) || str(boardData.discipline);
    const categoryName = practiceTitle(discipline, 'en');

    return {
      entryId:        str(entry.EntryID),
      name:           str(entry.Name),
      club:           str(entry.Country),
      section:        str(entry.CountryCode),
      flagUrl:        flagUrlFor(entry.CountryCode),
      categoryName,
      categoryNameFr: practiceTitle(discipline, 'fr'),
      segmentName:    '',
      segmentNameFr:  '',
      discipline,
      groupNumber:    boardRow?.warmUpGroup ?? null,
      startNumber:    boardRow?.position ?? null,
      coaches:        str(entry.Coach),
      musicTitle:     musicForSegment(entry, ''),
      // Teams carry a second athlete; the profile graphic uses the presence of
      // photoUrl2 to decide between a one- and two-portrait layout.
      photoUrl:       localPortraitUrl(entry.Skater1PortraitAsset),
      photoUrl2:      str(entry.Skater2Name) ? localPortraitUrl(entry.Skater2PortraitAsset) : '',
      skater1Name:    str(entry.Skater1Name),
      skater2Name:    str(entry.Skater2Name),
      personalBest:   str(entry.PBTotal),
      seasonBest:     str(entry.SBTotal),
      isTeam:         !!str(entry.Skater2Name),
    };
  }

  /**
   * Mirror our selection back to the profile desk so its preview and any
   * directly-bound vMix titles follow what is on air. Deliberately
   * fire-and-forget: the graphic is already up by the time this runs, and the
   * desk being asleep must never break a push.
   */
  function mirrorSelection(entryId) {
    return new Promise(resolve => {
      const body = JSON.stringify({ entry_id: entryId });
      let target;
      try { target = new URL(apiUrl('/api/selection')); } catch { return resolve(false); }
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.request(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
      req.on('error', () => resolve(false));
      req.setTimeout(4000, () => { req.destroy(); resolve(false); });
      req.end(body);
    });
  }

  // ── Connection check and housekeeping ─────────────────────────────────────

  /**
   * What the operator page shows after Connect. Proves we are pointed at a
   * live database and says which board it has published, which is the part
   * most likely to be wrong.
   *
   * baseUrlOverride lets the page test an address before anything is saved,
   * so a typo fails on its own rather than switching the app into a mode
   * pointed at nothing.
   */
  async function getStatus({ baseUrlOverride } = {}) {
    const root = baseUrlOverride
      ? String(baseUrlOverride).replace(/\/$/, '')
      : baseUrl();
    const at = pathname => `${root}${pathname}`;

    const status = await fetchJson(at('/api/status'));
    let board = null;
    try {
      const feedRows = rowsFrom(await fetchJson(at('/feeds/start-order.json')));
      if (feedRows.length) {
        const groups = new Set(feedRows.map(r => Number(r.WarmupGroup) || 1));
        board = {
          category: str(feedRows[0].Category),
          segment:  str(feedRows[0].Segment),
          rows:     feedRows.length,
          groups:   groups.size,
        };
      }
    } catch { /* a published board is optional; the connection is what matters */ }

    return {
      baseUrl:        root,
      entries:        status?.entries ?? null,
      athletes:       status?.athletes ?? null,
      selectedEntryId: status?.selected_entry_id ?? null,
      board,
    };
  }

  /**
   * Empty every template this mode cannot feed.
   *
   * Hiding them is not enough. A hidden graphic can still be taken up, and it
   * would come back carrying the last Skate Canada event's rows - a stale
   * leaderboard on air during an international practice. Values are emptied in
   * place rather than deleted so nothing downstream meets an undefined field.
   */
  function blankUnfedTemplates() {
    for (const template of UNFED_TEMPLATES) {
      const existing = readData(template);
      if (!existing?.data) continue;

      const data = {};
      for (const [key, value] of Object.entries(existing.data)) {
        if (Array.isArray(value))              data[key] = [];
        else if (typeof value === 'number')    data[key] = 0;
        else if (value && typeof value === 'object') data[key] = {};
        else if (typeof value === 'boolean')   data[key] = false;
        else                                   data[key] = '';
      }

      writeAndBroadcast(template, {
        meta:    { template, revision: Date.now(), updatedAt: new Date().toISOString() },
        control: { visible: false, state: 'hidden' },
        data,
      }, { force: true });
    }
    if (logger?.log) logger.log('isu-db blanked unfed templates', { templates: UNFED_TEMPLATES });
  }

  function invalidateRoster() {
    rosterCache = { rows: [], fetchedAt: 0 };
  }

  return {
    start, stop, isActive, pollOnce,
    getStatus, getRoster, findEntry, buildSkaterData,
    mirrorSelection, blankUnfedTemplates, invalidateRoster,
    baseUrl,
  };
}

module.exports = { createIsuDbService, UNFED_TEMPLATES };
