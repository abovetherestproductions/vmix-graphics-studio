(function () {
  const STORAGE_KEY = 'vmix-preview-wall-v1';
  const BASE_WIDTH = 1920;

  const GRAPHICS = [
    { id: 'starting-order', title: 'Starting Order', path: '/graphics/starting-order/?preview=1' },
    { id: 'scoring', title: 'Scoring Display', path: '/graphics/scoring/?preview=1' },
    { id: 'lower-third', title: 'Lower Third', path: '/graphics/lower-third/?preview=1' },
    { id: 'standings', title: 'Rank 6 Context', path: '/graphics/standings/?preview=1' },
    { id: 'officials', title: 'Officials', path: '/graphics/officials/?preview=1' },
    { id: 'elements', title: 'Elements Tracker', path: '/graphics/elements/?preview=1' },
    { id: 'skater-profile', title: 'Skater Profile', path: '/graphics/skater-profile/?preview=1' },
    { id: 'rankings', title: 'Rankings', path: '/graphics/rankings/?preview=1' },
    { id: 'messages', title: 'Messages', path: '/graphics/messages/?preview=1' },
    { id: 'manual-skater', title: 'Manual Skater', path: '/graphics/manual-skater/?preview=1' },
    { id: 'clock', title: 'Clock (Countdown / Count-up)', path: '/graphics/clock/?preview=1' },
    { id: 'time-of-day', title: 'Time of Day', path: '/graphics/time-of-day/?preview=1' },
  ];

  const byId = new Map(GRAPHICS.map(item => [item.id, item]));
  const $ = id => document.getElementById(id);
  const wall = $('wall');
  const controlList = $('control-list');
  const tileSize = $('tile-size');
  const tileSizeValue = $('tile-size-value');
  let draggedId = null;
  let previewMeta = {
    'starting-order': { availableGroups: [] },
    rankings: { pageCount: 0 },
  };

  function defaultState() {
    return {
      enabled: Object.fromEntries(GRAPHICS.map(item => [item.id, true])),
      order: GRAPHICS.map(item => item.id),
      tileSize: 420,
      sidebarHidden: false,
      selections: {
        'starting-order': { group: null },
        rankings: { page: null },
      },
      views: Object.fromEntries(GRAPHICS.map(item => [item.id, { zoom: 1, x: 0, y: 0 }])),
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    const state = { ...base, ...(raw || {}) };
    const knownOrder = Array.isArray(state.order) ? state.order.filter(id => byId.has(id)) : [];
    state.order = [...knownOrder, ...GRAPHICS.map(item => item.id).filter(id => !knownOrder.includes(id))];
    state.enabled = { ...base.enabled, ...(state.enabled || {}) };
    state.views = { ...base.views, ...(state.views || {}) };
    state.selections = {
      ...base.selections,
      ...(state.selections || {}),
      'starting-order': { ...base.selections['starting-order'], ...((state.selections || {})['starting-order'] || {}) },
      rankings: { ...base.selections.rankings, ...((state.selections || {}).rankings || {}) },
    };
    state.tileSize = Math.min(760, Math.max(260, Number(state.tileSize) || base.tileSize));
    return state;
  }

  function loadState() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function graphicList() {
    return state.order.map(id => byId.get(id)).filter(Boolean);
  }

  function render() {
    document.body.classList.toggle('menu-hidden', !!state.sidebarHidden);
    $('menu-toggle').textContent = state.sidebarHidden ? 'Show Menu' : 'Hide Menu';
    document.documentElement.style.setProperty('--tile-min', `${state.tileSize}px`);
    tileSize.value = state.tileSize;
    tileSizeValue.textContent = `${state.tileSize}px`;
    renderControls();
    renderTiles();
    requestAnimationFrame(updateIframeScales);
    saveState();
    refreshPreviewMeta();
  }

  function renderControls() {
    controlList.innerHTML = '';
    graphicList().forEach(item => {
      const row = document.createElement('label');
      row.className = 'control-row';
      row.draggable = true;
      row.dataset.id = item.id;
      row.innerHTML = `
        <input type="checkbox" ${state.enabled[item.id] ? 'checked' : ''} />
        <span>
          <span class="control-title">${escapeHtml(item.title)}</span>
          <span class="control-path">${escapeHtml(item.path)}</span>
        </span>
      `;
      row.querySelector('input').addEventListener('change', event => {
        state.enabled[item.id] = event.target.checked;
        render();
      });
      wireDrag(row);
      controlList.appendChild(row);
    });
  }

  function renderTiles() {
    const visible = graphicList().filter(item => state.enabled[item.id]);
    wall.innerHTML = '';
    if (!visible.length) {
      wall.innerHTML = '<div class="empty-state">No previews are enabled. Use All On or enable graphics in the menu.</div>';
      return;
    }

    visible.forEach(item => {
      const view = getView(item.id);
      const tile = document.createElement('article');
      tile.className = 'tile';
      tile.dataset.id = item.id;
      tile.innerHTML = `
        <header class="tile-header">
          <div>
            <div class="tile-title">${escapeHtml(item.title)}</div>
            <div class="tile-path">${escapeHtml(getPreviewPath(item))}</div>
          </div>
          <div class="tile-header-actions">
            ${previewButtons(item)}
            <button type="button" data-action="reload">Reload</button>
          </div>
        </header>
        <div class="tile-controls">
          ${rangeControl(item.id, 'zoom', 'Zoom', 0.3, 2.5, 0.05, view.zoom)}
          ${rangeControl(item.id, 'x', 'X Pan', -700, 700, 5, view.x)}
          ${rangeControl(item.id, 'y', 'Y Pan', -400, 400, 5, view.y)}
          <button type="button" data-action="reset-view">Reset View</button>
        </div>
        <div class="preview-frame">
          <iframe title="${escapeHtml(item.title)}" src="${escapeHtml(getPreviewPath(item))}" loading="eager" allowtransparency="true"></iframe>
        </div>
      `;
      tile.querySelector('[data-action="reload"]').addEventListener('click', () => reloadTile(tile));
      tile.querySelectorAll('[data-preview-group]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          setPreviewSelection('starting-order', { group: Number(button.dataset.previewGroup) });
        });
      });
      tile.querySelectorAll('[data-preview-page]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          setPreviewSelection('rankings', { page: Number(button.dataset.previewPage) });
        });
      });
      shieldTileControls(tile);
      tile.querySelector('[data-action="reset-view"]').addEventListener('click', () => {
        state.views[item.id] = { zoom: 1, x: 0, y: 0 };
        render();
      });
      tile.querySelectorAll('input[type="range"]').forEach(input => {
        input.addEventListener('input', event => {
          const key = event.target.dataset.key;
          const targetView = getView(item.id);
          targetView[key] = Number(event.target.value);
          applyView(tile, item.id);
          saveState();
        });
      });
      wireDrag(tile.querySelector('.tile-header'), tile);
      wall.appendChild(tile);
      tile.querySelector('iframe').addEventListener('load', event => makeIframeTransparent(event.target));
      applyView(tile, item.id);
    });
  }

  function rangeControl(id, key, label, min, max, step, value) {
    return `
      <div>
        <label for="${id}-${key}">${label}</label>
        <input id="${id}-${key}" data-key="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
      </div>
    `;
  }

  function getPreviewPath(item) {
    const url = new URL(item.path, window.location.origin);
    url.searchParams.set('preview', '1');
    if (item.id === 'starting-order') {
      const group = Number(state.selections?.['starting-order']?.group);
      if (group > 0) url.searchParams.set('previewGroup', String(group));
    }
    if (item.id === 'rankings') {
      const page = Number(state.selections?.rankings?.page);
      if (page > 0) url.searchParams.set('previewPage', String(page));
    }
    return `${url.pathname}${url.search}`;
  }

  function previewButtons(item) {
    if (item.id === 'starting-order') {
      const groups = previewMeta['starting-order'].availableGroups || [];
      const active = Number(state.selections?.['starting-order']?.group) || Number(groups[0]) || 1;
      return groups.map(group => `
        <button type="button" class="mini-toggle ${Number(group) === active ? 'active' : ''}" data-preview-group="${Number(group)}">G${Number(group)}</button>
      `).join('');
    }

    if (item.id === 'rankings') {
      const pageCount = Number(previewMeta.rankings.pageCount) || 0;
      const active = Number(state.selections?.rankings?.page) || 1;
      return Array.from({ length: pageCount }, (_, idx) => idx + 1).map(page => `
        <button type="button" class="mini-toggle ${page === active ? 'active' : ''}" data-preview-page="${page}">P${page}</button>
      `).join('');
    }

    return '';
  }

  function setPreviewSelection(id, patch) {
    state.selections[id] = { ...(state.selections[id] || {}), ...patch };
    saveState();

    const tile = [...document.querySelectorAll('.tile')].find(candidate => candidate.dataset.id === id);
    const item = byId.get(id);
    if (!tile || !item) {
      render();
      return;
    }

    const path = getPreviewPath(item);
    const pathEl = tile.querySelector('.tile-path');
    const iframe = tile.querySelector('iframe');
    if (pathEl) pathEl.textContent = path;
    if (iframe) iframe.src = path;
    renderPreviewButtons(tile, item);
  }

  function renderPreviewButtons(tile, item) {
    const actions = tile.querySelector('.tile-header-actions');
    if (!actions) return;
    actions.innerHTML = `${previewButtons(item)}<button type="button" data-action="reload">Reload</button>`;
    actions.querySelector('[data-action="reload"]').addEventListener('click', () => reloadTile(tile));
    actions.querySelectorAll('[data-preview-group]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        setPreviewSelection('starting-order', { group: Number(button.dataset.previewGroup) });
      });
    });
    actions.querySelectorAll('[data-preview-page]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        setPreviewSelection('rankings', { page: Number(button.dataset.previewPage) });
      });
    });
    shieldTileControls(tile);
  }

  let previewMetaRefreshInFlight = false;
  async function refreshPreviewMeta() {
    if (previewMetaRefreshInFlight) return;
    previewMetaRefreshInFlight = true;
    try {
      const [startOrder, rankings] = await Promise.all([
        fetchJson('/data/starting-order.json'),
        fetchJson('/data/rankings.json'),
      ]);
      const nextMeta = {
        'starting-order': {
          availableGroups: Array.isArray(startOrder?.data?.availableGroups) ? startOrder.data.availableGroups : [],
        },
        rankings: {
          pageCount: Number(rankings?.data?.pageCount)
            || (Array.isArray(rankings?.data?.groupedPages) ? rankings.data.groupedPages.length : 0)
            || (Array.isArray(rankings?.data?.allRows)
              ? Math.max(1, Math.ceil(rankings.data.allRows.length / Math.max(1, Number(rankings.data.rowsPerPage) || 8)))
              : 0),
        },
      };

      if (!Number(state.selections['starting-order'].group) && Number(startOrder?.data?.groupNumber)) {
        state.selections['starting-order'].group = Number(startOrder.data.groupNumber);
      }
      if (!Number(state.selections.rankings.page) && Number(rankings?.data?.page)) {
        state.selections.rankings.page = Number(rankings.data.page);
      }

      const changed = JSON.stringify(nextMeta) !== JSON.stringify(previewMeta);
      previewMeta = nextMeta;
      if (changed) render();
    } catch (err) {
      console.warn('[preview] metadata refresh failed:', err.message);
    } finally {
      previewMetaRefreshInFlight = false;
    }
  }

  async function fetchJson(url) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
    return response.json();
  }

  function getView(id) {
    if (!state.views[id]) state.views[id] = { zoom: 1, x: 0, y: 0 };
    return state.views[id];
  }

  function updateIframeScales() {
    document.querySelectorAll('.tile').forEach(tile => applyView(tile, tile.dataset.id));
  }

  function applyView(tile, id) {
    const frame = tile.querySelector('.preview-frame');
    const iframe = tile.querySelector('iframe');
    if (!frame || !iframe) return;
    const view = getView(id);
    const fit = frame.clientWidth / BASE_WIDTH;
    iframe.style.setProperty('--preview-scale', String(fit * Number(view.zoom || 1)));
    iframe.style.setProperty('--preview-pan-x', `${Number(view.x || 0)}px`);
    iframe.style.setProperty('--preview-pan-y', `${Number(view.y || 0)}px`);
  }

  function reloadTile(tile) {
    const iframe = tile.querySelector('iframe');
    if (!iframe) return;
    // Two-step replay: ask the graphic to run its OUT animation, then drive
    // a real document reload (same path the browser's refresh button uses —
    // skips the about:blank round-trip that was making this feel sluggish).
    // Falls back to a src-reset if location.reload() isn't reachable.
    try {
      iframe.contentWindow?.postMessage({ type: 'preview-out' }, '*');
    } catch { /* not loaded yet — fall through */ }
    setTimeout(() => {
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        const src = iframe.getAttribute('src');
        iframe.setAttribute('src', src);
      }
    }, 220);
  }

  function reloadVisible() {
    document.querySelectorAll('.tile').forEach(reloadTile);
  }

  function makeIframeTransparent(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const style = doc.createElement('style');
      style.textContent = `
        html,
        body {
          background: transparent !important;
        }

        body::before {
          content: "";
          position: fixed;
          inset: 0;
          z-index: 0;
          pointer-events: none;
          background:
            linear-gradient(rgba(0,0,0,0.18), rgba(0,0,0,0.18)),
            conic-gradient(
              from 90deg,
              #07090d 0 25%,
              #11151d 0 50%,
              #07090d 0 75%,
              #11151d 0
            );
          background-color: #07090d;
          background-size: auto, 36px 36px;
        }

        .stage {
          position: relative !important;
          z-index: 1;
          background: transparent !important;
        }
      `;
      doc.head.appendChild(style);
    } catch {
      // Same-origin previews should allow this. If not, the iframe still works.
    }
  }

  function setAll(enabled) {
    GRAPHICS.forEach(item => { state.enabled[item.id] = enabled; });
    render();
  }

  function resetLayout() {
    state = defaultState();
    render();
  }

  function shieldTileControls(tile) {
    const controls = tile.querySelector('.tile-controls');
    const headerActions = tile.querySelector('.tile-header-actions');
    const interactive = tile.querySelectorAll('.tile-controls input, .tile-controls button, .tile-controls label, .tile-header-actions button');

    interactive.forEach(el => {
      el.draggable = false;
      el.addEventListener('dragstart', event => event.preventDefault());
    });

    if (controls) {
      controls.addEventListener('dragstart', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      controls.addEventListener('pointerdown', event => event.stopPropagation());
    }

    if (headerActions) {
      headerActions.addEventListener('dragstart', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      headerActions.addEventListener('pointerdown', event => event.stopPropagation());
    }
  }

  function wireDrag(handle, tile = handle) {
    handle.draggable = true;
    handle.addEventListener('dragstart', event => {
      draggedId = tile.dataset.id;
      tile.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedId);
    });

    handle.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      draggedId = null;
    });

    tile.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    tile.addEventListener('drop', event => {
      event.preventDefault();
      const targetId = tile.dataset.id;
      const sourceId = draggedId || event.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === targetId) return;
      reorder(sourceId, targetId);
    });
  }

  function reorder(sourceId, targetId) {
    const next = state.order.filter(id => id !== sourceId);
    const targetIndex = next.indexOf(targetId);
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, sourceId);
    state.order = next;
    render();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  tileSize.addEventListener('input', event => {
    state.tileSize = Number(event.target.value);
    document.documentElement.style.setProperty('--tile-min', `${state.tileSize}px`);
    tileSizeValue.textContent = `${state.tileSize}px`;
    requestAnimationFrame(updateIframeScales);
    saveState();
  });

  $('menu-toggle').addEventListener('click', () => {
    state.sidebarHidden = !state.sidebarHidden;
    render();
  });
  $('reload-visible').addEventListener('click', reloadVisible);
  $('all-on').addEventListener('click', () => setAll(true));
  $('all-off').addEventListener('click', () => setAll(false));
  $('reset-layout').addEventListener('click', resetLayout);
  window.addEventListener('resize', updateIframeScales);

  render();
})();
