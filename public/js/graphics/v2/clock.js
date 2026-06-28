(function () {
  const root     = document.getElementById('clk-root');
  const labelEl  = document.getElementById('clock-label');
  const valueEl  = document.getElementById('clock-value');

  // Authoritative state from the server. The displayed value is computed
  // locally from these numbers each animation frame — server only broadcasts
  // when state changes (start / pause / stop / reset), not on every tick.
  let state = {
    mode:        'countdown',
    startedAt:   null,
    durationMs:  0,
    running:     false,
    pausedAtMs:  0,
    label:       '',
    finishedAt:  null,
  };
  let currentRevision = null;
  let currentVisible  = false;
  let rafHandle       = null;

  function fmt(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function elapsed() {
    if (state.startedAt == null) return Math.max(0, state.pausedAtMs || 0);
    if (state.running) return Date.now() - state.startedAt;
    return Math.max(0, state.pausedAtMs || 0);
  }

  function remaining() {
    return Math.max(0, (state.durationMs || 0) - elapsed());
  }

  function tick() {
    rafHandle = null;
    let displayMs;
    let finished = false;
    if (state.mode === 'countdown') {
      displayMs = remaining();
      finished = displayMs <= 0 && state.durationMs > 0;
    } else {
      displayMs = elapsed();
    }
    valueEl.textContent = fmt(displayMs);

    // Final-10s warning (countdown only, while still running)
    const inWarning = state.mode === 'countdown' && state.running && !finished
      && displayMs > 0 && displayMs <= 10000;
    root.classList.toggle('warn', inWarning);
    root.classList.toggle('finished', finished);

    // Keep ticking only when there's something to update. Stops the rAF loop
    // when the clock is paused, finished, or off-air to save CPU.
    if (currentVisible && state.running && !finished) {
      rafHandle = requestAnimationFrame(tick);
    } else if (finished && !state.finishedAt) {
      // Memo the moment we crossed zero so the operator UI can show it
      // (the server doesn't know we hit zero unless told).
      state.finishedAt = Date.now();
    }
  }

  function startLoop() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  function applyState(data) {
    state = Object.assign({
      mode: 'countdown', startedAt: null, durationMs: 0, running: false,
      pausedAtMs: 0, label: '', finishedAt: null,
    }, data || {});
    labelEl.textContent = (state.label || '').toUpperCase();
    // Render immediately so paused/stopped clocks show their value without
    // waiting for a rAF tick.
    tick();
    if (state.running) startLoop(); else stopLoop();
  }

  function animateIn() {
    root.classList.remove('hidden', 'out');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
    if (state.running) startLoop();
  }
  function animateOut() {
    return new Promise(resolve => {
      stopLoop();
      root.classList.remove('visible');
      root.classList.add('out');
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out', 'warn', 'finished');
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

    const visible = !!payload?.control?.visible;
    applyState(payload.data || {});

    if (!visible && currentVisible) await animateOut();
    else if (visible && !currentVisible) animateIn();
    // visible+currentVisible: state already updated in applyState
  }

  // Polling fallback (so a freshly-loaded graphic page picks up state even
  // without the WebSocket).
  new window.JsonPoller({
    url: '/data/clock.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[clock] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('clock', handlePayload);

  // Re-apply theme variables (font sizes etc.) when operator changes config
  window.addEventListener('graphics-config-updated', () => { tick(); });
})();
