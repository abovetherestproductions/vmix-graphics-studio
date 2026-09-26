(function () {
  const root       = document.getElementById('graphic-root');
  const photoWrap  = document.getElementById('sp-photo-wrap');
  const photoEl    = document.getElementById('sp-photo');
  const photo2Slot = document.getElementById('sp-photo-slot-2');
  const photo2El   = document.getElementById('sp-photo-2');
  const detailsEl  = document.getElementById('sp-details');
  const bioEl      = document.getElementById('sp-bio');
  const pbEventEl  = document.getElementById('sp-pb-event');
  const statSbEl   = document.getElementById('stat-sb');
  const statPbEl   = document.getElementById('stat-pb');
  const eventEl    = document.getElementById('sp-event');
  const subtitleEl = document.getElementById('sp-subtitle');
  const nameEl     = document.getElementById('sp-name');
  const clubEl     = document.getElementById('sp-club');
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

  function fmt(n) {
    if (n == null || n === '') return '—';
    const num = Number(n);
    return Number.isFinite(num) ? num.toFixed(2) : '—';
  }

  /**
   * Which optional rows the operator has switched on for this graphic.
   *
   * Every detail defaults to OFF and the two score tiles default to ON, so a
   * graphic with no settings saved renders exactly as it did before any of
   * this existed.
   */
  function shown() {
    const o = (window.configHeaderOverrides || {})['skater-profile'] || {};
    return {
      // Detail rows are opt-in and named by their data-field, so a new row
      // needs nothing here beyond its markup and its switch.
      row: field => o['spShow' + field.charAt(0).toUpperCase() + field.slice(1)] === true,
      bio:          o.spShowBio          === true,
      pbEvent:      o.spShowPbEvent      === true,
      seasonBest:   o.spShowSeasonBest   !== false,
      personalBest: o.spShowPersonalBest !== false,
    };
  }


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
    // Second line. Defaults to the category, which on this graphic is the
    // discipline — "Men", "Ice Dance". Empty collapses the line rather than
    // leaving a gap under the title.
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle(
      'skater-profile', data, ''
    );
    // Teams get a line each so both names stay whole; singles keep the
    // existing behaviour, including the shrink-to-initials fallback.
    const twoNames = !!(data.skater1Name && data.skater2Name);
    nameEl.classList.toggle('is-team', twoNames);
    nameEl.textContent = '';
    delete nameEl.dataset.initialsInput; // clear the initials memo either way
    if (twoNames) {
      for (const who of [data.skater1Name, data.skater2Name]) {
        const line = document.createElement('div');
        line.className = 'sp-name-line';
        line.textContent = who;
        nameEl.appendChild(line);
      }
    } else {
      window.GraphicsUtils.applyInitialsIfNeeded(nameEl, data.name || '');
    }
    clubEl.textContent     = data.club     || '';
    sbEl.textContent       = fmt(data.seasonBest);
    pbEl.textContent       = fmt(data.personalBest);

    const show = shown();

    // Score tiles. Hiding both collapses the row rather than leaving a gap.
    statSbEl.hidden = !show.seasonBest;
    statPbEl.hidden = !show.personalBest;
    const pbEvent = show.pbEvent && show.personalBest && (data.personalBestEvent || '');
    pbEventEl.hidden = !pbEvent;
    pbEventEl.textContent = pbEvent || '';

    // Optional detail rows — a row appears only when switched on AND the
    // feed actually has something for it, so an empty label never airs.
    let anyDetail = false;
    detailsEl.querySelectorAll('.sp-detail').forEach(rowEl => {
      const field = rowEl.dataset.field;
      const value = (data[field] || '').toString().trim();
      const on    = show.row(field) && !!value;
      rowEl.hidden = !on;
      if (on) {
        rowEl.querySelector('.sp-detail-value').textContent = value;
        anyDetail = true;
      }
    });
    detailsEl.hidden = !anyDetail;

    const bio = show.bio && (data.bio || '').trim();
    bioEl.hidden = !bio;
    bioEl.textContent = bio || '';

    if (data.photoUrl) {
      photoEl.src = data.photoUrl;
      photoWrap.classList.remove('no-photo');
      photoWrap.style.display = '';
    } else {
      photoWrap.classList.add('no-photo');
      photoWrap.style.display = 'none';
    }

    // Two portraits for a pairs or dance team. Driven by the second photo
    // actually being there rather than by an isTeam flag, so a team whose
    // partner portrait never made it into the cache degrades to the single
    // layout instead of showing an empty frame.
    const hasSecond = !!data.photoUrl2 && !!data.photoUrl;
    photo2Slot.hidden = !hasSecond;
    photoWrap.classList.toggle('is-team', hasSecond);
    if (hasSecond) photo2El.src = data.photoUrl2;
    else photo2El.removeAttribute('src');

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
