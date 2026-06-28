(function () {
  const root = document.getElementById('msg-root');
  const line1El = document.getElementById('msg-line1');
  const line2El = document.getElementById('msg-line2');
  const textColEl = root.querySelector('.msg-text-col');

  let currentRevision = null;
  let currentVisible = false;
  let busy = false;
  let queuedPayload = null;
  let lastData = null;

  function render(data = {}) {
    lastData = data;
    const line1 = data.line1 || data.top || '';
    const line2 = data.line2 || data.bottom || '';
    window.GraphicsUtils.applyInitialsIfNeeded(line1El, line1);
    line2El.textContent = line2;
    line2El.style.display = line2 ? '' : 'none';
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
    const nextLine1 = nextData.line1 || nextData.top || '';
    const nextLine2 = nextData.line2 || nextData.bottom || '';
    const currentLine1 = line1El.textContent || '';
    const currentLine2 = line2El.textContent || '';

    if (nextLine1 === currentLine1 && nextLine2 === currentLine2) {
      render(payload.data);
      return;
    }

    textColEl.classList.add('msg-text-fading');
    await window.GraphicsUtils.delay(150);
    render(payload.data);
    requestAnimationFrame(() => textColEl.classList.remove('msg-text-fading'));
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
    url: '/data/messages.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[messages] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('messages', handlePayload);

  window.addEventListener('graphics-config-updated', () => {
    if (lastData) render(lastData);
  });
})();
