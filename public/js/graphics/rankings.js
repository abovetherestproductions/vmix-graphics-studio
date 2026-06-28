(function () {
  const root      = document.getElementById('graphic-root');
  const panel     = document.getElementById('panel');
  const titleEl   = document.getElementById('rk-title');
  const subtitleEl= document.getElementById('rk-subtitle');
  const rowsEl    = document.getElementById('rk-rows');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;

  /** Pick the right language string — falls back to the other language gracefully */
  function langText(en, fr) {
    return (document.documentElement.lang === 'fr' && fr) ? fr : (en || fr || '');
  }

  const ROWS_PER_PAGE_THRESHOLDS = { large: 4, standard: 7 }; // ≤4 large, ≤7 standard, else compact

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[rankings]', ...args);
  }

  function fmt(n) {
    if (n == null) return '—';
    return Number(n).toFixed(2);
  }

  function getLayoutClass(rowCount) {
    if (rowCount <= ROWS_PER_PAGE_THRESHOLDS.large)    return 'layout-large';
    if (rowCount <= ROWS_PER_PAGE_THRESHOLDS.standard) return 'layout-standard';
    return 'layout-compact';
  }

  function buildRow(row) {
    const el = document.createElement('div');
    el.className = `rk-row rank-${row.rank}`;

    const rankEl = document.createElement('div');
    rankEl.className = 'rk-rank';
    rankEl.textContent = row.rank ?? '—';

    const flagWrap = document.createElement('div');
    flagWrap.className = 'rk-flag-wrap';
    if (row.flagUrl) {
      const img = document.createElement('img');
      img.className = 'rk-flag';
      img.alt = '';
      flagWrap.appendChild(img);
      window.GraphicsUtils.wireFlagFallback(img, flagWrap);
      img.src = row.flagUrl;
    }

    const mainEl = document.createElement('div');
    mainEl.className = 'rk-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'rk-name';
    window.GraphicsUtils.applyInitialsIfNeeded(nameEl, row.name || '');

    const clubEl = document.createElement('div');
    clubEl.className = 'rk-club';
    clubEl.textContent = [row.club, row.section].filter(Boolean).join(' · ');

    mainEl.appendChild(nameEl);
    mainEl.appendChild(clubEl);

    const totalEl = document.createElement('div');
    totalEl.className = 'rk-total';
    totalEl.textContent = fmt(row.total);

    el.appendChild(rankEl);
    el.appendChild(flagWrap);
    el.appendChild(mainEl);
    el.appendChild(totalEl);
    return el;
  }

  /** Update header text only (no animation — stays frozen during page changes) */
  function updateHeader(data) {
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('rankings', data, 'Final Rankings');
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle('rankings', data, '');
    window.GraphicsUtils.fitTitleOneLine(titleEl);
  }

  /**
   * Resolve which rows to display.
   *
   * Preferred path: page client-side from `data.allRows` using `data.page` and
   * `data.rowsPerPage`. This keeps the graphic in sync with the operator even
   * if the server-sliced `data.rows` is stale or mismatched.
   *
   * Fallback: use `data.rows` as-is (for payloads that don't include allRows,
   * e.g. manually-edited JSON or legacy data).
   */
  function resolveDisplayRows(data) {
    const allRows = Array.isArray(data.allRows) ? data.allRows : null;
    if (allRows && allRows.length) {
      const rpp       = Math.max(1, Number(data.rowsPerPage) || 8);
      const page      = Math.max(1, Number(data.page) || 1);
      const pageCount = Math.max(1, Math.ceil(allRows.length / rpp));
      const safePage  = Math.min(page, pageCount);
      const start     = (safePage - 1) * rpp;
      return allRows.slice(start, start + rpp);
    }
    return Array.isArray(data.rows) ? data.rows : [];
  }

  /** Swap row DOM content immediately (no animation) */
  function renderRows(data) {
    const rows = resolveDisplayRows(data);
    // Layout class is locked to the configured page size (rowsPerPage), NOT
    // the visible row count. Otherwise the last page — which may be partial —
    // would jump to a larger layout and the cells would visibly resize.
    const layoutBasis = data.groupedPageMode
      ? (rows.length || 1)
      : Math.max(rows.length, Number(data.rowsPerPage) || rows.length || 1);
    root.classList.remove('layout-large', 'layout-standard', 'layout-compact');
    root.classList.add(getLayoutClass(layoutBasis));
    rowsEl.innerHTML = '';
    rows.forEach(row => rowsEl.appendChild(buildRow(row)));
  }

  function animateRowsIn(duration = 300, stagger = 45) {
    const rows = rowsEl.querySelectorAll('.rk-row');
    rows.forEach((row, i) => {
      row.style.transitionDuration = `${duration}ms`;
      row.style.transitionDelay   = `${i * stagger}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add('row-in')));
    });
  }

  function animateRowsOut(duration = 180) {
    rowsEl.querySelectorAll('.rk-row').forEach(row => {
      row.style.transitionDuration = `${duration}ms`;
      row.style.transitionDelay   = '0ms';
      row.classList.remove('row-in');
    });
  }

  function animatePanelIn() {
    root.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
  }

  // Fade-out of the entire panel. Duration is overridable so animateOut can
  // stretch it to overlap the rows-area roll-up.
  function animatePanelOut(durationMs = 360) {
    return new Promise(resolve => {
      root.style.transition = `opacity ${durationMs}ms ease-out`;
      root.style.opacity = '0';
      setTimeout(() => {
        root.classList.remove('visible');
        root.classList.add('hidden');
        root.style.opacity = '';
        root.style.transition = '';
        currentVisible = false;
        resolve();
      }, durationMs + 20);
    });
  }

  // ── Page-change animation: header frozen, rows cascade down ──────────────
  async function animatePageChange(data) {
    updateHeader(data); // update page indicator immediately (stays in header)
    // Reset rows to their pre-cascade state (above + transparent), then
    // re-render and re-cascade. No horizontal slide.
    animateRowsOut(0);
    renderRows(data);
    await window.GraphicsUtils.delay(16); // let the browser paint the reset state
    animateRowsIn(360, 60);
  }

  // ── Standard animateIn (panel fades in while rows area rolls down) ────────
  async function animateIn(payload) {
    const data = payload.data || {};
    updateHeader(data);
    renderRows(data);
    rowsEl.querySelectorAll('.rk-row').forEach(row => {
      row.style.transitionDuration = '0ms';
      row.classList.add('row-in');
    });
    rowsEl.style.maxHeight = '0px';
    void rowsEl.offsetHeight;
    rowsEl.style.transition = 'max-height 620ms cubic-bezier(0.83, 0, 0.17, 1)';
    animatePanelIn();
    await window.GraphicsUtils.delay(120);
    rowsEl.style.maxHeight = `${rowsEl.scrollHeight}px`;
    await window.GraphicsUtils.delay(660);
    rowsEl.style.maxHeight = '';
    rowsEl.style.transition = '';
  }

  // OUT — rows roll back into the header while the panel fades longer.
  async function animateOut() {
    rowsEl.style.maxHeight = `${rowsEl.scrollHeight}px`;
    void rowsEl.offsetHeight;
    rowsEl.style.transition = 'max-height 620ms cubic-bezier(0.83, 0, 0.17, 1)';
    rowsEl.style.maxHeight = '0px';
    await window.GraphicsUtils.delay(200);
    await animatePanelOut(720);
    rowsEl.style.transition = '';
    rowsEl.style.maxHeight = '';
  }

  // ── Standard animateUpdate (live data refresh, NOT a page turn) ──────────
  // Snap new content in place — no cascade. Cascading every score change
  // would be visually distracting on air. Cascades fire on show + page-change.
  async function animateUpdate(payload) {
    const data = payload.data || {};
    updateHeader(data);
    renderRows(data);
    // Rows render in their pre-cascade state; immediately reveal them with
    // no per-row delay so the swap is invisible to the viewer.
    animateRowsIn(0, 0);
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
        currentRevision = revision;
        await animateOut();
      } else if (visible && !currentVisible) {
        currentRevision = revision; lastPayload = payload;
        await animateIn(payload);
      } else if (visible && currentVisible) {
        currentRevision = revision; lastPayload = payload;
        if (state === 'pageChange') {
          // Header stays frozen — only rows animate
          await animatePageChange(payload.data || {});
        } else {
          await animateUpdate(payload);
        }
      } else {
        currentRevision = revision; lastPayload = payload;
      }
    } finally {
      busy = false;
      if (queuedPayload) {
        const n = queuedPayload;
        queuedPayload = null;
        handlePayload(n);
      }
    }
  }

  // Re-render header when language changes (data already has both titleEn and titleFr)
  window.addEventListener('graphics-config-updated', () => {
    // Always re-resolve so titleSource dropdown changes apply immediately,
    // even before the first payload has arrived.
    updateHeader(lastPayload?.data || {});
  });

  new window.JsonPoller({
    url: '/data/rankings.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[rankings] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('rankings', handlePayload);
})();
