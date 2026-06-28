(function () {
  const root    = document.getElementById('tod-root');
  const labelEl = document.getElementById('tod-label');
  const valueEl = document.getElementById('tod-value');

  let config = {
    timezone:    'America/Toronto',
    format24:    true,
    showSeconds: true,
    label:       '',
  };
  let currentRevision = null;
  let currentVisible  = false;
  let rafHandle       = null;
  // Memoize a formatter — Intl.DateTimeFormat is moderately expensive to
  // construct and we'd otherwise rebuild it 60 times a second.
  let formatter = null;
  let formatterKey = '';

  function buildFormatter() {
    const key = `${config.timezone}|${config.format24}|${config.showSeconds}`;
    if (key === formatterKey && formatter) return formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone || 'America/Toronto',
        hour12:   !config.format24,
        hour:     'numeric',
        minute:   '2-digit',
        ...(config.showSeconds ? { second: '2-digit' } : {}),
      });
      formatterKey = key;
    } catch {
      // Bad timezone — fall back to browser local.
      formatter = new Intl.DateTimeFormat('en-CA', {
        hour12:   !config.format24,
        hour:     'numeric',
        minute:   '2-digit',
        ...(config.showSeconds ? { second: '2-digit' } : {}),
      });
      formatterKey = key + '|fallback';
    }
    return formatter;
  }

  function render() {
    const fmt = buildFormatter();
    // Intl produces "2:35:22 p.m." style strings on some locales; normalize.
    valueEl.textContent = fmt.format(new Date())
      .replace(/\s?a\.?m\.?$/i, ' AM')
      .replace(/\s?p\.?m\.?$/i, ' PM');
    labelEl.textContent = (config.label || '').toUpperCase();
  }

  // rAF tick is overkill for once-per-second updates but keeps things
  // animation-frame aligned and pauses correctly when the tab is hidden.
  let lastSecond = -1;
  function tick() {
    rafHandle = null;
    if (!currentVisible) return;
    const now = Date.now();
    // Only repaint when the displayed value would actually change.
    const sec = Math.floor(now / (config.showSeconds ? 1000 : 60000));
    if (sec !== lastSecond) {
      lastSecond = sec;
      render();
    }
    rafHandle = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    lastSecond = -1;
    rafHandle = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  function animateIn() {
    render(); // paint immediately so we never show the placeholder
    root.classList.remove('hidden', 'out');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
    startLoop();
  }
  function animateOut() {
    return new Promise(resolve => {
      stopLoop();
      root.classList.remove('visible');
      root.classList.add('out');
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out');
        currentVisible = false;
        resolve();
      }, 280);
    });
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    if (revision === currentRevision) return;
    currentRevision = revision;

    Object.assign(config, payload.data || {});
    // Bust the formatter cache when config changes.
    formatterKey = '';
    if (currentVisible) render();

    const visible = !!payload?.control?.visible;
    if (!visible && currentVisible) await animateOut();
    else if (visible && !currentVisible) animateIn();
  }

  new window.JsonPoller({
    url: '/data/time-of-day.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[time-of-day] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('time-of-day', handlePayload);

  // Theme/font/colour changes — repaint so new sizes land immediately.
  window.addEventListener('graphics-config-updated', () => { if (currentVisible) render(); });
})();
