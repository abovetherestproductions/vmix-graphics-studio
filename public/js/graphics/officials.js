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

  function buildRow(row) {
    const el = document.createElement('div');
    el.className = 'of-row';

    const roleEl = document.createElement('div');
    roleEl.className = 'of-role';
    roleEl.textContent = langText(row.role, row.roleFr) || '';

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

  function render(payload) {
    const data = payload.data || {};
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('officials', data, 'Officials');
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle('officials', data, '');
    window.GraphicsUtils.fitTitleOneLine(titleEl);

    const rows = Array.isArray(data.rows)
      ? [...data.rows].sort((a, b) => roleOrder(a.role) - roleOrder(b.role))
      : [];
    // Auto compact for large panels
    root.classList.toggle('layout-compact', rows.length >= 8);

    rowsEl.innerHTML = '';
    rows.forEach(row => rowsEl.appendChild(buildRow(row)));
  }

  function animateRowsIn(stagger = 60) {
    rowsEl.querySelectorAll('.of-row').forEach((row, i) => {
      row.style.transitionDelay = `${i * stagger}ms`;
      requestAnimationFrame(() => row.classList.add('row-in'));
    });
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
    } else {
      // No payload yet — still reflect dropdown changes on the header text.
      titleEl.textContent    = window.GraphicsUtils.resolveTitle('officials', {}, 'Officials');
      subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle('officials', {}, '');
      window.GraphicsUtils.fitTitleOneLine(titleEl);
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
