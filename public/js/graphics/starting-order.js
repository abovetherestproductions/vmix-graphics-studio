(function () {
  const root = document.getElementById("graphic-root");
  const panel = document.getElementById("panel");
  const titleEl = document.getElementById("title");
  const subtitleEl = document.getElementById("subtitle");
  const rowsEl = document.getElementById("rows");

  let currentRevision = null;
  let currentVisible = false;
  let busy = false;
  let queuedPayload = null;
  let lastPayload = null;

  function langText(en, fr) {
    return (document.documentElement.lang === 'fr' && fr) ? fr : (en || fr || '');
  }

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log("[starting-order]", ...args);
  }

  function getRowCount(payload) {
    if (payload?.data?.rowCount != null) return Number(payload.data.rowCount);
    return Array.isArray(payload?.data?.rows) ? payload.data.rows.length : 0;
  }

  function getLayoutClass(rowCount) {
    // Operator can lock the layout to one mode so every group renders with
    // the same row height + font sizes regardless of row count. Default
    // 'compact' — broadcast-consistent and fits up to 10 rows. 'auto' keeps
    // the original behaviour (large/standard/compact picked by row count).
    const lock = (window.startOrderLayoutLock || 'compact').toLowerCase();
    if (lock === 'large' || lock === 'standard' || lock === 'compact') {
      return `layout-${lock}`;
    }
    if (rowCount <= 4) return "layout-large";
    if (rowCount <= 7) return "layout-standard";
    return "layout-compact";
  }

  function clearLayoutClasses() {
    root.classList.remove("layout-large", "layout-standard", "layout-compact");
  }

  function buildRow(row) {
    const rowEl = document.createElement("div");
    rowEl.className = "so-row";

    const posEl = document.createElement("div");
    posEl.className = "so-pos";
    posEl.textContent = row.position ?? "";

    const flagWrap = document.createElement("div");
    flagWrap.className = "so-flag-wrap";

    if (row.flagUrl) {
      const flagEl = document.createElement("img");
      flagEl.className = "so-flag";
      flagEl.alt = "";
      flagWrap.appendChild(flagEl);
      // Hide the wrap entirely if the asset is missing from /assets/flags/.
      window.GraphicsUtils.wireFlagFallback(flagEl, flagWrap);
      flagEl.src = row.flagUrl;
    }

    const mainEl = document.createElement("div");
    mainEl.className = "so-main";

    const nameEl = document.createElement("div");
    nameEl.className = "so-name";
    window.GraphicsUtils.applyInitialsIfNeeded(nameEl, row.name || '');

    const clubEl = document.createElement("div");
    clubEl.className = "so-club";
    clubEl.textContent = row.club || "";

    mainEl.appendChild(nameEl);
    mainEl.appendChild(clubEl);

    rowEl.appendChild(posEl);
    rowEl.appendChild(flagWrap);
    rowEl.appendChild(mainEl);

    return rowEl;
  }

  function render(payload) {
    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    const rowCount = getRowCount(payload);

    const data = payload?.data || {};
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('starting-order', data, 'Starting Order');
    window.GraphicsUtils.fitTitleOneLine(titleEl);
    // Group subtitle is intentionally suppressed — strip any residual "Group N" / "Groupe N"
    const rawSub = window.GraphicsUtils.resolveSubtitle('starting-order', data, '');
    subtitleEl.textContent = /^(Group|Groupe)\s+\d+$/i.test((rawSub || '').trim()) ? '' : rawSub;

    clearLayoutClasses();
    root.classList.add(getLayoutClass(rowCount));

    rowsEl.innerHTML = "";
    rows.forEach((row) => rowsEl.appendChild(buildRow(row)));
  }

  function animatePanelIn(duration) {
    root.classList.remove("hidden");
    panel.style.transitionDuration = `${duration}ms`;
    requestAnimationFrame(() => {
      root.classList.add("visible");
    });
    currentVisible = true;
  }

  function animateRowsIn(duration = 360, stagger = 60) {
    const rows = rowsEl.querySelectorAll(".so-row");
    rows.forEach((row, index) => {
      row.style.transitionDuration = `${duration}ms`;
      row.style.transitionDelay = `${index * stagger}ms`;
      requestAnimationFrame(() => row.classList.add("row-in"));
    });
  }

  function animateRowsOut(duration = 0) {
    // Reset to the pre-cascade state (no row-by-row exit animation —
    // OUT is a single panel fade handled by animatePanelOut).
    const rows = rowsEl.querySelectorAll(".so-row");
    rows.forEach((row) => {
      row.style.transitionDuration = `${duration}ms`;
      row.style.transitionDelay = "0ms";
      row.classList.remove("row-in");
    });
  }

  // Fade-out of the entire panel. Duration is overridable so animateOut can
  // stretch it to overlap the rows-area roll-up.
  function animatePanelOut(durationMs = 360) {
    return new Promise((resolve) => {
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

  async function animateIn(payload, duration) {
    render(payload);
    rowsEl.querySelectorAll('.so-row').forEach((row) => {
      row.style.transitionDuration = '0ms';
      row.classList.add('row-in');
    });
    rowsEl.style.maxHeight = '0px';
    void rowsEl.offsetHeight;
    rowsEl.style.transition = 'max-height 620ms cubic-bezier(0.83, 0, 0.17, 1)';
    animatePanelIn(duration);
    await window.GraphicsUtils.delay(120);
    rowsEl.style.maxHeight = `${rowsEl.scrollHeight}px`;
    await window.GraphicsUtils.delay(660);
    rowsEl.style.maxHeight = '';
    rowsEl.style.transition = '';
  }

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

  // Track current group so we can detect group changes
  let currentGroupNumber = null;

  async function animateUpdate(payload) {
    // Live data refresh — snap the new content in place with no cascade.
    // Cascade is reserved for the initial show + group changes.
    render(payload);
    animateRowsIn(0, 0);
  }

  /**
   * Group change: header stays frozen (title = same segment name),
   * subtitle updates immediately, rows cascade down on the new group.
   */
  async function animateGroupChange(payload) {
    const data = payload?.data || {};
    const rawSub = window.GraphicsUtils.resolveSubtitle('starting-order', data, '');
    subtitleEl.textContent = /^(Group|Groupe)\s+\d+$/i.test((rawSub || '').trim()) ? '' : rawSub;

    // Reset rows, render the new group, then cascade them down.
    animateRowsOut(0);
    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    const rowCount = getRowCount(payload);
    clearLayoutClasses();
    root.classList.add(getLayoutClass(rowCount));
    rowsEl.innerHTML = "";
    rows.forEach((row) => rowsEl.appendChild(buildRow(row)));
    await window.GraphicsUtils.delay(16);
    animateRowsIn(360, 60);
  }

  async function handlePayload(payload) {
    if (!payload?.meta) return;

    const revision = payload.meta.revision;
    const visible = !!payload?.control?.visible;
    const state = payload?.control?.state || "auto";
    const duration = payload?.control?.durationMs || 700;
    const incomingGroup = payload?.data?.groupNumber ?? null;

    if (revision === currentRevision) return;

    if (busy) {
      queuedPayload = payload;
      return;
    }

    busy = true;
    log("payload", { revision, visible, state, duration, group: incomingGroup });

    try {
      if (!visible && currentVisible) {
        currentRevision = revision;
        currentGroupNumber = null;
        await animateOut(duration);
      } else if (visible && !currentVisible) {
        currentRevision = revision; lastPayload = payload;
        currentGroupNumber = incomingGroup;
        await animateIn(payload, duration);
      } else if (visible && currentVisible) {
        currentRevision = revision; lastPayload = payload;
        const groupChanged = incomingGroup !== null && incomingGroup !== currentGroupNumber;
        currentGroupNumber = incomingGroup;
        if (groupChanged) {
          await animateGroupChange(payload);
        } else {
          await animateUpdate(payload, duration);
        }
      } else {
        currentRevision = revision; lastPayload = payload;
      }
    } finally {
      busy = false;

      if (queuedPayload) {
        const next = queuedPayload;
        queuedPayload = null;
        handlePayload(next);
      }
    }
  }

  // Re-render title when language switches
  window.addEventListener('graphics-config-updated', () => {
    // Always re-resolve, even before any payload has arrived — this makes
    // titleSource='custom'/'event' immediately reflect dropdown changes.
    const data = lastPayload?.data || {};
    titleEl.textContent    = window.GraphicsUtils.resolveTitle('starting-order', data, 'Starting Order');
    window.GraphicsUtils.fitTitleOneLine(titleEl);
    const rawSub2 = window.GraphicsUtils.resolveSubtitle('starting-order', data, '');
    subtitleEl.textContent = /^(Group|Groupe)\s+\d+$/i.test((rawSub2 || '').trim()) ? '' : rawSub2;
  });

  // JSON polling — fallback / initial load
  const poller = new window.JsonPoller({
    url: "/data/starting-order.json",
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: (error) => console.error("Starting order poll error:", error),
  });
  poller.start();

  // WebSocket — instant updates when available
  if (window.WsListener) {
    window.WsListener.subscribe('starting-order', handlePayload);
  }
})();
