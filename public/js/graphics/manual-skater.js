(function () {
  const root = document.getElementById('graphic-root');
  const line1El = document.getElementById('lt-line1');
  const line2El = document.getElementById('lt-line2');
  const textColEl = root.querySelector('.lt-text-col');
  const flagWrapEl = document.getElementById('lt-flag-wrap');
  const flagImgEl  = document.getElementById('lt-flag');
  const infoCardEl = document.getElementById('lt-info-card');
  const infoBodyEl = document.getElementById('lt-info-body');
  const infoLabelEl = document.getElementById('lt-info-label');
  const infoCategoryEl = document.getElementById('lt-info-category');
  const infoSegmentEl = document.getElementById('lt-info-segment');
  const infoGroupEl = document.getElementById('lt-info-group');

  let currentRevision = null;
  let currentVisible = false;
  let busy = false;
  let queuedPayload = null;
  let lastData = null;

  // Categories that are split arrive with the group on the end —
  // "Pre-Novice Women Group A", "Femmes Pré-novice Groupe A". Lift it onto its
  // own line. Anchored to the end because that's where the qualifier sits;
  // `groupe?` so the French form doesn't parse as group "e".
  //
  // Note this is NOT data.groupNumber — that's the warm-up group, a different
  // thing entirely, and showing both would put "Group A" and "Group 1" on the
  // same card meaning two different things.
  const GROUP_RE = /\s*[-–—·]?\s*\bgroupe?\s*([A-Za-z0-9]+)\s*$/i;

  function splitCategoryGroup(category, lang) {
    const text = String(category || '').trim();
    const match = text.match(GROUP_RE);
    if (!match) return { category: text, group: '' };
    return {
      category: text.replace(GROUP_RE, '').trim(),
      group: `${lang === 'fr' ? 'Groupe' : 'Group'} ${match[1]}`,
    };
  }

  function setInfoLine(element, value) {
    if (!element) return false;
    const text = String(value || '').trim();
    element.replaceChildren();
    if (text) element.textContent = text;
    element.classList.toggle('is-visible', !!text);
    return !!text;
  }

  // ── Quote & Music card ─────────────────────────────────────────────
  // When the selection payload carries a quote and/or program music (from
  // the event workbooks), the card shows the quote for a configurable few
  // seconds, then crossfades to the music title and holds until the bar
  // hides. Without extras it falls back to the original category detail.
  let extrasTimer = null;

  function setCardContent(label, text, wrap) {
    if (infoLabelEl) {
      infoLabelEl.textContent = label || '';
      infoLabelEl.classList.toggle('is-visible', !!(label && text));
    }
    if (infoBodyEl) infoBodyEl.classList.remove('lt-info-inline');
    infoCategoryEl.classList.toggle('lt-info-wrap', !!wrap);
    const hasInfo = setInfoLine(infoCategoryEl, text);
    setInfoLine(infoSegmentEl, '');
    setInfoLine(infoGroupEl, '');
    infoCardEl.classList.toggle('has-info', hasInfo);
    infoCardEl.setAttribute('aria-hidden', hasInfo ? 'false' : 'true');
    return hasInfo;
  }

  /**
   * The category / segment / group card. Laid out on one line — there is
   * plenty of room under the bar — with CSS supplying the separators, so any
   * of the three can be absent without leaving a stray divider.
   */
  function setDetailCard(category, segment, group) {
    if (infoLabelEl) {
      infoLabelEl.textContent = '';
      infoLabelEl.classList.remove('is-visible');
    }
    if (infoBodyEl) infoBodyEl.classList.add('lt-info-inline');
    infoCategoryEl.classList.remove('lt-info-wrap');
    const a = setInfoLine(infoCategoryEl, category);
    const b = setInfoLine(infoSegmentEl, segment);
    const c = setInfoLine(infoGroupEl, group);
    const hasInfo = a || b || c;
    infoCardEl.classList.toggle('has-info', hasInfo);
    infoCardEl.setAttribute('aria-hidden', hasInfo ? 'false' : 'true');
    return hasInfo;
  }

  // True crossfade: clone the outgoing content as an absolutely-positioned
  // ghost that dissolves out while the new content dissolves in underneath,
  // and ease the card height between the two. Only opacity animates per
  // frame (GPU-composited); the height tween is a single small element for
  // ~400ms — no measurable frame-rate cost.
  let ghostTimer = null;

  function removeGhosts() {
    clearTimeout(ghostTimer);
    infoCardEl.querySelectorAll('.lt-info-ghost').forEach(g => g.remove());
    infoCardEl.classList.remove('lt-info-h-anim');
    infoCardEl.style.height = '';
    if (infoBodyEl) infoBodyEl.classList.remove('lt-info-incoming');
  }

  function swapCardContent(label, text, wrap) {
    if (!infoBodyEl || !infoCardEl.classList.contains('has-info')) {
      setCardContent(label, text, wrap);
      return;
    }
    removeGhosts();

    // Snapshot outgoing content (strip ids so the live refs stay unique)
    const ghost = infoBodyEl.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    ghost.classList.add('lt-info-ghost');

    const oldH = infoCardEl.getBoundingClientRect().height;

    // Swap in the new content, hidden, and measure the card's new natural height
    infoBodyEl.classList.add('lt-info-incoming');
    setCardContent(label, text, wrap);
    infoCardEl.appendChild(ghost);
    const newH = infoCardEl.getBoundingClientRect().height;

    // Pin old height, then ease to the new one
    infoCardEl.style.height = `${oldH}px`;
    void infoCardEl.offsetHeight; // commit the pinned height before transitioning
    infoCardEl.classList.add('lt-info-h-anim');
    infoCardEl.style.height = `${newH}px`;

    // Start both dissolves on the next frame
    requestAnimationFrame(() => {
      ghost.style.opacity = '0';
      infoBodyEl.classList.remove('lt-info-incoming');
    });

    ghostTimer = setTimeout(() => {
      ghost.remove();
      infoCardEl.classList.remove('lt-info-h-anim');
      infoCardEl.style.height = '';
    }, 460);
  }

  function renderInfoCard(data = {}) {
    if (!infoCardEl) return;
    clearTimeout(extrasTimer);
    removeGhosts();
    if (infoBodyEl) infoBodyEl.classList.remove('lt-info-fading');

    const lang = document.documentElement.lang || 'en';
    const ovr = window.configHeaderOverrides?.['manual-skater'] || {};
    // Independent operator toggles per card phase. Coaches/quote/music are
    // opt-IN — they need workbook data most events don't have, and when they
    // are on they replace the category card entirely. The category card is the
    // default because it works from the event data alone.
    // The legacy master msExtrasEnabled is still honored for old configs.
    const extrasEnabled = ovr.msExtrasEnabled !== false;
    const coaches = (extrasEnabled && ovr.msShowCoaches === true) ? String(data.coaches || '').trim() : '';
    const quote   = (extrasEnabled && ovr.msShowQuote   === true) ? String(data.quote || '').trim() : '';
    const music   = (extrasEnabled && ovr.msShowMusic   === true) ? String(data.musicTitle || '').trim() : '';

    if (coaches || quote || music) {
      const coachMs = Math.max(1000, Number(ovr.msCoachMs) || 4000);
      const quoteMs = Math.max(1000, Number(ovr.msQuoteMs) || 4000);
      const segName = (lang === 'fr' ? (data.segmentNameFr || data.segmentName) : data.segmentName) || (lang === 'fr' ? 'Programme' : 'Program');
      const musicLabel = lang === 'fr' ? `Musique — ${segName}` : `${segName} Music`;
      const quoteLabel = lang === 'fr' ? 'Citation' : "Skater's Quote";
      const coachCount = coaches.split(',').length;
      const coachLabel = lang === 'fr'
        ? (coachCount > 1 ? 'Entraîneurs' : 'Entraîneur')
        : (coachCount > 1 ? 'Coaches' : 'Coach');

      // Phase chain: coaches → quote → music. Each phase holds for its
      // configured time then crossfades to the next; the last phase present
      // holds until the bar hides or the skater changes.
      const phases = [];
      if (coaches) phases.push({ label: coachLabel, text: coaches, holdMs: coachMs });
      if (quote)   phases.push({ label: quoteLabel, text: quote,   holdMs: quoteMs });
      if (music)   phases.push({ label: musicLabel, text: music,   holdMs: 0 });

      setCardContent(phases[0].label, phases[0].text, true);
      let idx = 0;
      const advance = () => {
        if (idx >= phases.length - 1) return;
        extrasTimer = setTimeout(() => {
          idx++;
          swapCardContent(phases[idx].label, phases[idx].text, true);
          advance();
        }, phases[idx].holdMs);
      };
      advance();
      return;
    }

    // Fallback — category detail card, shown when no extras phases are
    // enabled/available. Its own operator toggle can hide it entirely.
    if (ovr.msShowCategory === false) {
      setCardContent('', '', false);
      return;
    }
    // Precedence chain:
    //   1. Per-template ltInfoText (most specific)
    //   2. Global Detail Override (operator-level)
    // Either replaces the whole card with a single line.
    const override = ovr.ltInfoText || '';
    const globalDetail = lang === 'fr'
      ? (window.globalDetailOverrideFr || window.globalDetailOverride || '')
      : (window.globalDetailOverride   || window.globalDetailOverrideFr || '');
    const forced = override.trim() || globalDetail.trim();
    if (forced) {
      setCardContent('', forced, false);
      return;
    }

    // 3. Otherwise the event's own category / segment / group.
    //
    // The API sends categoryName + segmentName; the workbook path sends
    // category. Read both, or the card stays empty on one of them — which is
    // what kept it from ever dropping down on an API-driven event.
    const rawCat = String(
      (lang === 'fr' ? (data.categoryNameFr || data.categoryName) : data.categoryName)
      || data.category
      || ''
    ).trim();
    // Strip redundant "Singles" for singles events. Pairs/Dance pass through.
    const cleanedCat = window.GraphicsUtils.cleanCategoryName(rawCat) || rawCat;
    const segment = String(
      (lang === 'fr' ? (data.segmentNameFr || data.segmentName) : data.segmentName) || ''
    ).trim();
    // The category and segment sit side by side here, so the same qualifier
    // echo that hit the header would read "Gold Short Women · Short Program".
    const split = splitCategoryGroup(
      window.GraphicsUtils.dropSegmentEcho(cleanedCat, segment), lang
    );

    setDetailCard(split.category, segment, split.group);
  }

  function render(data = {}) {
    lastData = data;
    const name = data.line1 || data.name || '';
    const club = data.line2 || data.club || '';
    window.GraphicsUtils.applyInitialsIfNeeded(line1El, name);
    line2El.textContent = club;
    line2El.style.display = club ? '' : 'none';

    // Flag box: show when flagUrl is present and the operator hasn't disabled it.
    if (flagWrapEl && flagImgEl) {
      const flagUrl = String(data.flagUrl || '').trim();
      const showFlag = window.configHeaderOverrides?.['manual-skater']?.ltShowFlag !== false;
      window.GraphicsUtils.setFlag(flagImgEl, flagWrapEl, showFlag ? flagUrl : '');
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
