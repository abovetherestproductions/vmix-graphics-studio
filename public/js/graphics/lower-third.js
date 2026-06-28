(function () {
  const root      = document.getElementById('graphic-root');
  const line1El   = document.getElementById('lt-line1');
  const line2El   = document.getElementById('lt-line2');
  const flagWrap  = document.getElementById('lt-flag-wrap');
  const flagEl    = document.getElementById('lt-flag');
  const logoWrap  = document.getElementById('lt-logo-wrap');
  const logoEl    = document.getElementById('lt-logo');
  const infoCardEl = document.getElementById('lt-info-card');
  const infoCategoryEl = document.getElementById('lt-info-category');
  const infoSegmentEl = document.getElementById('lt-info-segment');
  const infoGroupEl = document.getElementById('lt-info-group');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let autoHideTimer   = null;
  let lastData        = null;

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[lower-third]', ...args);
  }

  function groupLabelFromData(data = {}) {
    const explicit = data.groupNumber ?? data.group ?? data.groupNo;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
      return `Group ${String(explicit).trim()}`;
    }

    const category = data.categoryName || data.category || '';
    const match = String(category).match(/\bgroup\s*([A-Za-z0-9]+)\b/i);
    return match ? `Group ${match[1]}` : '';
  }

  function categoryWithoutParsedGroup(category, groupLabel) {
    if (!category || !groupLabel) return category || '';
    const groupNumber = groupLabel.replace(/^group\s*/i, '').trim();
    return String(category)
      .replace(new RegExp(`\\s*[-–—]?\\s*group\\s*${groupNumber}\\s*$`, 'i'), '')
      .trim();
  }

  function setInfoLine(element, value) {
    if (!element) return false;
    const text = String(value || '').trim();
    element.replaceChildren();
    if (text) element.textContent = text;
    element.classList.toggle('is-visible', !!text);
    return !!text;
  }

  function renderInfoCard(data = {}) {
    if (!infoCardEl) return;
    const lang = document.documentElement.lang || 'en';
    // Precedence (highest first):
    //   1. Per-template ltInfoText (set on the lower-third card's "Detail
    //      Card → Override") — most specific.
    //   2. Global Detail Override (top-of-operator field) — applies to both
    //      info-card graphics at once.
    //   3. Auto-built "Category Segment Group" string, where category is
    //      itself overridable via the global header title override.
    const override = window.configHeaderOverrides?.['lower-third']?.ltInfoText || '';
    const globalDetail = lang === 'fr'
      ? (window.globalDetailOverrideFr || window.globalDetailOverride || '')
      : (window.globalDetailOverride   || window.globalDetailOverrideFr || '');
    const groupLabel = groupLabelFromData(data);
    const rawCategory = data.categoryName || data.category || '';
    const fedCategory = categoryWithoutParsedGroup(rawCategory, groupLabel);
    const globalCategory = lang === 'fr'
      ? (window.globalHeaderOverrideFr || window.globalHeaderOverride || '')
      : (window.globalHeaderOverride   || window.globalHeaderOverrideFr || '');
    // Strip the redundant "Singles" word for singles events. Pairs/Dance
    // categories pass through unchanged. Operator overrides above take
    // priority, so this only affects the auto-built path.
    const categoryClean = window.GraphicsUtils.cleanCategoryName(
      (globalCategory || '').trim() || fedCategory
    );
    const category = categoryClean || ((globalCategory || '').trim() || fedCategory);
    const segment = data.segmentName || data.segment || data.segmentType || '';
    // Group label intentionally dropped from the auto-built string — operators
    // don't want "Group N" cluttering the lower-third detail line. The group
    // value is still parsed (and used to strip the trailing sub-category
    // number from `fedCategory`), it's just not displayed here.
    const details = override.trim()
      || globalDetail.trim()
      || [category, segment].filter(Boolean).join(' ');

    const hasInfo = setInfoLine(infoCategoryEl, details);
    setInfoLine(infoSegmentEl, '');
    setInfoLine(infoGroupEl, '');

    infoCardEl.classList.toggle('has-info', hasInfo);
    infoCardEl.setAttribute('aria-hidden', hasInfo ? 'false' : 'true');
  }

  function render(data) {
    lastData = data;
    const name = data.line1 || data.name  || '';
    const club = data.line2 || data.club  || data.role || '';

    window.GraphicsUtils.applyInitialsIfNeeded(line1El, name);
    line2El.textContent = club;
    line2El.style.display = club ? '' : 'none';

    // Flag — right side. Hides itself if the asset 404s (unknown flag) so a
    // broken-image icon never makes it on air.
    if (data.flagUrl) {
      window.GraphicsUtils.wireFlagFallback(flagEl, flagWrap);
      flagEl.src = data.flagUrl;
      flagWrap.style.display = '';
    } else {
      flagEl.src = '';
      flagWrap.style.display = 'none';
    }

    // Logo show/hide is controlled by theme-loader (logoShow config in operator)
    // Only override the src if the data payload provides a specific logo URL
    if (data.logoUrl) {
      logoEl.src = data.logoUrl;
    }
    // Do NOT touch logoWrap.style.display — theme-loader manages it

    renderInfoCard(data);
  }

  function animateIn(payload) {
    clearTimeout(autoHideTimer);
    render(payload.data);
    root.classList.remove('hidden', 'out');
    // Double-rAF: first frame settles new content and pre-warms the GPU layer;
    // second frame starts the transition so it begins from a ready state.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;

    const hold = payload.control?.holdMs;
    if (hold && hold > 0) {
      autoHideTimer = setTimeout(() => animateOut(), hold);
    }
  }

  function animateOut() {
    return new Promise(resolve => {
      clearTimeout(autoHideTimer);
      root.classList.remove('visible');
      root.classList.add('out');
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out');
        currentVisible = false;
        resolve();
      }, 380);
    });
  }

  async function animateUpdate(payload) {
    root.style.opacity = '0';
    await window.GraphicsUtils.delay(160);
    render(payload.data);
    root.style.opacity = '';
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    const visible  = !!payload?.control?.visible;

    if (revision === currentRevision) return;
    if (busy) { queuedPayload = payload; return; }

    busy = true;
    log('payload', { revision, visible });

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
      if (queuedPayload) {
        const next = queuedPayload; queuedPayload = null;
        handlePayload(next);
      }
    }
  }

  new window.JsonPoller({
    url: '/data/lower-third.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[lower-third] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('lower-third', handlePayload);

  // Re-render when operator changes config (caps, header text, etc.)
  window.addEventListener('graphics-config-updated', () => {
    if (lastData) render(lastData);
  });
})();
