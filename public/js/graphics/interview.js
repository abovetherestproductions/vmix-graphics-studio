(function () {
  const root = document.getElementById('graphic-root');
  const line1El = document.getElementById('lt-line1');
  const line2El = document.getElementById('lt-line2');
  const textColEl = root.querySelector('.lt-text-col');
  const flagWrapEl = document.getElementById('lt-flag-wrap');
  const flagImgEl  = document.getElementById('lt-flag');

  let currentRevision = null;
  let currentVisible = false;
  let busy = false;
  let queuedPayload = null;
  let lastData = null;

  // Line 2 for auto-filled data follows the operator's "Line 2 Source" layout
  // setting (Club / Category / Custom). Explicit pushes from the interview
  // panel/page carry source:'manual' and always show their line2 as-is.
  function resolveLine2(data) {
    if ((data.source || 'auto') === 'manual') return data.line2 || '';
    const ovr = window.configHeaderOverrides?.['interview'] || {};
    const src = ovr.ltLine2Source || 'club';
    if (src === 'category') return data.categoryName || '';
    if (src === 'custom')   return ovr.ltLine2Custom || '';
    return data.club || data.line2 || '';
  }

  function render(data = {}) {
    lastData = data;
    const name = data.line1 || data.name || '';
    const sub  = resolveLine2(data);
    window.GraphicsUtils.applyInitialsIfNeeded(line1El, name);
    line2El.textContent = sub;
    line2El.style.display = sub ? '' : 'none';

    // Flag: needs a flagUrl in the data AND the operator toggle left on.
    if (flagWrapEl && flagImgEl) {
      const flagUrl = String(data.flagUrl || '').trim();
      const showFlag = window.configHeaderOverrides?.['interview']?.ltShowFlag !== false;
      if (flagUrl && showFlag) {
        window.GraphicsUtils.wireFlagFallback(flagImgEl, flagWrapEl);
        if (flagImgEl.getAttribute('src') !== flagUrl) flagImgEl.src = flagUrl;
        flagWrapEl.style.display = '';
      } else {
        flagWrapEl.style.display = 'none';
        flagImgEl.removeAttribute('src');
      }
    }
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
    const nextLine2 = resolveLine2(nextData);
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
    url: '/data/interview.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[interview] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('interview', handlePayload);

  window.addEventListener('graphics-config-updated', () => {
    if (lastData) render(lastData);
  });
})();
