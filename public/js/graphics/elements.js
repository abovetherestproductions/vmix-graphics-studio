(function () {
  const root     = document.getElementById('graphic-root');
  const skaterEl = document.getElementById('el-skater');
  const totalEl  = document.getElementById('el-total');
  const rowsEl   = document.getElementById('el-rows');
  const railEl   = document.getElementById('el-light-rail');
  const bodyEl   = document.getElementById('el-body');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;  // kept for re-render on display-mode change

  let lastAutoFitName      = null;
  let lastAutoFitMeasuredW = 0;

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[elements]', ...args);
  }

  function fmt(n, digits = 2) {
    return n != null ? Number(n).toFixed(digits) : '—';
  }

  function goeClass(goe) {
    // No GOE yet (element entered but not scored) → no state class, so the
    // light stays unlit/neutral. A GOE of exactly 0 means the element was
    // scored at base value with no positive or negative GOE → grey ('zero').
    if (goe == null) return '';
    return goe > 0 ? 'pos' : goe < 0 ? 'neg' : 'zero';
  }

  function goeText(goe) {
    if (goe == null) return '—';
    return goe > 0 ? `+${fmt(goe)}` : fmt(goe);
  }

  function scoreText(el) {
    if (el.score != null) return fmt(el.score);
    if (el.baseValue != null && el.goe != null) return fmt(Number(el.baseValue) + Number(el.goe));
    return '—';
  }

  function elementKey(el = {}) {
    return [el.code || '', el.baseValue ?? '', el.name || '', el.nameFr || ''].join('|');
  }

  function newElementIndex(previousPayload, nextPayload) {
    const previous = Array.isArray(previousPayload?.data?.elements) ? previousPayload.data.elements : [];
    const next = Array.isArray(nextPayload?.data?.elements) ? nextPayload.data.elements : [];
    if (!previous.length || !next.length) return -1;

    const previousKeys = previous.map(elementKey);
    const nextKeys = next.map(elementKey);
    if (next.length > previous.length) {
      const idx = nextKeys.findIndex((key, index) => key !== previousKeys[index]);
      return idx >= 0 ? idx : next.length - 1;
    }

    const currentIdx = nextPayload?.data?.currentIndex ?? (next.length - 1);
    const currentKey = nextKeys[currentIdx];
    if (currentKey && previousKeys[currentIdx] && currentKey !== previousKeys[currentIdx]) return currentIdx;
    return -1;
  }

  function langText(en, fr) {
    return (document.documentElement.lang === 'fr' && fr) ? fr : (en || fr || '');
  }

  function buildRow(el, isCurrent) {
    const div = document.createElement('div');
    div.className = 'el-row' + (isCurrent ? ' current' : '');

    // Accept any "show full name" value: 'name', 'fullName', 'full', true
    const mode = window.elementsDisplayMode;
    const showName = (mode === 'name' || mode === 'fullName' || mode === 'full' || mode === true);
    const code = document.createElement('div');
    code.className = 'el-code' + (showName ? ' show-name' : '');
    const fullName = langText(el.name, el.nameFr);
    code.textContent = (showName ? (fullName || el.code) : el.code) || '—';

    const bv = document.createElement('div');
    bv.className = 'el-bv';
    bv.textContent = el.baseValue != null ? fmt(el.baseValue) : '—';

    const goe = document.createElement('div');
    goe.className = `el-goe ${goeClass(el.goe)}`;
    goe.textContent = goeText(el.goe);

    const score = document.createElement('div');
    score.className = 'el-score';
    score.textContent = scoreText(el);

    div.appendChild(code);
    div.appendChild(bv);
    div.appendChild(goe);
    div.appendChild(score);
    return div;
  }

  function updateRowInPlace(rowEl, el, isCurrent) {
    rowEl.classList.toggle('current', isCurrent);
    const mode     = window.elementsDisplayMode;
    const showName = (mode === 'name' || mode === 'fullName' || mode === 'full' || mode === true);
    const codeEl   = rowEl.querySelector('.el-code');
    const bvEl     = rowEl.querySelector('.el-bv');
    const goeEl    = rowEl.querySelector('.el-goe');
    const scoreEl  = rowEl.querySelector('.el-score');
    if (codeEl) {
      codeEl.className = 'el-code' + (showName ? ' show-name' : '');
      const fullName = langText(el.name, el.nameFr);
      codeEl.textContent = (showName ? (fullName || el.code) : el.code) || '—';
    }
    if (bvEl)    bvEl.textContent = el.baseValue != null ? fmt(el.baseValue) : '—';
    if (goeEl)  { goeEl.className = `el-goe ${goeClass(el.goe)}`; goeEl.textContent = goeText(el.goe); }
    if (scoreEl) scoreEl.textContent = scoreText(el);
  }

  function renderLightRail(elements, currentIdx, pulseCurrent) {
    if (!railEl) return;
    const hideRail = !!window.elementsHideLightRail;
    railEl.style.display = (!hideRail && elements.length) ? 'flex' : 'none';
    if (hideRail) { railEl.innerHTML = ''; return; }

    const existing = railEl.children;
    // Append any missing lights first (cheap — only fires when count grows).
    while (railEl.children.length < elements.length) {
      railEl.appendChild(document.createElement('span'));
    }
    // Remove extras (skater change).
    while (railEl.children.length > elements.length) {
      railEl.removeChild(railEl.lastChild);
    }
    // Patch each light in place — no DOM destruction on GOE updates.
    elements.forEach((el, index) => {
      const light = existing[index];
      const state = goeClass(el.goe);
      const isCurrent = pulseCurrent && index === currentIdx;
      const wanted = `el-light ${state}${isCurrent ? ' current' : ''}`;
      if (light.className !== wanted) light.className = wanted;
      const title = `Element ${index + 1}: ${goeText(el.goe)} GOE`;
      if (light.title !== title) light.title = title;
    });
  }

  // Auto-fit panel width to the skater name. Triggered after every render and
  // on config updates. When auto-fit is OFF, restores the operator's manual
  // width (set by the position slider / preset buttons).
  function applyAutoFit() {
    const manualW = Number(window.elementsManualWidth) || 420;
    if (!window.elementsAutoFit) {
      root.style.width = manualW + 'px';
      lastAutoFitName = null;
      return;
    }
    const currentName = skaterEl.textContent;
    let nameW = lastAutoFitMeasuredW;
    if (currentName !== lastAutoFitName) {
      // Name changed — measure the natural width without ellipsis clipping.
      const prevWS = skaterEl.style.whiteSpace;
      const prevOV = skaterEl.style.overflow;
      const prevTO = skaterEl.style.textOverflow;
      skaterEl.style.whiteSpace   = 'nowrap';
      skaterEl.style.overflow     = 'visible';
      skaterEl.style.textOverflow = 'clip';
      nameW = skaterEl.scrollWidth;
      skaterEl.style.whiteSpace   = prevWS;
      skaterEl.style.overflow     = prevOV;
      skaterEl.style.textOverflow = prevTO;
      lastAutoFitName      = currentName;
      lastAutoFitMeasuredW = nameW;
    }
    // Chrome = logo + total block + horizontal paddings + safety margin.
    const CHROME_PX = 220;
    const target = Math.max(manualW, nameW + CHROME_PX);
    root.style.width = target + 'px';
  }

  // ── Highest TES tracking — per category/segment, persists across reloads.
  // Storage shape: { "category|segment": { high: number, skaters: [name,...] } }
  // We track distinct skater names so the row can be suppressed while only
  // one skater has been on the panel — there's no meaningful "highest" yet
  // when the first skater is still up.
  const HIGHEST_TES_KEY = 'elementsHighestTes';
  function segmentKey(data = {}) {
    // liveElementTracker.php doesn't include category/segment per entry, so
    // normalizeLiveElements doesn't carry them either. Fall back to whatever
    // theme-loader pulled from event-config.json (refreshed by the eventInfo
    // poll). Without this fallback the bucket key was always "|" and the
    // tracker never reset between categories.
    // groupNumber distinguishes groups within the same category (e.g. Pre Novice
    // Women 1 vs 2) so the Highest TES bucket resets between groups.
    const ovr = (window.configHeaderOverrides || {})['elements'] || {};
    const cat = (data.categoryName || data.category || ovr.categoryName || '').trim();
    const seg = (data.segmentName  || data.segment  || data.segmentType || ovr.segmentName || '').trim();
    const grp = data.groupNumber != null ? String(data.groupNumber) : '';
    return `${cat}|${seg}|${grp}`;
  }
  function readHighest() {
    try { return JSON.parse(localStorage.getItem(HIGHEST_TES_KEY) || '{}'); }
    catch { return {}; }
  }
  function writeHighest(map) {
    try { localStorage.setItem(HIGHEST_TES_KEY, JSON.stringify(map)); }
    catch { /* ignore */ }
  }
  // Entry shape: { high, completed:[name,...], current:{name,total} }
  //   high      — best FINAL total among skaters who have finished this segment
  //   completed — names of skaters who have left the panel (finished)
  //   current   — the skater on the panel now, with their live running total
  // Normalises legacy shapes (bare number, or the old `{ high, skaters }`).
  function readEntry(map, key) {
    const e = map[key];
    if (typeof e === 'number') return { high: e, completed: [], current: null };
    return {
      high:      Number(e?.high) || 0,
      completed: Array.isArray(e?.completed) ? e.completed : [],
      current:   (e && e.current && e.current.name)
        ? { name: String(e.current.name), total: Number(e.current.total) || 0 }
        : null,
    };
  }
  // The "Highest TES" is the best score among skaters who have ALREADY FINISHED
  // — it must NOT include the skater currently on the ice, otherwise it tracks
  // their running total live (and would show during the very first skater).
  // A skater is only "finished" once a different skater appears on the panel;
  // at that point we commit their last-seen total. So the row stays empty for
  // the first skater and appears, as a fixed benchmark, from the second onward.
  function updateHighestFor(data) {
    const key = segmentKey(data);
    if (!key) return { high: 0, completed: 0 };
    const running = Number(data.runningTotal) || 0;
    const name    = String(data.name || '').trim();
    const map     = readHighest();
    const entry   = readEntry(map, key);
    let mutated   = false;

    if (name) {
      if (!entry.current) {
        // First skater on the panel for this segment — track, don't commit.
        entry.current = { name, total: running };
        mutated = true;
      } else if (entry.current.name !== name) {
        // Skater changed: the previous one has finished. Commit their final
        // total to the running max, then start tracking the new skater.
        if (!entry.completed.includes(entry.current.name)) entry.completed.push(entry.current.name);
        if (entry.current.total > entry.high) entry.high = entry.current.total;
        entry.current = { name, total: running };
        mutated = true;
      } else if (running !== entry.current.total) {
        // Same skater still up — update their live total but DON'T fold it into
        // the highest yet; it only counts once they've finished.
        entry.current.total = running;
        mutated = true;
      }
    }

    if (mutated) {
      map[key] = entry;
      writeHighest(map);
    }
    return { high: entry.high, completed: entry.completed.length };
  }

  function render(payload, animateIndex = -1) {
    const data = payload.data || {};
    if (window.GraphicsUtils?.applyInitialsIfNeeded) {
      window.GraphicsUtils.applyInitialsIfNeeded(skaterEl, data.name || '');
    } else {
      skaterEl.textContent = data.name || '';
    }
    totalEl.textContent  = fmt(data.runningTotal ?? 0);
    // Re-fit after the new name lands in the DOM.
    requestAnimationFrame(applyAutoFit);

    // The feed only lists elements the tech panel has already ENTERED, so show
    // every one as soon as it appears — its GOE/score may keep updating for a
    // few seconds afterward and that's fine, we don't wait for it to finalize.
    // The current (highlighted/pulsing) element is the on-ice one, else the
    // last entered; it stays on the panel until the next element is entered.
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const currentIdx = data.currentIndex ?? (elements.length - 1);

    // Update the rolling highest TES for this skater's segment, then read back
    // the leader for the bottom-of-tracker "Highest TES" row. The row only
    // renders once at least one skater has FINISHED (i.e. from the second
    // skater onward) and shows that finished leader's score as a fixed
    // benchmark — never the current skater's still-updating total.
    const tesEntry         = updateHighestFor(data);
    const highest          = tesEntry.high;
    const completedSkaters = tesEntry.completed;

    const layoutMode = (window.elementsLayoutMode === 'single') ? 'single' : 'list';
    root.classList.toggle('layout-single', layoutMode === 'single');
    root.classList.toggle('layout-list',   layoutMode !== 'single');
    // Operator toggle for the TES label above the score.
    root.classList.toggle('hide-total-label', window.elementsHideTotalLabel === true);

    renderLightRail(elements, currentIdx, animateIndex === currentIdx);

    // ── DOM diffing: avoid wiping all rows when only values changed ──────
    // single mode: patch the one visible row in place on GOE updates;
    //              only rebuild when the current element actually changes.
    // list mode:
    //   updateOnly  — same row count, no new animation → patch cells in place
    //   appendOnly  — exactly one new element → patch existing + append new row
    //   full rebuild — skater changed, layout switched, or count mismatch
    const newElement = animateIndex >= 0 && animateIndex < elements.length;

    if (layoutMode === 'single') {
      const el = elements[currentIdx];
      const existingSingleRow = rowsEl.firstElementChild;
      if (!el) {
        if (rowsEl.children.length) rowsEl.innerHTML = '';
      } else if (existingSingleRow && !newElement) {
        updateRowInPlace(existingSingleRow, el, true);
      } else {
        rowsEl.innerHTML = '';
        const row = buildRow(el, true);
        rowsEl.appendChild(row);
        if (newElement) {
          setTimeout(() => row.classList.add('row-in'), 30);
        } else {
          row.classList.add('no-anim', 'row-in');
        }
      }
    } else {
      const existingRows = Array.from(rowsEl.querySelectorAll('.el-row'));
      const updateOnly   = !newElement && existingRows.length === elements.length;
      const appendOnly   = newElement  && existingRows.length === elements.length - 1;
      if (updateOnly) {
        elements.forEach((el, i) => updateRowInPlace(existingRows[i], el, i === currentIdx));
      } else if (appendOnly) {
        existingRows.forEach((rowEl, i) => updateRowInPlace(rowEl, elements[i], i === currentIdx));
        const newRow = buildRow(elements[animateIndex], animateIndex === currentIdx);
        rowsEl.appendChild(newRow);
        setTimeout(() => newRow.classList.add('row-in'), 30);
      } else {
        rowsEl.innerHTML = '';
        elements.forEach((el, i) => {
          const row = buildRow(el, i === currentIdx);
          rowsEl.appendChild(row);
          if (i === animateIndex) {
            setTimeout(() => row.classList.add('row-in'), 30);
          } else {
            row.classList.add('no-anim', 'row-in');
          }
        });
      }
    }

    // Bottom "Highest TES" summary row — only shown once a SECOND distinct
    // skater has appeared on the panel. While the first skater is still up,
    // there's no meaningful comparison value yet.
    //
    // Appended to the body wrapper (a sibling AFTER the light rail) rather
    // than into the rows container, so DOM order reads:
    //   element rows  →  light rail  →  Highest TES
    // The summary always shows at the bottom of the panel.
    // Operator toggle: when checked, the Highest TES row is suppressed
    // regardless of how many skaters have appeared on the panel.
    const showHighest = !window.elementsHideHighest;
    const wantSummary = showHighest && !!bodyEl && highest > 0 && completedSkaters >= 1;
    const existingSummary = bodyEl?.querySelector('.el-summary');
    if (!wantSummary) {
      if (existingSummary) existingSummary.remove();
    } else if (existingSummary) {
      // Patch score in place — label and empty cells never change mid-skater.
      const scoreEl = existingSummary.querySelector('.el-score');
      if (scoreEl) {
        const next = fmt(highest);
        if (scoreEl.textContent !== next) scoreEl.textContent = next;
      }
    } else {
      const summary = document.createElement('div');
      summary.className = 'el-row el-summary no-anim row-in';
      const label = document.createElement('div');
      label.className = 'el-code el-summary-label';
      const isFr = (document.documentElement.lang || 'en') === 'fr';
      const hiEn = window.elementsHighestLabel   || 'Highest Technical Score';
      const hiFr = window.elementsHighestLabelFr || 'Meilleur Score Technique';
      label.textContent = isFr ? hiFr : hiEn;
      const bv = document.createElement('div');
      bv.className = 'el-bv';
      const goe = document.createElement('div');
      goe.className = 'el-goe zero';
      const score = document.createElement('div');
      score.className = 'el-score';
      score.textContent = fmt(highest);
      summary.appendChild(label);
      summary.appendChild(bv);
      summary.appendChild(goe);
      summary.appendChild(score);
      bodyEl.appendChild(summary);
    }
  }

  function animateIn(payload) {
    render(payload, false);
    root.classList.remove('hidden', 'out');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
  }

  // OUT — body wrapper collapses (rows + light-rail retract together as a
  // unit), then the header slides back up the way it came in. Mirrors the
  // two-phase entry animation in reverse.
  async function animateOut() {
    if (bodyEl) {
      // Collapse body: override the entry transition-delay (2s) so the exit
      // is immediate. rAF separates the transition assignment from the target
      // so the browser commits the property before starting the animation —
      // avoids the scrollHeight + offsetHeight forced-layout pair.
      bodyEl.style.transition = 'max-height 520ms cubic-bezier(0.83, 0, 0.17, 1)';
      bodyEl.style.transitionDelay = '0ms';
      await new Promise(r => requestAnimationFrame(r));
      bodyEl.style.maxHeight = '0px';
    }
    // Wait for the body to mostly finish collapsing, then trigger the
    // header lift (driven by the .out class in CSS).
    await new Promise(r => setTimeout(r, 380));
    root.classList.add('out');
    root.classList.remove('visible');
    await new Promise(resolve => {
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out');
        if (bodyEl) {
          bodyEl.style.transition = '';
          bodyEl.style.transitionDelay = '';
          bodyEl.style.maxHeight = '';
        }
        currentVisible = false;
        resolve();
      }, 380);
    });
  }

  function animateUpdate(payload, previousPayload) {
    render(payload, newElementIndex(previousPayload, payload));
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    const visible  = !!payload?.control?.visible;
    const state    = payload?.control?.state || 'auto';

    if (revision === currentRevision) return;
    if (busy) { queuedPayload = payload; return; }

    busy = true;
    log('payload', { revision, visible, state });

    try {
      if (!visible && currentVisible) {
        currentRevision = revision; await animateOut();
      } else if (visible && !currentVisible) {
        currentRevision = revision; lastPayload = payload; animateIn(payload);
      } else if (visible && currentVisible) {
        const previousPayload = lastPayload;
        currentRevision = revision; animateUpdate(payload, previousPayload); lastPayload = payload;
      } else {
        currentRevision = revision; lastPayload = payload;
      }
    } finally {
      busy = false;
      if (queuedPayload) { const n = queuedPayload; queuedPayload = null; handlePayload(n); }
    }
  }

  // Re-render when display mode changes (config-update from operator toggle)
  // OR when language switches. Always re-render if we have data — the graphic
  // will display correctly whenever it next becomes visible even if hidden.
  window.addEventListener('graphics-config-updated', () => {
    if (lastPayload) render(lastPayload, false);
    else applyAutoFit(); // no data yet — at least respect width preset/toggle
  });

  // Also fetch current config explicitly at startup in case theme-loader
  // has not yet set window.elementsDisplayMode by the time we render.
  (async function warmDisplayMode() {
    if (window.elementsDisplayMode != null && window.elementsLayoutMode != null) return;
    try {
      const res = await fetch('/data/event-config.json?_=' + Date.now());
      if (res.ok) {
        const cfg = await res.json();
        if (window.elementsDisplayMode == null) window.elementsDisplayMode = cfg.elementsDisplayMode || 'code';
        if (window.elementsLayoutMode  == null) window.elementsLayoutMode  = cfg.elementsLayoutMode  || 'list';
        if (lastPayload) render(lastPayload, false);
      }
    } catch { /* ignore */ }
  })();

  new window.JsonPoller({
    url: '/data/elements.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[elements] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('elements', handlePayload);
})();
