(function () {
  const root      = document.getElementById('graphic-root');
  const panel     = document.getElementById('panel');
  const titleEl   = document.getElementById('of-title');
  const subtitleEl= document.getElementById('of-subtitle');
  const rowsEl    = document.getElementById('of-rows');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;

  function langText(en, fr) {
    return (document.documentElement.lang === 'fr' && fr) ? fr : (en || fr || '');
  }

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[officials]', ...args);
  }

  function isBilingual() {
    return window.configHeaderOverrides?.officials?.langMode === 'both';
  }

  /**
   * Bilingual mode: size the role column to exactly fit the longest "English /
   * French" role at its normal font size, and tell the theme loader so the panel
   * can be that column plus the name side. Measured on clones of the real role
   * cells (same markup, same styles, same zoom) laid out at their natural width.
   * Outside Bilingual mode the column is left to the normal Role Width setting.
   */
  // The theme loader skips a pass when the saved config has not changed, which
  // is the case here (only a measurement has), so ask it to apply regardless.
  async function reapplyTheme() {
    if (!window.applyTheme) return;
    window.applyTheme.force = true;
    try { await window.applyTheme(); } finally { window.applyTheme.force = false; }
  }

  function sizeRoleColumn() {
    const run = () => {
      const rows = [...rowsEl.querySelectorAll('.of-row')];
      if (!isBilingual() || !rows.length) {
        if (window.officialsBilingualRoleCol) {
          window.officialsBilingualRoleCol = 0;
          root.style.removeProperty('--of-col-role');
          reapplyTheme();
        }
        return;
      }
      let widest = 0;
      rows.forEach(row => {
        const clone = row.querySelector('.of-role').cloneNode(true);
        clone.style.cssText = 'position:absolute;visibility:hidden;width:auto;max-width:none;overflow:visible;text-overflow:clip;';
        panel.appendChild(clone);
        widest = Math.max(widest, clone.offsetWidth);
        clone.remove();
      });
      const first = getComputedStyle(rows[0]);
      const overhead = (parseFloat(first.paddingLeft) || 0) + (parseFloat(first.paddingRight) || 0) + (parseFloat(first.columnGap) || 0);
      const col = Math.ceil(widest) + 6;
      if (col === window.officialsBilingualRoleCol && overhead === window.officialsRowOverhead) return;
      window.officialsBilingualRoleCol = col;
      window.officialsRowOverhead = overhead;
      root.style.setProperty('--of-col-role', `${col}px`);
      reapplyTheme().then(fitHeader);        // the width follows the new column; refit the title in it
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 900);
  }

  // The title shrinks to fit and, in Bilingual mode, stacks if it still cannot.
  function fitHeader() {
    window.GraphicsUtils.fitTitleOneLine(titleEl);
  }

  function buildRow(row) {
    const el = document.createElement('div');
    el.className = 'of-row';

    const roleEl = document.createElement('div');
    roleEl.className = 'of-role';
    // Bilingual: both roles on one line, "Referee / Arbitre". The role column
    // is sized to fit them (see sizeRoleColumn); a role with no French, or the
    // same word in both, stays plain.
    const en = String(row.role || '').trim();
    const fr = String(row.roleFr || '').trim();
    if (isBilingual() && en && fr && en.toLowerCase() !== fr.toLowerCase()) {
      const span = (cls, text) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        return s;
      };
      const first  = span('of-role-en', en);
      const second = span('of-role-fr', fr);
      roleEl.append(...(window.bilingualOrder === 'fr' ? [second, span('of-role-sep', '/'), first] : [first, span('of-role-sep', '/'), second]));
    } else {
      roleEl.textContent = langText(row.role, row.roleFr) || '';
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'of-name';
    nameEl.textContent = row.name || '';

    el.appendChild(roleEl);
    el.appendChild(nameEl);
    return el;
  }

  function roleOrder(role) {
    const r = (role || '').toLowerCase();
    if (r.startsWith('referee') || r.startsWith('arbitre')) return 0;
    if (r.startsWith('judge')   || r.startsWith('juge'))    return 1;
    return 2;
  }

  // Row-count layout tiers — same thresholds and naming as Final Rankings,
  // so a short officials list (a referee and two judges) and a full
  // technical panel each render at a size suited to their own row count,
  // instead of one >=8 cutoff that left every smaller panel showing the
  // raw, unclamped configured Name Size. See officials/style.css.
  const ROW_COUNT_THRESHOLDS = { large: 4, standard: 7 }; // <=4 large, <=7 standard, else compact

  function getLayoutClass(rowCount) {
    if (rowCount <= ROW_COUNT_THRESHOLDS.large)    return 'layout-large';
    if (rowCount <= ROW_COUNT_THRESHOLDS.standard) return 'layout-standard';
    return 'layout-compact';
  }

  function render(payload) {
    const data = payload.data || {};
    window.GraphicsUtils.setHeaderText(titleEl, 'officials', 'title', data, 'Officials');
    window.GraphicsUtils.fitTitle(titleEl);
    window.GraphicsUtils.setHeaderText(subtitleEl, 'officials', 'subtitle', data, '');
    fitHeader();

    const rows = Array.isArray(data.rows)
      ? [...data.rows].sort((a, b) => roleOrder(a.role) - roleOrder(b.role))
      : [];
    root.classList.remove('layout-large', 'layout-standard', 'layout-compact');
    root.classList.add(getLayoutClass(rows.length));

    rowsEl.innerHTML = '';
    rows.forEach(row => rowsEl.appendChild(buildRow(row)));
    sizeRoleColumn();
  }

  function animateRowsIn(stagger = 60) {
    rowsEl.querySelectorAll('.of-row').forEach((row, i) => {
      row.style.transitionDelay = `${i * stagger}ms`;
      requestAnimationFrame(() => row.classList.add('row-in'));
    });
  }

  // Rows start invisible and only the entrance animation makes them visible,
  // so a rebuild of an on-air graphic (a settings or language change) has to
  // reveal them itself, at once, without replaying the cascade.
  function showRowsNow() {
    const rows = rowsEl.querySelectorAll('.of-row');
    rows.forEach(row => {
      row.style.transition = 'none';
      row.classList.add('row-in');
    });
    void rowsEl.offsetHeight;
    rows.forEach(row => { row.style.transition = ''; });
  }

  function animateRowsOut() {
    // Reset to pre-cascade state. OUT is a single panel fade — no row-by-row exit.
    rowsEl.querySelectorAll('.of-row').forEach(row => {
      row.style.transitionDuration = '0ms';
      row.style.transitionDelay = '0ms';
      row.classList.remove('row-in');
    });
  }

  function animatePanelIn() {
    root.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
  }

  // Fade-out of the entire panel. Duration is overridable so animateOut can
  // stretch it to overlap the rows-area roll-up — same pattern as the
  // rankings and starting-order exits.
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
    setTimeout(() => animateRowsIn(60), 120);
  }

  // OUT — rows roll back into the header while the panel fades longer.
  // Matches the rankings / starting-order exit feel.
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

  async function animateUpdate(payload) {
    // Live data refresh — snap the new content in place. Cascade is
    // reserved for the initial show.
    render(payload);
    animateRowsIn(0); // 0 stagger = all rows reveal together, no cascade
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
        currentRevision = revision; lastPayload = payload; await animateIn(payload);
      } else if (visible && currentVisible) {
        currentRevision = revision; lastPayload = payload; await animateUpdate(payload);
      } else {
        currentRevision = revision; lastPayload = payload;
      }
    } finally {
      busy = false;
      if (queuedPayload) { const n = queuedPayload; queuedPayload = null; handlePayload(n); }
    }
  }

  // Re-render when language switches (roles stored as both role + roleFr)
  window.addEventListener('graphics-config-updated', () => {
    if (lastPayload) {
      render(lastPayload);
      if (currentVisible) showRowsNow();
    } else {
      // No payload yet — still reflect dropdown changes on the header text.
      window.GraphicsUtils.setHeaderText(titleEl, 'officials', 'title', {}, 'Officials');
      window.GraphicsUtils.fitTitle(titleEl);
      window.GraphicsUtils.setHeaderText(subtitleEl, 'officials', 'subtitle', {}, '');
      fitHeader();
    }
  });

  new window.JsonPoller({
    url: '/data/officials.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[officials] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('officials', handlePayload);
})();
