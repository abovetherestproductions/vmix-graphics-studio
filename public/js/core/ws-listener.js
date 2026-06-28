/**
 * WebSocket listener — replaces JSON polling for instant control signals.
 * Falls back gracefully: if WS is unavailable, JsonPoller continues working.
 *
 * Usage: scripts that use JsonPoller should also call
 *   WsListener.subscribe('template-name', handler)
 * The handler receives the same payload shape as the JSON poller.
 */
(function () {
  const RECONNECT_DELAY = 3000;
  const subscribers = {};
  let ws = null;
  let reconnectTimer = null;

  function isPreviewMode() {
    return new URLSearchParams(window.location.search).get('preview') === '1';
  }

  function coercePreviewPayload(payload) {
    if (!isPreviewMode() || !payload || typeof payload !== 'object') return payload;
    const next = JSON.parse(JSON.stringify(payload));
    next.control = { ...(next.control || {}), visible: true, state: 'animateIn' };
    const params = new URLSearchParams(window.location.search);
    const template = next.meta?.template;

    if (template === 'rankings' && params.get('previewPage')) {
      const page = Math.max(1, Number(params.get('previewPage')) || 1);
      const data = next.data || {};

      if (data.groupedPageMode && Array.isArray(data.groupedPages) && data.groupedPages.length) {
        const pageCount = data.groupedPages.length;
        const safePage = Math.min(page, pageCount);
        data.page = safePage;
        data.pageCount = pageCount;
        data.rows = data.groupedPages[safePage - 1] || [];
        data.rowCount = data.rows.length;
        data.rowsPerPage = data.rows.length || data.rowsPerPage;
      } else if (Array.isArray(data.allRows) && data.allRows.length) {
        const rpp = Math.max(1, Number(data.rowsPerPage) || 8);
        const pageCount = Math.max(1, Math.ceil(data.allRows.length / rpp));
        const safePage = Math.min(page, pageCount);
        const start = (safePage - 1) * rpp;
        data.page = safePage;
        data.pageCount = pageCount;
        data.rows = data.allRows.slice(start, start + rpp);
        data.rowCount = data.rows.length;
      } else if (Array.isArray(data.rows)) {
        data.page = page;
        data.pageCount = Math.max(Number(data.pageCount) || page, page);
      }

      next.data = data;
      next.control.state = 'pageChange';
      next.meta.revision = `${next.meta.revision || Date.now()}-preview-page-${next.data.page || page}`;
    }
    return next;
  }

  function connect() {
    const url = `ws://${location.host}`;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      if (GraphicsConfig?.debug) console.log('[ws-listener] connected');
      clearTimeout(reconnectTimer);
    });

    ws.addEventListener('message', evt => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'update' && msg.template && msg.payload) {
        if (isPreviewMode() && msg.template === 'starting-order' && new URLSearchParams(window.location.search).get('previewGroup')) {
          return;
        }
        const handlers = subscribers[msg.template] || [];
        const payload = coercePreviewPayload(msg.payload);
        handlers.forEach(fn => fn(payload));
      }

      if (msg.type === 'config-update') {
        // Hot-reload theme without full page refresh
        if (typeof applyTheme === 'function') applyTheme();
      }
    });

    ws.addEventListener('close', () => {
      if (GraphicsConfig?.debug) console.log('[ws-listener] closed — will retry');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }

  window.WsListener = {
    isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    subscribe(template, handler) {
      if (!subscribers[template]) subscribers[template] = [];
      subscribers[template].push(handler);
    },
    unsubscribe(template, handler) {
      if (!subscribers[template]) return;
      subscribers[template] = subscribers[template].filter(fn => fn !== handler);
    },
  };

  connect();

  // ── Preview-wall "Reload" replay ────────────────────────────────────────
  // When the preview wall's Reload button is pressed, it posts {type:'preview-out'}
  // into each iframe before re-loading its src. The graphic responds by
  // running its OUT animation; the iframe reload then drives a fresh
  // animateIn — same out → in cycle the live show/hide produces.
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'preview-show') {
      // Layout tab: force graphic visible regardless of live show/hide state.
      const root = document.getElementById('graphic-root');
      if (root) {
        root.classList.add('visible');
        root.classList.remove('out', 'hidden');
      }
      return;
    }
    if (event.data?.type !== 'preview-out') return;
    const root = document.getElementById('graphic-root');
    if (!root) return;
    root.classList.remove('visible');
    root.classList.add('out');
    // No need to add `hidden` — the iframe will reload moments later.
  });
})();
