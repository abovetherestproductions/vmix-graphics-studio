'use strict';

/**
 * Skate Canada Public REST API polling service.
 *
 * Implements the third data source mode ("sc-api"), polling the new REST API
 * and writing the same JSON files the graphics already consume.
 *
 * Lifecycle: created once in server.js, start()/stop() called when the
 * operator switches modes or toggles polling.
 */

const { fetchJson } = require('../../normalizers');
const newApi = require('../../normalizers/skate-canada-new-api');

function createScApiService({
  getConfig,           // () => event-config object
  readData,            // (template) => payload | null
  writeAndBroadcast,   // (template, payload) => void
  applyEventInfoPatch, // (patch) => bool
  rankingsCache,       // { allRows, rowsPerPage } — shared ref from server.js
  logger,              // actionLogger (optional)
  onSkaterOnIce,       // (entry, segmentDto, categoryDto) => void — new skater detected on ice
  onSkaterLeftIce,     // (entries) => void — on-ice cleared; entries = full segment list for next-up lookup
  onSkaterElementsReady, // (entry, segmentDto, categoryDto) => void — elements confirmed for on-ice skater
}) {

  // ── Internal state ────────────────────────────────────────────────────────
  let pollTimer          = null;
  let _forceBroadcast    = false; // true on first poll after segment change
  let officialsPollTimer = null;
  let pollGeneration     = 0;
  let lastOnIceEntryId      = null;
  let lastElementsReadyId   = null; // guard: only fire onSkaterElementsReady once per skater
  // Score hold: which entry drives the SCORING graphic. When the next skater
  // goes on ice, the scoring bar stays pinned on the previous skater until
  // their segment score has posted AND the configured hold time has passed
  // (positions.scoring.scHoldSecs, default 30s). Prevents the just-skated
  // skater's score from vanishing the moment the DS activates the next one.
  let scoringHold = null; // { entryId, heldSince, scoreSeenAt }
  // Cross-segment totals: skaterId → summed score from the category's OTHER
  // segments (e.g. the SP score while polling the FP). Lets the scoring
  // graphic reveal the cumulative category total, which the entry DTO
  // doesn't carry. Prior segments are final, so a 5-minute cache is plenty.
  let priorScores = { key: null, bySkater: new Map(), fetchedAt: 0 };

  async function getPriorSegmentScores(categoryId, currentSegmentId) {
    const key = `${categoryId}|${currentSegmentId}`;
    const FRESH_MS = 5 * 60 * 1000;
    if (priorScores.key === key && Date.now() - priorScores.fetchedAt < FRESH_MS) {
      return priorScores.bySkater;
    }
    const segs = await fetchSegments(categoryId);
    const bySkater = new Map();
    for (const s of segs) {
      const sid = newApi.safeStr(s.segmentId);
      if (!sid || sid === currentSegmentId) continue;
      const ents = await fetchEntries(sid);
      for (const e of ents) {
        const sk = newApi.safeStr(e.skaterId || e.skatingCompetitorId);
        const sc = newApi.safeNum(e.score);
        if (sk && sc != null) bySkater.set(sk, (bySkater.get(sk) || 0) + sc);
      }
    }
    priorScores = { key, bySkater, fetchedAt: Date.now() };
    return bySkater;
  }
  // Cache segment/category DTOs so we don't fetch them every single poll tick
  let _segmentCache  = { id: null, dto: null };
  let _categoryCache = { id: null, dto: null };
  let _eventCache    = { id: null, dto: null };

  // ── Config helpers ────────────────────────────────────────────────────────

  function scCfg() {
    return getConfig().dataSource?.scApi || {};
  }

  function baseUrl() {
    return (scCfg().baseUrl || 'https://sc-css-public-api-cmh9d3htgxfpdkb7.canadacentral-01.azurewebsites.net').replace(/\/$/, '');
  }

  function apiUrl(path) { return `${baseUrl()}${path}`; }

  // ── Raw fetch helpers ─────────────────────────────────────────────────────

  async function fetchEvent(eventId) {
    const data = await fetchJson(apiUrl(`/event/${eventId}`));
    return data?.Event || data;
  }

  async function fetchCategories(eventId) {
    const data = await fetchJson(apiUrl(`/event/${eventId}/categories`));
    return data?.Categories || (Array.isArray(data) ? data : []);
  }

  async function fetchCategory(categoryId) {
    const data = await fetchJson(apiUrl(`/category/${categoryId}`));
    return data?.Category || data;
  }

  async function fetchSegments(categoryId) {
    const data = await fetchJson(apiUrl(`/category/${categoryId}/segments`));
    return data?.Segments || (Array.isArray(data) ? data : []);
  }

  async function fetchSegment(segmentId) {
    const data = await fetchJson(apiUrl(`/segment/${segmentId}`));
    return data?.Segment || data;
  }

  async function fetchEntries(segmentId) {
    const data = await fetchJson(apiUrl(`/segment/${segmentId}/entries`));
    return data?.CompetitorEntries || (Array.isArray(data) ? data : []);
  }

  async function fetchEntry(entryId) {
    const data = await fetchJson(apiUrl(`/entry/${entryId}`));
    return data?.CompetitorEntry || data;
  }

  // NOTE: ?latest=true makes the API return ONE element object (the most
  // recently entered), not the list — the live tracker needs the full list,
  // so callers should pass latest=false. The single-object shape is still
  // handled defensively in case anything asks for latest.
  async function fetchElements(entryId, latest = false) {
    const url = apiUrl(`/entry/${entryId}/elements${latest ? '?latest=true' : ''}`);
    const data = await fetchJson(url);
    if (data?.SkateElements) return data.SkateElements;
    if (Array.isArray(data)) return data;
    if (data && data.code !== undefined) return [data]; // single element (latest=true)
    return [];
  }

  async function fetchComponents(entryId) {
    const data = await fetchJson(apiUrl(`/entry/${entryId}/components`));
    return data?.Components || (Array.isArray(data) ? data : []);
  }

  async function fetchAdjustments(entryId) {
    const data = await fetchJson(apiUrl(`/entry/${entryId}/adjustments`));
    return Array.isArray(data) ? data : [];
  }

  async function fetchOfficials(segmentId) {
    const data = await fetchJson(apiUrl(`/segment/${segmentId}/officials`));
    return Array.isArray(data) ? data : (data?.OfficialAssignments || []);
  }

  // ── Cached DTO fetchers ───────────────────────────────────────────────────
  // These avoid hammering the API for stable reference data on every poll tick.

  async function getSegmentDto(segmentId) {
    if (_segmentCache.id === segmentId && _segmentCache.dto) return _segmentCache.dto;
    _segmentCache = { id: segmentId, dto: await fetchSegment(segmentId) };
    return _segmentCache.dto;
  }

  async function getCategoryDto(categoryId) {
    if (_categoryCache.id === categoryId && _categoryCache.dto) return _categoryCache.dto;
    _categoryCache = { id: categoryId, dto: await fetchCategory(categoryId) };
    return _categoryCache.dto;
  }

  async function getEventDto(eventId) {
    if (_eventCache.id === eventId && _eventCache.dto) return _eventCache.dto;
    _eventCache = { id: eventId, dto: await fetchEvent(eventId) };
    return _eventCache.dto;
  }

  function invalidateCache() {
    _segmentCache       = { id: null, dto: null };
    _categoryCache      = { id: null, dto: null };
    _eventCache         = { id: null, dto: null };
    lastOnIceEntryId    = null;
    lastElementsReadyId = null;
    scoringHold         = null;
    priorScores         = { key: null, bySkater: new Map(), fetchedAt: 0 };
  }

  // ── Main poll ─────────────────────────────────────────────────────────────

  async function pollOnce() {
    const cfg = scCfg();
    const { eventId, categoryId, segmentId } = cfg;
    if (!segmentId) return;

    const myGen = pollGeneration;

    try {
      // Entries are the live heartbeat — fetch every tick
      const entries = await fetchEntries(segmentId);
      if (myGen !== pollGeneration) return;

      // Segment and category DTOs are stable; use cache
      const [segmentDto, categoryDto] = await Promise.all([
        getSegmentDto(segmentId),
        categoryId ? getCategoryDto(categoryId) : Promise.resolve(null),
      ]);
      if (myGen !== pollGeneration) return;

      // The single-category endpoint often omits disciplineName even when the
      // browse list endpoint provides it. Patch from saved config so catEn()
      // can append "Pairs" / "Ice Dance" to bare level names like "Juvenile".
      if (categoryDto && !categoryDto.disciplineName && cfg.discipline) {
        categoryDto.disciplineName = cfg.discipline;
      }

      const lang = getConfig().language || 'en';
      const force = _forceBroadcast;
      _forceBroadcast = false;

      const existingSO   = readData('starting-order');
      const requestedGrp = existingSO?.data?.groupNumber || null;

      // Start order
      const soPayload = newApi.normalizeStartingOrder(
        entries, categoryDto, segmentDto, requestedGrp, lang, existingSO?.control
      );
      writeAndBroadcast('starting-order', soPayload, { force });

      // Prior-segment scores (cached 5 min) — cumulative category totals for
      // the Final Rankings, Rank 6 standings, and the scoring reveal.
      let priorBySkater = new Map();
      if (categoryId) {
        try {
          priorBySkater = await getPriorSegmentScores(categoryId, segmentId);
          if (myGen !== pollGeneration) return;
        } catch (err) {
          console.warn('[sc-api] prior-segment scores error:', err.message);
        }
      }

      // Full rankings — category standings with cumulative totals
      const existingRk  = readData('rankings');
      const rpp         = rankingsCache.rowsPerPage || existingRk?.data?.rowsPerPage || 6;
      const currentPage = existingRk?.data?.page || 1;
      const rkPayload   = newApi.normalizeRankings(
        entries, categoryDto, segmentDto, lang, rpp, currentPage, existingRk?.control, priorBySkater
      );
      writeAndBroadcast('rankings', rkPayload, { force });
      // Keep shared cache in sync so page controls work
      rankingsCache.allRows     = rkPayload.data.allRows || [];
      rankingsCache.rowsPerPage = rpp;

      // Rank-6 corner standings
      const existingSt = readData('standings');
      // Pivot on the scoring-hold skater (the one who just skated / was just
      // scored) so the Rank 6 context always frames THEIR placement.
      const stPayload  = newApi.normalizeStandings(
        entries, categoryDto, segmentDto, lang, existingSt?.control, scoringHold?.entryId, priorBySkater
      );
      writeAndBroadcast('standings', stPayload, { force });

      // Segment-wide Highest TES benchmark — official per-skater TES straight
      // from the entries feed. Excludes the on-ice skater (their TES isn't
      // final), so the row can appear as soon as the FIRST skater's score is
      // posted, and it resets automatically when the segment changes because
      // it's recomputed from the new segment's entries every poll.
      let highestTes = 0, highestTesName = '', scoredCount = 0;
      for (const e of entries) {
        if (e.onice) continue;
        const t = newApi.safeNum(e.tes);
        if (t == null || t <= 0) continue;
        scoredCount++;
        if (t > highestTes) { highestTes = t; highestTesName = newApi.safeStr(e.competitorName); }
      }
      const segmentStats = {
        highestTes: Math.round(highestTes * 100) / 100,
        highestTesName,
        scoredCount,
      };

      // On-ice skater → scoring, lower-third, elements
      const onIce      = entries.find(e => e.onice);
      const prevOnIceId = lastOnIceEntryId;

      // ── Score hold: pick which entry drives the scoring graphic ─────────
      // Stays on the previous skater until their score posts + hold time,
      // and keeps updating them in the gap when nobody is on ice (scores
      // usually post after the skater has left the ice).
      const holdSecsCfg = Number(getConfig().positions?.scoring?.scHoldSecs);
      const holdMs      = (holdSecsCfg > 0 ? holdSecsCfg : 30) * 1000;
      const MAX_HOLD_MS = 5 * 60 * 1000; // safety cap when a score never posts (WD etc.)
      const onIceIdNow  = onIce ? newApi.safeStr(onIce.competitorEntryId) : null;

      if (scoringHold) {
        const held     = entries.find(e => newApi.safeStr(e.competitorEntryId) === scoringHold.entryId);
        const scoreVal = held ? newApi.safeNum(held.score) : null;
        if (scoreVal != null && !scoringHold.scoreSeenAt) scoringHold.scoreSeenAt = Date.now();
        const expired = !held || (scoringHold.scoreSeenAt
          ? Date.now() - scoringHold.scoreSeenAt > holdMs
          : Date.now() - scoringHold.heldSince   > MAX_HOLD_MS);
        if (expired && onIceIdNow && onIceIdNow !== scoringHold.entryId) {
          scoringHold = { entryId: onIceIdNow, heldSince: Date.now(), scoreSeenAt: null };
        }
      }
      if (!scoringHold && onIceIdNow) {
        scoringHold = { entryId: onIceIdNow, heldSince: Date.now(), scoreSeenAt: null };
      }
      const scoringEntry = scoringHold
        ? entries.find(e => newApi.safeStr(e.competitorEntryId) === scoringHold.entryId) || onIce
        : onIce;

      if (scoringEntry) {
        // Cumulative category total = this segment's score + the skater's
        // scores from the category's earlier segments (priorBySkater, cached).
        let catTotal = null;
        const segScore = newApi.safeNum(scoringEntry.score);
        if (segScore != null) {
          const sk = newApi.safeStr(scoringEntry.skaterId || scoringEntry.skatingCompetitorId);
          const priorSum = sk ? (priorBySkater.get(sk) || 0) : 0;
          if (priorSum > 0) catTotal = Math.round((priorSum + segScore) * 100) / 100;
        }

        const existingSc = readData('scoring');
        const scPayload  = newApi.normalizeScoring(
          scoringEntry, [], [], categoryDto, segmentDto, lang, existingSc?.control, catTotal
        );
        if (scPayload) writeAndBroadcast('scoring', scPayload);
      }

      if (onIce) {
        const onIceId      = newApi.safeStr(onIce.competitorEntryId);
        const onIceChanged = onIceId !== lastOnIceEntryId;
        lastOnIceEntryId   = onIceId;

        if (onIceChanged && typeof onSkaterOnIce === 'function') {
          try { onSkaterOnIce(onIce, segmentDto, categoryDto); } catch (e) { /* non-fatal */ }
        }

        const existingLt = readData('lower-third');
        const ltPayload  = newApi.normalizeLowerThird(
          onIce, categoryDto, segmentDto, existingLt?.control
        );
        if (ltPayload) writeAndBroadcast('lower-third', ltPayload);

        // Elements: fetch EVERY poll while a skater is on ice, so the tracker
        // updates live as the tech panel enters/adjusts elements. (It used to
        // fetch only when the skater changed — the panel froze mid-program in
        // sc-api mode.) writeAndBroadcast skips identical data, so unchanged
        // polls cost nothing downstream.
        try {
          const elements = await fetchElements(onIceId, false);
          if (myGen !== pollGeneration) return;
          const existingEl = readData('elements');
          const elPayload  = newApi.normalizeElements(
            elements, onIce, categoryDto, segmentDto, existingEl?.control, segmentStats
          );
          writeAndBroadcast('elements', elPayload);

          // Fire elements-ready callback once per skater — this is the
          // verified signal used by auto-record to confirm the correct filename.
          if (onIceId !== lastElementsReadyId && typeof onSkaterElementsReady === 'function') {
            lastElementsReadyId = onIceId;
            try { onSkaterElementsReady(onIce, segmentDto, categoryDto); } catch (e) { /* non-fatal */ }
          }
        } catch (err) {
          console.warn('[sc-api] elements fetch error:', err.message);
        }

      } else {
        // No one on ice — fire left-ice callback if someone was previously on ice
        if (prevOnIceId) {
          lastOnIceEntryId = null;
          if (typeof onSkaterLeftIce === 'function') {
            try { onSkaterLeftIce(entries); } catch (e) { /* non-fatal */ }
          }
        }
        // Keep the benchmark fresh between skaters — a final score usually
        // posts after the skater has left the ice, and the next skater may
        // not step on for a while.
        const existingEl = readData('elements');
        if (existingEl?.data && (
          existingEl.data.highestTes !== segmentStats.highestTes ||
          existingEl.data.scoredCount !== segmentStats.scoredCount
        )) {
          const patched = { ...existingEl, data: { ...existingEl.data, ...segmentStats } };
          writeAndBroadcast('elements', patched);
        }
      }

      // Event info → patch event-config category/segment fields
      if (eventId) {
        try {
          const eventDto = await getEventDto(eventId);
          if (myGen !== pollGeneration) return;
          const info = newApi.normalizeEventInfo(eventDto, categoryDto, segmentDto);
          applyEventInfoPatch(info);
        } catch (err) {
          console.warn('[sc-api] event info patch error:', err.message);
        }
      }

    } catch (err) {
      if (myGen !== pollGeneration) return;
      console.warn('[sc-api] poll error:', err.message);
    }
  }

  async function pollOfficials() {
    const cfg = scCfg();
    const { categoryId, segmentId } = cfg;
    if (!segmentId) return;

    const myGen = pollGeneration;
    try {
      const [officials, segmentDto, categoryDto] = await Promise.all([
        fetchOfficials(segmentId),
        getSegmentDto(segmentId),
        categoryId ? getCategoryDto(categoryId) : Promise.resolve(null),
      ]);
      if (myGen !== pollGeneration) return;
      if (categoryDto && !categoryDto.disciplineName && cfg.discipline) {
        categoryDto.disciplineName = cfg.discipline;
      }
      const lang      = getConfig().language || 'en';
      const existing  = readData('officials');
      const payload   = newApi.normalizeOfficials(officials, categoryDto, segmentDto, lang, existing?.control);
      writeAndBroadcast('officials', payload, { force: _forceBroadcast });
      _forceBroadcast = false;
    } catch (err) {
      if (myGen !== pollGeneration) return;
      console.warn('[sc-api] officials poll error:', err.message);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function start() {
    stop();
    invalidateCache();
    const cfg      = scCfg();
    const pollMs   = Math.max(1000, Number(cfg.pollIntervalMs)          || 2000);
    const officMs  = Math.max(5000, Number(cfg.officialsPollIntervalMs) || 30000);

    if (!cfg.segmentId) {
      console.log('[sc-api] no segment selected — polling deferred until segment is chosen');
      return;
    }

    console.log(`[sc-api] starting — segment: ${cfg.segmentId}, entries: ${pollMs}ms, officials: ${officMs}ms`);

    _forceBroadcast     = true; // first poll after segment change always broadcasts
    pollTimer           = setInterval(() => pollOnce(),     pollMs);
    officialsPollTimer  = setInterval(() => pollOfficials(), officMs);
    pollOnce();      // immediate first tick
    pollOfficials();
  }

  function stop() {
    if (pollTimer)          { clearInterval(pollTimer);          pollTimer          = null; }
    if (officialsPollTimer) { clearInterval(officialsPollTimer); officialsPollTimer = null; }
    pollGeneration++;
    console.log('[sc-api] stopped');
  }

  function isActive() { return !!pollTimer; }

  // ── Operator browse helpers ───────────────────────────────────────────────
  // These are called by operator UI API routes, not by the polling loop.

  async function browseEvent(eventId) {
    const [eventDto, categories] = await Promise.all([
      fetchEvent(eventId),
      fetchCategories(eventId),
    ]);
    return {
      event: {
        id:       newApi.safeStr(eventDto?.eventId),
        name:     newApi.safeStr(eventDto?.EventName),
        nameFr:   newApi.safeStr(eventDto?.eventFrenchName),
        location: newApi.safeStr(eventDto?.eventLocation),
        startDate: eventDto?.startDate || null,
        endDate:   eventDto?.endDate   || null,
        inProgress: !!eventDto?.isEventInProgress,
      },
      categories: categories.map(c => ({
        id:       newApi.safeStr(c.categoryId),
        name:     newApi.safeStr(c.skatingcategorydefinitions?.name || c.categoryName || c.disciplineName),
        nameFr:   newApi.safeStr(c.skatingcategorydefinitions?.nameFr || c.categoryFrenchDescription || c.programFrenchName || c.skatingcategorydefinitions?.name || c.categoryName),
        discipline: newApi.safeStr(c.disciplineName),
        sortOrder:  c.sortOrder ?? 999,
      })).sort((a, b) => a.sortOrder - b.sortOrder),
    };
  }

  async function browseCategory(categoryId) {
    const segments = await fetchSegments(categoryId);
    return {
      segments: segments.map(s => ({
        id:         newApi.safeStr(s.segmentId),
        name:       newApi.safeStr(s.segmentName),
        nameFr:     newApi.safeStr(s.segmentFrenchName),
        status:     newApi.safeStr(s.segmentStatus),
        inProgress: !!s.isSegmentInProgress,
        startDate:  s.startDateTime || null,
        order:      s.performanceOrder ?? 999,
        rink:       newApi.safeStr(s.segmentRink),
      })).sort((a, b) => a.order - b.order),
    };
  }

  // Rink map for an event: which rinks exist, and which rinks each category's
  // segments run on. Requires one segment fetch per category, so results are
  // cached — rink assignments don't change mid-event.
  const rinksCache = new Map(); // eventId -> { at, promise }
  const RINKS_CACHE_MS = 10 * 60 * 1000;

  function browseEventRinks(eventId) {
    const hit = rinksCache.get(eventId);
    if (hit && Date.now() - hit.at < RINKS_CACHE_MS) return hit.promise;
    const promise = buildEventRinks(eventId).catch(err => {
      rinksCache.delete(eventId);
      throw err;
    });
    rinksCache.set(eventId, { at: Date.now(), promise });
    return promise;
  }

  async function buildEventRinks(eventId) {
    const categories = await fetchCategories(eventId);
    const categoryRinks = {};
    const rinkSet = new Set();
    const BATCH = 8; // polite parallelism against the public API
    for (let i = 0; i < categories.length; i += BATCH) {
      await Promise.all(categories.slice(i, i + BATCH).map(async c => {
        const catId = newApi.safeStr(c.categoryId);
        try {
          const segments = await fetchSegments(catId);
          const rinks = [...new Set(segments.map(s => newApi.safeStr(s.segmentRink)).filter(Boolean))];
          categoryRinks[catId] = rinks;
          rinks.forEach(r => rinkSet.add(r));
        } catch {
          categoryRinks[catId] = [];
        }
      }));
    }
    return { rinks: [...rinkSet].sort(), categoryRinks };
  }

  async function browseSegment(segmentId) {
    const entries = await fetchEntries(segmentId);
    return {
      entries: entries.map(e => ({
        id:       newApi.safeStr(e.competitorEntryId),
        name:     newApi.safeStr(e.competitorName),
        club:     newApi.entryClub(e),
        section:  newApi.safeStr(e.competitorSection),
        flagUrl:  newApi.sectionFlagUrl(e.competitorSection, e.competitorCombinedClubNames),
        group:    e.warmUpGroup ?? null,
        position: e.sortOrder  ?? null,
        rank:     e.segmentRank ?? null,
        score:    newApi.safeNum(e.score),
        onice:    !!e.onice,
        status:   newApi.safeStr(e.competitorStatus),
      })).sort((a, b) => {
        if (a.group !== b.group) return (a.group ?? 99) - (b.group ?? 99);
        return (a.position ?? 99) - (b.position ?? 99);
      }),
    };
  }

  /**
   * Push a specific entry to the manual-skater graphic.
   * Returns the data written so the operator can confirm what was set.
   */
  async function setManualSkaterFromEntry(entryId) {
    const cfg = scCfg();
    const entry = await fetchEntry(entryId);
    const [segmentDto, categoryDto] = await Promise.all([
      cfg.segmentId  ? getSegmentDto(cfg.segmentId)   : Promise.resolve(null),
      cfg.categoryId ? getCategoryDto(cfg.categoryId) : Promise.resolve(null),
    ]);
    if (categoryDto && !categoryDto.disciplineName && cfg.discipline) {
      categoryDto.disciplineName = cfg.discipline;
    }
    const name     = newApi.safeStr(entry?.competitorName);
    const club     = newApi.entryClub(entry);
    const section  = newApi.safeStr(entry?.competitorSection);
    const flagUrl  = newApi.sectionFlagUrl(section, entry?.competitorCombinedClubNames);
    const catName  = newApi.catEn(categoryDto);
    const catNameFr = newApi.catFr(categoryDto) || catName;
    const segName  = newApi.safeStr(segmentDto?.segmentName);
    const segNameFr = newApi.safeStr(segmentDto?.segmentFrenchName) || newApi.tr(segName);

    return {
      name, club, section, flagUrl,
      categoryName: catName, categoryNameFr: catNameFr,
      segmentName: segName,  segmentNameFr:  segNameFr,
      groupNumber: entry?.warmUpGroup ?? null,
      startOrder:  entry?.sortOrder   ?? null,
    };
  }

  return {
    // Lifecycle
    start, stop, isActive,
    // Polling (also callable manually)
    pollOnce, pollOfficials,
    // Operator browse (for API routes)
    browseEvent, browseCategory, browseSegment, browseEventRinks,
    // Manual skater push
    setManualSkaterFromEntry,
    // Direct fetch (for operator routes that need raw data)
    fetchEntries, fetchEntry,
  };
}

module.exports = { createScApiService };
