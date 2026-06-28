(function () {
  const root       = document.getElementById('sp-root');
  const photoWrap  = document.getElementById('sp-photo-wrap');
  const photoEl    = document.getElementById('sp-photo');
  const eventEl    = document.getElementById('sp-event');
  const startNumEl = document.getElementById('sp-start-num');
  const nameEl     = document.getElementById('sp-name');
  const clubEl     = document.getElementById('sp-club');
  const sectionEl  = document.getElementById('sp-section');
  const sbEl       = document.getElementById('sp-sb');
  const pbEl       = document.getElementById('sp-pb');
  const flagEl     = document.getElementById('sp-flag');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[skater-profile]', ...args);
  }

  function fmt(n) { return n != null ? Number(n).toFixed(2) : '—'; }

  function render(payload) {
    lastPayload = payload;
    const data = payload.data || {};

    // Title source dropdown (auto/category/segment/event/custom) handled here.
    // 'auto' uses data.event for back-compat with the existing payload shape.
    eventEl.textContent = window.GraphicsUtils.resolveTitle(
      'skater-profile',
      { ...data, title: data.event, titleEn: data.event },
      data.event || ''
    );
    startNumEl.textContent = data.startNumber ? `#${data.startNumber}` : '';
    window.GraphicsUtils.applyInitialsIfNeeded(nameEl, data.name || '');
    clubEl.textContent     = data.club     || '';
    sectionEl.textContent  = data.section  || '';
    sbEl.textContent       = fmt(data.seasonBest);
    pbEl.textContent       = fmt(data.personalBest);

    if (data.photoUrl) {
      photoEl.src = data.photoUrl;
      photoWrap.classList.remove('no-photo');
      photoWrap.style.display = '';
    } else {
      photoWrap.classList.add('no-photo');
      photoWrap.style.display = 'none';
    }

    if (data.flagUrl) {
      window.GraphicsUtils.wireFlagFallback(flagEl, flagEl);
      flagEl.src = data.flagUrl;
      flagEl.style.display = '';
    } else {
      flagEl.style.display = 'none';
    }
  }

  function animateIn(payload) {
    render(payload);
    root.classList.remove('hidden', 'out');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
  }

  function animateOut() {
    return new Promise(resolve => {
      root.classList.remove('visible');
      root.classList.add('out');
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out');
        currentVisible = false;
        resolve();
      }, 320);
    });
  }

  async function animateUpdate(payload) {
    await animateOut();
    await window.GraphicsUtils.delay(60);
    animateIn(payload);
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
        currentRevision = revision; animateIn(payload);
      } else if (visible && currentVisible) {
        currentRevision = revision; await animateUpdate(payload);
      } else {
        currentRevision = revision;
      }
    } finally {
      busy = false;
      if (queuedPayload) { const n = queuedPayload; queuedPayload = null; handlePayload(n); }
    }
  }

  new window.JsonPoller({
    url: '/data/skater-profile.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[skater-profile] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('skater-profile', handlePayload);

  // Re-render when operator changes config (caps, header text, etc.)
  window.addEventListener('graphics-config-updated', () => {
    if (lastPayload) render(lastPayload);
  });
})();
