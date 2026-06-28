(function () {
  const root = document.getElementById('graphic-root');
  const line1El = document.getElementById('lt-line1');
  const line2El = document.getElementById('lt-line2');
  const textColEl = root.querySelector('.lt-text-col');
  const flagWrapEl = document.getElementById('lt-flag-wrap');
  const flagImgEl  = document.getElementById('lt-flag');
  const infoCardEl = document.getElementById('lt-info-card');
  const infoCategoryEl = document.getElementById('lt-info-category');
  const infoSegmentEl = document.getElementById('lt-info-segment');
  const infoGroupEl = document.getElementById('lt-info-group');

  let currentRevision = null;
  let currentVisible = false;
  let busy = false;
  let queuedPayload = null;
  let lastData = null;

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
    // Same precedence chain as the lower-third info card:
    //   1. Per-template ltInfoText (most specific)
    //   2. Global Detail Override (operator-level)
    //   3. Fall back to whatever the workbook's Category column says.
    const override = window.configHeaderOverrides?.['manual-skater']?.ltInfoText || '';
    const globalDetail = lang === 'fr'
      ? (window.globalDetailOverrideFr || window.globalDetailOverride || '')
      : (window.globalDetailOverride   || window.globalDetailOverrideFr || '');
    // Strip redundant "Singles" from the workbook category for singles
    // events. Pairs/Dance categories pass through unchanged.
    const rawCat = String(data.category || '').trim();
    const cleanedCat = window.GraphicsUtils.cleanCategoryName(rawCat) || rawCat;
    const details = override.trim()
      || globalDetail.trim()
      || cleanedCat;

    const hasInfo = setInfoLine(infoCategoryEl, details);
    setInfoLine(infoSegmentEl, '');
    setInfoLine(infoGroupEl, '');

    infoCardEl.classList.toggle('has-info', hasInfo);
    infoCardEl.setAttribute('aria-hidden', hasInfo ? 'false' : 'true');
  }

  function render(data = {}) {
    lastData = data;
    const name = data.line1 || data.name || '';
    const club = data.line2 || data.club || '';
    window.GraphicsUtils.applyInitialsIfNeeded(line1El, name);
    line2El.textContent = club;
    line2El.style.display = club ? '' : 'none';

    // Flag box: show only when a flagUrl is wired in via the Flag column.
    if (flagWrapEl && flagImgEl) {
      const flagUrl = String(data.flagUrl || '').trim();
      if (flagUrl) {
        window.GraphicsUtils.wireFlagFallback(flagImgEl, flagWrapEl);
        if (flagImgEl.getAttribute('src') !== flagUrl) flagImgEl.src = flagUrl;
        flagWrapEl.style.display = '';
      } else {
        flagWrapEl.style.display = 'none';
        flagImgEl.removeAttribute('src');
      }
    }

    renderInfoCard(data);
  }

  function animateIn(payload) {
    render(payload.data);
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
      }, 380);
    });
  }

  async function animateUpdate(payload) {
    const nextData = payload.data || {};
    const nextLine1 = nextData.line1 || nextData.name || '';
    const nextLine2 = nextData.line2 || nextData.club || '';
    const currentLine1 = line1El.textContent || '';
    const currentLine2 = line2El.textContent || '';

    if (nextLine1 === currentLine1 && nextLine2 === currentLine2) {
      render(payload.data);
      return;
    }

    textColEl.classList.add('lt-text-fading');
    await window.GraphicsUtils.delay(150);
    render(payload.data);
    requestAnimationFrame(() => textColEl.classList.remove('lt-text-fading'));
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    const visible = !!payload?.control?.visible;

    if (revision === currentRevision) return;
    if (busy) { queuedPayload = payload; return; }

    busy = true;
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
    url: '/data/manual-skater.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[manual-skater] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('manual-skater', handlePayload);

  window.addEventListener('graphics-config-updated', () => {
    if (lastData) render(lastData);
  });
})();
