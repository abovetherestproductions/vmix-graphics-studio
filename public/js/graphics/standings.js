(function () {
  const root       = document.getElementById('graphic-root');
  const titleEl    = document.getElementById('st-title');
  const subtitleEl = document.getElementById('st-subtitle');
  const rowsEl     = document.getElementById('st-rows');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;

  function langText(en, fr) {
    return (document.documentElement.lang === 'fr' && fr) ? fr : (en || fr || '');
  }

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[standings/rank6]', ...args);
  }

  function fmt(n) {
    if (n == null) return '—';
    return Number(n).toFixed(2);
  }

  /**
   * Build a single skater row element.
   * If row.separator === true, inserts a "···" gap above this row.
   */
  function buildRow(row) {
    const frag = document.createDocumentFragment();

    // Optional separator before this row
    if (row.separator) {
      const sep = document.createElement('div');
      sep.className = 'st-separator';
      frag.appendChild(sep);
    }

    const el = document.createElement('div');
    el.className = [
      'st-row',
      `rank-${row.rank}`,
      row.onIce   ? 'on-ice'  : '',
    ].filter(Boolean).join(' ');

    const rankEl = document.createElement('div');
    rankEl.className = 'st-rank';
    rankEl.textContent = row.rank ?? '—';

    const flagWrap = document.createElement('div');
    flagWrap.className = 'st-flag-wrap';
    if (row.flagUrl) {
      const img = document.createElement('img');
      img.className = 'st-flag';
      img.alt = '';
      flagWrap.appendChild(img);
      window.GraphicsUtils.wireFlagFallback(img, flagWrap);
      img.src = row.flagUrl;
    }

    const mainEl = document.createElement('div');
    mainEl.className = 'st-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'st-name';
    window.GraphicsUtils.applyInitialsIfNeeded(nameEl, row.name || '');

    const clubEl = document.createElement('div');
    clubEl.className = 'st-club';
    clubEl.textContent = [row.club, row.section].filter(Boolean).join(' · ');

    mainEl.appendChild(nameEl);
    mainEl.appendChild(clubEl);

    const scoreEl = document.createElement('div');
    scoreEl.className = 'st-score';
    scoreEl.textContent = fmt(row.total);

    el.appendChild(rankEl);
    el.appendChild(flagWrap);
    el.appendChild(mainEl);
    el.appendChild(scoreEl);
    frag.appendChild(el);
    return frag;
  }

  function render(payload) {
    const data = payload.data || {};
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('standings', data, 'Rankings');
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle('standings', data, '');
    window.GraphicsUtils.fitTitleOneLine(titleEl);

    rowsEl.innerHTML = '';
    const rows = Array.isArray(data.rows) ? data.rows : [];
    rows.forEach(row => rowsEl.appendChild(buildRow(row)));
  }

  function animateRowsIn(duration = 320, stagger = 60) {
    const rows = rowsEl.querySelectorAll('.st-row');
    rows.forEach((row, i) => {
      row.style.transitionDuration = `${duration}ms`;
      row.style.transitionDelay   = `${i * stagger}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add('row-in')));
    });
  }

  function animateRowsOut(duration = 180) {
    rowsEl.querySelectorAll('.st-row').forEach(row => {
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

  function expandRowsArea() {
    rowsEl.style.maxHeight = '0px';
    void rowsEl.offsetHeight;
    rowsEl.style.maxHeight = `${rowsEl.scrollHeight}px`;
  }

  function syncRowsHeight() {
    rowsEl.style.maxHeight = `${rowsEl.scrollHeight}px`;
  }

  // Fade-out of the entire panel. Duration is overridable so animateOut can
  // stretch it to match the rows-area collapse.
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

  async function animateIn(payload) {
    render(payload);
    animatePanelIn();
    await window.GraphicsUtils.delay(120);
    expandRowsArea();
    await window.GraphicsUtils.delay(620);
    animateRowsIn(420, 70);
  }

  // OUT — collapse rows area first, then fade the panel.
  async function animateOut() {
    rowsEl.style.maxHeight = '0px';
    await window.GraphicsUtils.delay(200);
    await animatePanelOut(720);
  }

  async function animateUpdate(payload) {
    render(payload);
    syncRowsHeight();
    animateRowsIn(0, 0);
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    const visible  = !!payload?.control?.visible;

    if (revision === currentRevision) return;
    if (busy) { queuedPayload = payload; return; }

    busy = true;
    log('payload', { revision, visible, pivotRank: payload.data?.pivotRank });

    try {
      if (!visible && currentVisible) {
        currentRevision = revision;
        await animateOut();
      } else if (visible && !currentVisible) {
        currentRevision = revision; lastPayload = payload;
        await animateIn(payload);
      } else if (visible && currentVisible) {
        currentRevision = revision; lastPayload = payload;
        await animateUpdate(payload);
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

  // Update title when language switches (rows don't have translatable content)
  window.addEventListener('graphics-config-updated', () => {
    const data = lastPayload?.data || {};
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('standings', data, 'Rankings');
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle('standings', data, '');
    window.GraphicsUtils.fitTitleOneLine(titleEl);
  });

  new window.JsonPoller({
    url: '/data/standings.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[standings] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('standings', handlePayload);
})();
