(function () {
  const root      = document.getElementById('sc-root');
  const skaterName = document.getElementById('skater-name');
  const skaterClub = document.getElementById('skater-club');
  const flagWrap  = document.getElementById('sc-flag-wrap');
  const flagImg   = document.getElementById('sc-flag');
  const rankNum   = document.getElementById('rank-num');
  const valTes    = document.getElementById('val-tes');
  const valPcs    = document.getElementById('val-pcs');
  const valBonus     = document.getElementById('val-bonus');
  const valDeduction = document.getElementById('val-deduction');
  const itemBonus     = document.getElementById('item-bonus');
  const itemDeduction = document.getElementById('item-deduction');
  const scoreGrid     = document.getElementById('score-grid');
  const valTotal  = document.getElementById('val-total');
  const labelTes  = document.getElementById('label-tes');
  // Total cell wrapper (the .sc-score-item--total div) — used for the reveal pulse
  const totalCell = valTotal ? valTotal.closest('.sc-score-item') : null;
  const rankBadge = document.getElementById('rank-badge');

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let countUpTimers   = [];
  // Deferred cumulative-reveal state — see scheduleCumulativeReveal()
  let revealTimer       = null;
  // Track *which skater* we've already revealed for. Keyed by name+club so a
  // burst of same-skater polls (which arrive faster than the 3s reveal delay)
  // doesn't keep resetting the timer and effectively suppress the reveal.
  let revealedForSkater = null;
  let pendingRevealKey  = null;

  function getRevealDelayMs() {
    const raw = getComputedStyle(root).getPropertyValue('--sc-reveal-delay-ms').trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 3000;
  }

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[scoring]', ...args);
  }

  // ── Segment type labels ──────────────────────────────────────────────────
  const TES_LABELS = { FS: 'TES', SP: 'TES', FD: 'TES', SD: 'TES', default: 'TES' };

  function fmt(n) { return (n ?? 0).toFixed(2); }

  // ── Animated count-up ─────────────────────────────────────────────────────
  function countUp(el, target, durationMs = 800, delayMs = 0) {
    const start = performance.now() + delayMs;
    const id = requestAnimationFrame(function tick(now) {
      if (now < start) { countUpTimers.push(requestAnimationFrame(tick)); return; }
      const elapsed = now - start;
      const t = Math.min(elapsed / durationMs, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(target * ease);
      if (t < 1) countUpTimers.push(requestAnimationFrame(tick));
    });
    countUpTimers.push(id);
  }

  function cancelCountUps() {
    countUpTimers.forEach(id => cancelAnimationFrame(id));
    countUpTimers = [];
  }

  // Tween a value between two arbitrary numbers (not just 0 → target).
  function countUpFromTo(el, from, to, durationMs = 800) {
    const start = performance.now();
    const id = requestAnimationFrame(function tick(now) {
      const t = Math.min((now - start) / durationMs, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * ease);
      if (t < 1) countUpTimers.push(requestAnimationFrame(tick));
    });
    countUpTimers.push(id);
  }

  // Cancel any pending cumulative reveal (called when a new payload comes in
  // for a different skater, or when the graphic is hidden).
  function cancelReveal() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  }

  /**
   * If the cumulative category score (catTotal) is meaningfully higher than
   * this segment's score (total), schedule a reveal that — after 3 seconds —
   * animates the TOTAL box from segScore → catScore and the rank badge from
   * SegRank → CatRank in sync. Pulses the total cell for a beat of polish.
   *
   * Skipped when:
   *   • catTotal is missing or ≤ total (first segment of a category, or the
   *     skater hasn't accumulated more from prior segments).
   *   • The reveal already fired for this payload revision.
   */
  function skaterKey(data) {
    return `${data?.name || ''}|${data?.club || ''}`;
  }

  function scheduleCumulativeReveal(data, entryDelayMs = 0) {
    const key = skaterKey(data);
    // Already revealed for this skater? Don't re-schedule — even if more
    // payloads arrive (they will, every ~2 s while the score panel is up).
    if (revealedForSkater === key) return;
    // Already armed for this skater? Leave the existing timer alone so a
    // run of fast polls doesn't keep pushing the reveal further into the
    // future (the bug the user hit).
    if (pendingRevealKey === key && revealTimer) return;
    cancelReveal();
    const segScore = Number(data?.total)    || 0;
    const catScore = Number(data?.catTotal) || 0;
    if (!(catScore > segScore + 0.001)) return; // first segment, or no gain
    const segRank  = data?.rank;
    const catRank  = data?.catRank;
    pendingRevealKey = key;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      pendingRevealKey = null;
      revealedForSkater = key;
      // Pulse the total cell for visual emphasis
      if (totalCell) {
        totalCell.classList.add('sc-reveal');
        setTimeout(() => totalCell.classList.remove('sc-reveal'), 900);
      }
      // Tween TOTAL from segScore → catScore
      if (valTotal) {
        valTotal.classList.add('sc-value-pop');
        setTimeout(() => valTotal.classList.remove('sc-value-pop'), 520);
      }
      countUpFromTo(valTotal, segScore, catScore, 800);
      // Swap rank with a quick grow-and-settle if the cumulative rank differs
      if (catRank != null && catRank !== segRank && rankNum) {
        if (rankBadge) {
          rankBadge.classList.add('sc-reveal');
          setTimeout(() => rankBadge.classList.remove('sc-reveal'), 900);
        }
        rankNum.textContent = catRank;
        rankNum.classList.add('sc-value-pop');
        setTimeout(() => rankNum.classList.remove('sc-value-pop'), 520);
      }
    }, entryDelayMs + getRevealDelayMs());
  }

  let lastData = null;

  // Total length of the staged entry animation (name bar slides up from the
  // bottom of the page, then the panel drops down from behind it). Count-up
  // + cumulative reveal are delayed by this much on the first render so the
  // numbers don't tick while still hidden behind the name bar.
  // Matches: name-bar transition 480ms + panel delay 480ms + panel transition 520ms = ~1000ms.
  const ENTRY_ANIMATION_MS = 1000;

  // ── Render ────────────────────────────────────────────────────────────────
  function render(data, animate, revision, entryDelayMs = 0) {
    lastData = data;
    const segType = (data.segmentType || 'SP').toUpperCase();
    labelTes.textContent  = TES_LABELS[segType] || TES_LABELS.default;
    window.GraphicsUtils.applyInitialsIfNeeded(skaterName, data.name || '');
    skaterClub.textContent = data.club  || '';
    if (flagWrap && flagImg) {
      const showFlag = !!data.flagUrl;
      flagWrap.style.display = showFlag ? '' : 'none';
      if (showFlag) {
        window.GraphicsUtils.wireFlagFallback(flagImg, flagWrap);
        flagImg.src = data.flagUrl;
      }
    }
    rankNum.textContent    = data.rank  != null ? data.rank : '—';
    // Reset any reveal-state classes on re-render (new skater or reload)
    if (totalCell) totalCell.classList.remove('sc-reveal');
    if (rankBadge) rankBadge.classList.remove('sc-reveal');
    if (valTotal)  valTotal.classList.remove('sc-value-pop');
    if (rankNum)   rankNum.classList.remove('sc-value-pop');

    // Bonus + Deductions are JSON-only (Skate Canada live mode). Each cell
    // shows independently when its own value is non-zero — a skater with a
    // deduction but no bonus only shows DEDUCT. CSV mode (which produces 0/0
    // for both) keeps the original 3-column TES · PCS · TOTAL layout.
    const bonus       = Number(data.bonuses    ?? data.bonus      ?? 0) || 0;
    const deduction   = Math.abs(Number(data.deductions ?? data.deduction ?? 0) || 0);
    const showBonus   = bonus > 0;
    const showDeduct  = deduction > 0;
    if (itemBonus)     itemBonus.style.display     = showBonus  ? '' : 'none';
    if (itemDeduction) itemDeduction.style.display = showDeduct ? '' : 'none';
    if (scoreGrid) {
      // Grid layout class — drives grid-template-columns to match the
      // number of visible cells (3 / 4 / 5 columns).
      scoreGrid.classList.toggle('sc-has-bonus',       showBonus  && !showDeduct);
      scoreGrid.classList.toggle('sc-has-deduct',      showDeduct && !showBonus);
      scoreGrid.classList.toggle('sc-has-extras',      showBonus  &&  showDeduct);
    }

    cancelCountUps();
    cancelReveal();
    if (animate) {
      valTes.textContent   = '0.00';
      valPcs.textContent   = '0.00';
      valTotal.textContent = '0.00';
      if (showBonus  && valBonus)     valBonus.textContent     = '0.00';
      if (showDeduct && valDeduction) valDeduction.textContent = '0.00';
      // Stagger plus the entry-animation delay so count-up only starts
      // after the panel has finished sliding down from behind the name bar.
      countUp(valTes,   data.tes   ?? 0, 700, entryDelayMs + 120);
      countUp(valPcs,   data.pcs   ?? 0, 700, entryDelayMs + 200);
      if (showBonus && valBonus) {
        countUp(valBonus, bonus, 600, entryDelayMs + 260);
      }
      if (showDeduct && valDeduction) {
        // Deduction count-up renders with a leading "−" sign once it settles.
        countUp(valDeduction, deduction, 600, entryDelayMs + 300);
        setTimeout(() => {
          valDeduction.textContent = `−${fmt(deduction)}`;
        }, entryDelayMs + 950);
      }
      countUp(valTotal, data.total ?? 0, 900, entryDelayMs + 320);
    } else {
      valTes.textContent   = fmt(data.tes   ?? 0);
      valPcs.textContent   = fmt(data.pcs   ?? 0);
      if (showBonus  && valBonus)     valBonus.textContent     = fmt(bonus);
      if (showDeduct && valDeduction) valDeduction.textContent = `−${fmt(deduction)}`;
      valTotal.textContent = fmt(data.total ?? 0);
    }
    // Schedule the cumulative reveal (catTotal/catRank) — fires after the
    // operator-defined delay, only if catTotal > total, and only once per
    // skater. Add the entry-animation delay so the reveal lands relative
    // to when the count-up finishes, not when the panel first kicks off.
    scheduleCumulativeReveal(data, entryDelayMs);
  }

  // ── Animation helpers ─────────────────────────────────────────────────────
  function animateIn(payload) {
    // Full entry sequence: name-bar slides up, then panel slides down from
    // behind it. Count-up + reveal are deferred until the panel arrives.
    render(payload.data, true, payload?.meta?.revision, ENTRY_ANIMATION_MS);
    root.classList.remove('hidden', 'out');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('visible')));
    currentVisible = true;
  }

  function animateOut() {
    return new Promise(resolve => {
      cancelCountUps();
      cancelReveal();
      // Reset reveal-once memo so the next show plays the reveal again,
      // even if it's the same skater re-shown.
      revealedForSkater = null;
      pendingRevealKey  = null;
      root.classList.remove('visible');
      root.classList.add('out');
      setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('out');
        currentVisible = false;
        resolve();
      }, 320);
    });
  }

  async function animateUpdate(payload) {
    const next = payload.data || {};
    const sameSkater =
      lastData &&
      (next.name  || '') === (lastData.name  || '') &&
      (next.club  || '') === (lastData.club  || '');
    if (sameSkater) {
      // Same skater, fresh data — update values in place WITHOUT replaying
      // the count-up (which would restart from 0 each poll and reset the
      // 3s catTotal reveal timer). Reveal scheduling is idempotent per
      // skater so this is safe to call repeatedly.
      render(next, false, payload?.meta?.revision);
      return;
    }
    // Different skater → reset reveal state, run full out/in with count-up.
    revealedForSkater = null;
    pendingRevealKey  = null;
    await animateOut();
    await window.GraphicsUtils.delay(80);
    animateIn(payload);
  }

  // ── Payload handler ───────────────────────────────────────────────────────
  async function handlePayload(payload) {
    if (!payload?.meta) return;
    const revision = payload.meta.revision;
    const visible  = !!payload?.control?.visible;
    const state    = payload?.control?.state || 'auto';

    if (revision === currentRevision) return;

    if (busy) { queuedPayload = payload; return; }
    busy = true;
    log('payload', { revision, visible, state });

    try {
      if (!visible && currentVisible) {
        currentRevision = revision;
        await animateOut();
      } else if (visible && !currentVisible) {
        currentRevision = revision;
        animateIn(payload);
      } else if (visible && currentVisible) {
        currentRevision = revision;
        await animateUpdate(payload);
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

  // Polling fallback
  new window.JsonPoller({
    url: '/data/scoring.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[scoring] poll error:', e),
  }).start();

  // WebSocket instant updates
  if (window.WsListener) window.WsListener.subscribe('scoring', handlePayload);

  // Re-render when operator changes config (caps, header text, etc.).
  // No revision passed → reveal is NOT re-scheduled (operator config tweaks
  // shouldn't replay the segScore→catScore animation).
  window.addEventListener('graphics-config-updated', () => {
    if (lastData) render(lastData, false);
  });
})();
