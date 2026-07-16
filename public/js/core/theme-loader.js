/**
 * Loads /data/event-config.json and applies:
 *   1. Theme tokens as CSS custom properties on :root
 *   2. Per-template position/scale overrides (--pos-x, --pos-y, --pos-scale)
 *
 * Exposed as window.applyTheme so ws-listener can hot-reload on config-update.
 */
(function () {
  /** Infer which template this page is from its URL path */
  function detectTemplate() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const gi = parts.indexOf('graphics');
    return gi >= 0 ? (parts[gi + 1] || null) : null;
  }

  const template = detectTemplate();
  let lastConfigSignature = '';

  async function applyTheme() {
    let config;
    try {
      const res = await fetch('/data/event-config.json?_=' + Date.now());
      if (!res.ok) return;
      config = await res.json();
    } catch {
      return;
    }

    const configSignature = JSON.stringify({
      theme: config.theme || {},
      positions: template ? (config.positions || {})[template] || {} : {},
      language: config.language || 'en',
      elementsDisplayMode: config.elementsDisplayMode || 'code',
      elementsTotalLabel: config.elementsTotalLabel || '',
      elementsTotalLabelFr: config.elementsTotalLabelFr || '',
      elementsHighestLabel: config.elementsHighestLabel || '',
      elementsHighestLabelFr: config.elementsHighestLabelFr || '',
      elementsHideTotalLabel: !!config.elementsHideTotalLabel,
      elementsHideLightRail: !!config.elementsHideLightRail,
      elementsHideHighest:   !!config.elementsHideHighest,
      elementsHighestShowName: !!config.elementsHighestShowName,
      elementsLayoutMode: config.elementsLayoutMode || 'list',
      globalHeaderOverride:   config.globalHeaderOverride   || '',
      globalHeaderOverrideFr: config.globalHeaderOverrideFr || '',
      globalDetailOverride:   config.globalDetailOverride   || '',
      globalDetailOverrideFr: config.globalDetailOverrideFr || '',
      showHeaderRings: config.showHeaderRings,
      logoFile: config.logoFile || '',
      nameFormat: config.nameFormat || 'default',
    });
    if (configSignature === lastConfigSignature && !applyTheme.force) return;
    lastConfigSignature = configSignature;

    const root = document.documentElement;

    // ── 1. Colour / typography tokens ─────────────────────────────────────
    const t = config.theme || {};
    const colorMap = {
      '--color-accent':         t.accentColor,
      '--color-accent-light':   t.accentColorLight,
      '--color-accent-dark':    t.accentColorDark,
      '--color-header-start':   t.headerGradientStart,
      '--color-header-end':     t.headerGradientEnd,
      '--color-panel-bg':       t.panelBg,
      '--color-row-bg':         t.rowBg,
      '--color-row-alt':        t.rowAlt,
      '--color-row-border':     t.rowBorder,
      '--color-text-primary':   t.textPrimary,
      '--color-text-secondary': t.textSecondary,
      '--color-text-muted':     t.textMuted,
      '--panel-radius':         t.panelRadius,
      '--panel-shadow':         t.panelShadow,
      '--color-numbers':        t.numberColor || t.textPrimary,
    };
    for (const [prop, value] of Object.entries(colorMap)) {
      if (value != null) root.style.setProperty(prop, value);
    }

    // ── Header decorative rings ────────────────────────────────────────────
    const showRings = config.showHeaderRings !== false; // default true for back-compat
    root.style.setProperty('--header-rings-opacity', showRings ? '1' : '0');

    // ── 2. Position, scale & style overrides for this template ───────────
    if (template) {
      const pos    = (config.positions || {})[template] || {};
      const x      = pos.x      ?? 0;
      const y      = pos.y      ?? 0;
      const scale  = pos.scale  ?? 1;
      const rowPad = pos.rowPad ?? 0;
      root.style.setProperty('--pos-x',           `${x}px`);
      root.style.setProperty('--pos-y',           `${y}px`);
      root.style.setProperty('--pos-scale',       String(scale));
      root.style.setProperty('--graphic-row-pad', `${rowPad}px`);

      // Row min-height override — 0 means "auto" (use template defaults per layout)
      const rowHeight = Number(pos.rowHeight) || 0;
      if (rowHeight > 0) root.style.setProperty('--row-min-height', `${rowHeight}px`);
      else root.style.removeProperty('--row-min-height');

      // Width / height overrides on graphic root
      const graphicRoot = document.getElementById('graphic-root');
      if (graphicRoot) {
        graphicRoot.style.width  = pos.width  > 0 ? `${pos.width}px`  : '';
        graphicRoot.style.height = pos.height > 0 ? `${pos.height}px` : '';
      }

      // Content zoom — apply to #panel when it exists, otherwise fall back to #graphic-root
      // (lower-third, elements have no #panel; zoom on #graphic-root is safe because
      //  base.css uses individual `translate`/`scale` properties which compose independently)
      const panelEl  = document.getElementById('panel');
      const zoomEl   = panelEl || graphicRoot;
      if (zoomEl) {
        zoomEl.style.zoom = (pos.zoom != null && pos.zoom !== 100)
          ? String(pos.zoom / 100) : '';
        // For panel templates, also clip the panel height to match
        if (panelEl && panelEl !== graphicRoot) {
          panelEl.style.maxHeight = pos.height > 0 ? `${pos.height}px` : '';
        }
      }

      // Panel corner radius override
      const rounded = pos.rounded !== false;              // default true
      const radius  = pos.radius  != null ? pos.radius : 20; // default 20
      root.style.setProperty('--panel-radius', rounded ? `${radius}px` : '0px');

      // ── 3. Animation CSS variables ─────────────────────────────────────────
      const animPreset = pos.animPreset || 'default';
      const animSpeed  = pos.animSpeed  ?? null;
      const animEasing = pos.animEasing || 'smooth';

      const EASINGS = {
        smooth:    'cubic-bezier(0.22, 1, 0.36, 1)',
        snappy:    'cubic-bezier(0.4, 0, 0.2, 1)',
        cinematic: 'cubic-bezier(0.16, 1, 0.3, 1)',
        spring:    'cubic-bezier(0.34, 1.56, 0.64, 1)',
        linear:    'linear',
      };

      // Bar templates need full off-screen travel; panel templates use subtle offset
      const BAR_TEMPLATES = ['lower-third', 'manual-skater', 'interview'];
      const isBar = BAR_TEMPLATES.includes(template);

      const PRESET_TRANSFORMS = {
        rise:    { bar: 'translateY(110%)',    panel: 'translateY(30px)' },
        slide:   { bar: 'translateX(-110%)',   panel: 'translateX(-50px)' },
        fade:    { bar: 'translateY(0px)',     panel: 'translateY(0px)' },
        pop:     { bar: 'scale(0.90)',         panel: 'scale(0.94) translateY(8px)' },
        cut:     { bar: null, panel: null },
      };

      if (animPreset && animPreset !== 'default') {
        const presetDef = PRESET_TRANSFORMS[animPreset];
        if (presetDef) {
          const tf = presetDef[isBar ? 'bar' : 'panel'];
          if (tf) root.style.setProperty('--anim-extra-transform', tf);
        }
        if (animPreset === 'cut') {
          root.style.setProperty('--anim-duration', '1ms');
          root.style.setProperty('--anim-out-duration', '1ms');
        }
      } else {
        root.style.removeProperty('--anim-extra-transform');
      }

      if (animSpeed != null && animPreset !== 'cut') {
        root.style.setProperty('--anim-duration', `${animSpeed}ms`);
        root.style.setProperty('--anim-out-duration', `${Math.round(animSpeed * 0.72)}ms`);
      }

      const easingFn = EASINGS[animEasing] || EASINGS.smooth;
      root.style.setProperty('--anim-easing', easingFn);
      root.style.setProperty('--anim-out-easing', 'ease-in');

      // Lower-third flag + background colors (template-specific CSS vars)
      if (template === 'lower-third' || template === 'manual-skater' || template === 'interview') {
        root.style.setProperty('--lt-flag-height', `${pos.ltFlagHeight ?? 68}px`);
        root.style.setProperty('--lt-flag-pad',    `${pos.ltFlagPad    ?? 24}px`);
        root.style.setProperty('--lt-flag-x',      `${pos.ltFlagX      ?? 0}px`);
        root.style.setProperty('--lt-flag-y',      `${pos.ltFlagY      ?? 0}px`);
        // Flag width — 0 (or unset) = preserve aspect ratio
        const fw = Number(pos.ltFlagWidth) || 0;
        if (fw > 0) root.style.setProperty('--lt-flag-width', `${fw}px`);
        else root.style.removeProperty('--lt-flag-width');
        root.style.setProperty('--lt-flag-opacity',  `${(pos.ltFlagOpacity ?? 100) / 100}`);
        // Single bar background — empty string means "use CSS red gradient fallback"
        if (pos.ltBarBg) root.style.setProperty('--lt-bar-bg', pos.ltBarBg);
        else root.style.removeProperty('--lt-bar-bg');
        root.style.setProperty('--lt-line1-size',    `${pos.ltLine1Size  ?? 40}px`);
        root.style.setProperty('--lt-line2-size',    `${pos.ltLine2Size  ?? 20}px`);
        // Title (body) horizontal padding — controls how close the title sits
        // to the logo on the left and the flag on the right.
        root.style.setProperty('--lt-body-pad-l',    `${pos.ltBodyPadL   ?? 28}px`);
        root.style.setProperty('--lt-body-pad-r',    `${pos.ltBodyPadR   ?? 32}px`);
        root.style.setProperty('--lt-info-card-bg',        pos.ltInfoBg || 'rgba(6,7,11,0.94)');
        root.style.setProperty('--lt-info-card-color',     pos.ltInfoColor || '#ffffff');
        root.style.setProperty('--lt-info-card-font-size', `${pos.ltInfoSize ?? 18}px`);
        root.style.setProperty('--lt-info-card-right',     `${pos.ltInfoRight ?? 20}px`);
        root.style.setProperty('--lt-info-card-radius',    `${pos.ltInfoRadius ?? 18}px`);
        root.style.setProperty('--lt-info-card-max-width', `${pos.ltInfoMaxWidth ?? 760}px`);
      }

      // Scoring font sizes
      if (template === 'scoring') {
        root.style.setProperty('--sc-score-size',    `${pos.scScoreSize  ?? 28}px`);
        root.style.setProperty('--sc-total-size',    `${pos.scTotalSize  ?? 36}px`);
        root.style.setProperty('--sc-label-size',    `${pos.scLabelSize  ?? 11}px`);
        root.style.setProperty('--sc-name-size',     `${pos.scNameSize   ?? 32}px`);
        root.style.setProperty('--sc-club-size',     `${pos.scClubSize   ?? 14}px`);
        root.style.setProperty('--sc-name-club-gap', `${pos.scNameClubGap ?? 8}px`);
        root.style.setProperty('--sc-rank-num-size', `${pos.scRankNumSize ?? 42}px`);
        root.style.setProperty('--sc-reveal-delay-ms', `${pos.scRevealDelayMs ?? 3000}`);
        root.style.setProperty('--sc-flag-w',        `${pos.flagW ?? 52}px`);
        root.style.setProperty('--sc-flag-h',        `${pos.flagH ?? 34}px`);
        root.style.setProperty('--sc-flag-x',        `${pos.scFlagX ?? 0}px`);
        root.style.setProperty('--sc-flag-y',        `${pos.scFlagY ?? 0}px`);
        root.style.setProperty('--sc-panel-bg',      pos.scPanelBg || 'rgba(14,14,18,0.92)');
        root.style.setProperty('--sc-logo-bg',       pos.scLogoBg  || 'rgba(0,0,0,0.18)');
        root.style.setProperty('--sc-rank-bg',       pos.scRankBg  || 'rgba(0,0,0,0.28)');
      }

      if (template === 'starting-order') {
        const base = pos;
        // Operator-tunable layout lock so all groups render with the same
        // row height + font sizes regardless of row count.
        window.startOrderLayoutLock = base.layoutLock || 'compact';
        root.style.setProperty('--so-title-size',    `${base.soTitleSize    ?? 36}px`);
        root.style.setProperty('--so-subtitle-size', `${base.soSubtitleSize ?? 18}px`);
        root.style.setProperty('--so-pos-size-lg',   `${base.soPosSize      ?? 32}px`);
        root.style.setProperty('--so-pos-size-md',   `${Math.round((base.soPosSize ?? 32) * 0.875)}px`);
        root.style.setProperty('--so-pos-size-sm',   `${Math.round((base.soPosSize ?? 32) * 0.688)}px`);
        root.style.setProperty('--so-name-size-lg',  `${base.soNameSize     ?? 28}px`);
        root.style.setProperty('--so-name-size-md',  `${Math.round((base.soNameSize ?? 28) * 0.857)}px`);
        root.style.setProperty('--so-name-size-sm',  `${Math.round((base.soNameSize ?? 28) * 0.714)}px`);
        root.style.setProperty('--so-club-size-lg',  `${base.soClubSize     ?? 18}px`);
        root.style.setProperty('--so-club-size-md',  `${Math.round((base.soClubSize ?? 18) * 0.889)}px`);
        root.style.setProperty('--so-club-size-sm',  `${Math.round((base.soClubSize ?? 18) * 0.722)}px`);
        root.style.setProperty('--so-title-sub-gap', `${base.titleSubGap    ?? 4}px`);
        // Position number colour (e.g. "#C8102E", "rgb(...)", or empty for theme default)
        if (base.soPosColor) root.style.setProperty('--so-pos-color', base.soPosColor);
        else root.style.removeProperty('--so-pos-color');
      }

      if (template === 'rankings') {
        const base = pos;
        root.style.setProperty('--rk-title-size',    `${base.rkTitleSize    ?? 36}px`);
        root.style.setProperty('--rk-subtitle-size', `${base.rkSubtitleSize ?? 18}px`);
        root.style.setProperty('--rk-rank-size-lg',  `${base.rkRankSize     ?? 26}px`);
        root.style.setProperty('--rk-rank-size-md',  `${Math.round((base.rkRankSize ?? 26) * 0.846)}px`);
        root.style.setProperty('--rk-rank-size-sm',  `${Math.round((base.rkRankSize ?? 26) * 0.692)}px`);
        root.style.setProperty('--rk-name-size-lg',  `${base.rkNameSize     ?? 26}px`);
        root.style.setProperty('--rk-name-size-md',  `${Math.round((base.rkNameSize ?? 26) * 0.846)}px`);
        root.style.setProperty('--rk-name-size-sm',  `${Math.round((base.rkNameSize ?? 26) * 0.692)}px`);
        root.style.setProperty('--rk-club-size-lg',  `${base.rkClubSize     ?? 15}px`);
        root.style.setProperty('--rk-club-size-md',  `${Math.round((base.rkClubSize ?? 15) * 0.867)}px`);
        root.style.setProperty('--rk-club-size-sm',  `${Math.round((base.rkClubSize ?? 15) * 0.8)}px`);
        root.style.setProperty('--rk-total-size-lg', `${base.rkTotalSize    ?? 24}px`);
        root.style.setProperty('--rk-total-size-md', `${Math.round((base.rkTotalSize ?? 24) * 0.917)}px`);
        root.style.setProperty('--rk-total-size-sm', `${Math.round((base.rkTotalSize ?? 24) * 0.792)}px`);
        root.style.setProperty('--rk-title-sub-gap', `${base.titleSubGap    ?? 3}px`);
      }

      if (template === 'officials') {
        root.style.setProperty('--of-title-size',    `${pos.ofTitleSize    ?? 36}px`);
        root.style.setProperty('--of-subtitle-size', `${pos.ofSubtitleSize ?? 16}px`);
        root.style.setProperty('--of-role-size',     `${pos.ofRoleSize     ?? 14}px`);
        root.style.setProperty('--of-name-size',     `${pos.ofNameSize     ?? 20}px`);
        root.style.setProperty('--of-title-sub-gap', `${pos.titleSubGap    ?? 4}px`);
      }

      if (template === 'standings') {
        root.style.setProperty('--st-title-size',    `${pos.stTitleSize    ?? 32}px`);
        root.style.setProperty('--st-subtitle-size', `${pos.stSubtitleSize ?? 15}px`);
        root.style.setProperty('--st-rank-size',     `${pos.stRankSize     ?? 22}px`);
        root.style.setProperty('--st-name-size',     `${pos.stNameSize     ?? 19}px`);
        root.style.setProperty('--st-club-size',     `${pos.stClubSize     ?? 12}px`);
        root.style.setProperty('--st-score-size',    `${pos.stScoreSize    ?? 22}px`);
        root.style.setProperty('--st-title-sub-gap', `${pos.titleSubGap    ?? 4}px`);
      }

      if (template === 'time-of-day') {
        root.style.setProperty('--tod-value-size', `${pos.todValueSize ?? 72}px`);
        root.style.setProperty('--tod-label-size', `${pos.todLabelSize ?? 16}px`);
        if (pos.todPanelBg) {
          root.style.setProperty('--tod-panel-bg', pos.todPanelBg);
          root.style.setProperty('--tod-panel-tint-opacity', '0');
        } else {
          root.style.removeProperty('--tod-panel-bg');
          root.style.removeProperty('--tod-panel-tint-opacity');
        }
        if (pos.todValueColor) root.style.setProperty('--tod-value-color', pos.todValueColor);
        else                   root.style.removeProperty('--tod-value-color');
        if (pos.todLabelColor) root.style.setProperty('--tod-label-color', pos.todLabelColor);
        else                   root.style.removeProperty('--tod-label-color');
      }

      if (template === 'clock') {
        root.style.setProperty('--clock-value-size', `${pos.clockValueSize ?? 72}px`);
        root.style.setProperty('--clock-label-size', `${pos.clockLabelSize ?? 16}px`);
        // Custom background colour. When operator sets a non-default colour
        // we also dim the decorative red-tint overlay so the picked colour
        // reads true; empty value falls back to the theme panel bg.
        if (pos.clockPanelBg) {
          root.style.setProperty('--clock-panel-bg', pos.clockPanelBg);
          root.style.setProperty('--clock-panel-tint-opacity', '0');
        } else {
          root.style.removeProperty('--clock-panel-bg');
          root.style.removeProperty('--clock-panel-tint-opacity');
        }
        // Font colours (value + label) — empty falls back to theme defaults.
        if (pos.clockValueColor) root.style.setProperty('--clock-value-color', pos.clockValueColor);
        else                     root.style.removeProperty('--clock-value-color');
        if (pos.clockLabelColor) root.style.setProperty('--clock-label-color', pos.clockLabelColor);
        else                     root.style.removeProperty('--clock-label-color');
      }

      if (template === 'skater-profile') {
        root.style.setProperty('--sp-name-size', `${pos.spNameSize ?? 44}px`);
        root.style.setProperty('--sp-club-size', `${pos.spClubSize ?? 18}px`);
        root.style.setProperty('--sp-stat-size', `${pos.spStatSize ?? 32}px`);
      }

      // Header text overrides + title-source selector — exposed globally so
      // graphic JS can apply them at render time.
      //
      // titleSource values:
      //   'auto'      — use the normalizer's data.title/titleEn/titleFr (default)
      //   'category'  — use category name (data.categoryName or derived)
      //   'segment'   — use segment name (data.segmentName or derived)
      //   'event'     — use event-config.eventName / eventNameFr
      //   'custom'    — use titleOverride / titleOverrideFr free-text fields
      window.configHeaderOverrides = window.configHeaderOverrides || {};
      window.configHeaderOverrides[template] = {
        titleSource:    pos.titleSource       || 'auto',
        subtitleSource: pos.subtitleSource    || 'auto',
        title:          pos.titleOverride     || null,
        titleFr:        pos.titleOverrideFr   || null,
        subtitle:       pos.subtitleOverride  || null,
        subtitleFr:     pos.subtitleOverrideFr || null,
        eventName:      config.eventName      || '',
        eventNameFr:    config.eventNameFr    || '',
        // Category/Segment from eventInfo (refreshed by the server every poll).
        // resolveTitle/resolveSubtitle use these as a canonical source so the
        // dropdown's Category/Segment options work on EVERY graphic, including
        // ones whose own feed (officials.php, currentSkater.php on initial
        // load, etc.) doesn't carry these fields directly.
        categoryName:   config.categoryName   || '',
        categoryNameFr: config.categoryNameFr || '',
        segmentName:    config.segmentName    || '',
        segmentNameFr:  config.segmentNameFr  || '',
        ltInfoText:     pos.ltInfoText        || '',
        ltShowFlag:     pos.ltShowFlag !== false,
        ltLine2Source:  pos.ltLine2Source     || 'club',
        ltLine2Custom:  pos.ltLine2Custom     || '',
        msgLine1Size:   pos.msgLine1Size      ?? 40,
        msgLine2Size:   pos.msgLine2Size      ?? 20,
        msExtrasEnabled: pos.msExtrasEnabled !== false,
        msQuoteMs:      (Number(pos.msQuoteSecs) || 4) * 1000,
        msCoachMs:      (Number(pos.msCoachSecs) || 4) * 1000,
      };

    }

    // Apply header text overrides to known DOM title elements
    applyHeaderOverride();

    // ── Global name format (Title Case / ALL CAPS / First LAST) ─────────
    // Set BEFORE applyGraphicsCaps so the paint pass picks up the new value
    // when a per-graphic Skater Name dropdown is on 'default'. Re-applied
    // via the existing _capsRepaint hook below if a template is mounted.
    window.graphicsNameFormat = String(config.nameFormat || 'default');

    // ── Per-element ALL-CAPS / Regular / First-LAST overrides ────────────
    if (template && typeof window.applyGraphicsCaps === 'function') {
      const pos = (config.positions || {})[template] || {};
      window.applyGraphicsCaps(template, pos.caps || {});
    } else if (typeof window._capsRepaint === 'function') {
      // No template arg but caps observer already attached — refresh in place.
      window._capsRepaint();
    }

    // ── 3. Language — update column headers that have data-en / data-fr ──
    const lang = config.language || 'en';
    document.documentElement.setAttribute('lang', lang);
    document.querySelectorAll('[data-en]').forEach(el => {
      el.textContent = lang === 'fr' ? (el.dataset.fr || el.dataset.en) : el.dataset.en;
    });

    // ── 4. Logo — inject into any .header-logo img found on this page ──
    const logoFile = config.logoFile || '';
    const logoUrl  = logoFile ? `/assets/logos/${encodeURIComponent(logoFile)}` : '';
    window.configLogoUrl = logoUrl;  // expose for graphics JS (e.g. lower-third fallback)

    // Per-template logo controls (show/hide, size, offset)
    const logoPos      = template ? ((config.positions || {})[template] || {}) : {};
    const logoShow     = logoPos.logoShow !== false;   // default: show
    const logoHeight   = logoPos.logoHeight ?? 56;
    const logoX        = logoPos.logoX ?? 0;
    const logoY        = logoPos.logoY ?? 0;

    const logoOpacity = logoPos.logoOpacity ?? 0.90;
    root.style.setProperty('--logo-height',  `${logoHeight}px`);
    root.style.setProperty('--logo-x',       `${logoX}px`);
    root.style.setProperty('--logo-y',       `${logoY}px`);
    root.style.setProperty('--logo-opacity', String(logoOpacity));

    document.querySelectorAll('.header-logo-wrap').forEach(wrap => {
      const show = logoShow && !!logoUrl;
      wrap.style.display = show ? '' : 'none';  // wrap starts as display:none in HTML
      const img = wrap.querySelector('.header-logo');
      if (img && logoUrl) img.src = logoUrl;
    });

    // Lower-third inline logo (uses lt-logo-wrap, not header-logo-wrap).
    // Honors the same `logoShow` flag the operator's "Show Logo" checkbox writes.
    const ltLogoWrap = document.getElementById('lt-logo-wrap');
    if (ltLogoWrap) {
      const ltLogoShow = logoShow && !!logoUrl;
      ltLogoWrap.style.display = ltLogoShow ? '' : 'none';
      const ltLogoImg = document.getElementById('lt-logo');
      if (ltLogoImg && logoUrl) ltLogoImg.src = logoUrl;
    }

    // ── 5. Header event-info line (event name · location · date) ─────────
    const displayName = (lang === 'fr' && config.eventNameFr) ? config.eventNameFr : config.eventName;
    const sub = config.headerSubtitle
      || [displayName, config.eventLocation, config.eventDate].filter(Boolean).join(' · ');
    document.querySelectorAll('.header-event-info').forEach(el => {
      el.textContent = sub;
    });
    // Headers carry two text lines: a "real" subtitle (.of-subtitle / .so-subtitle / etc.)
    // driven by the operator's Subtitle Source dropdown, AND the auto-generated
    // event-info line (.header-event-info). Operator wants only ONE visible
    // at a time — when the dropdown produces subtitle text, hide event-info;
    // when the subtitle is empty, show the event-info contextual fallback.
    wireSubtitleObserver();
    syncSubtitleVisibility();

    // ── 5b. Column widths (templates with multi-column rows) ─────────────
    if (template === 'starting-order') {
      root.style.setProperty('--so-col-pos',  `${logoPos.colPos  ?? 68}px`);
      root.style.setProperty('--so-col-flag', `${logoPos.colFlag ?? 46}px`);
      root.style.setProperty('--so-flag-w',   `${logoPos.flagW   ?? 42}px`);
      root.style.setProperty('--so-flag-h',   `${logoPos.flagH   ?? 27}px`);
    }
    if (template === 'rankings') {
      root.style.setProperty('--rk-col-rank',  `${logoPos.colRank  ?? 52}px`);
      root.style.setProperty('--rk-col-flag',  `${logoPos.colFlag  ?? 60}px`);
      root.style.setProperty('--rk-col-total', `${logoPos.colTotal ?? 82}px`);
      root.style.setProperty('--rk-flag-w',    `${logoPos.flagW    ?? 42}px`);
      root.style.setProperty('--rk-flag-h',    `${logoPos.flagH    ?? 27}px`);
    }
    if (template === 'standings') {
      root.style.setProperty('--st-col-rank',  `${logoPos.colRank  ?? 44}px`);
      root.style.setProperty('--st-col-flag',  `${logoPos.colFlag  ?? 54}px`);
      root.style.setProperty('--st-col-score', `${logoPos.colScore ?? 82}px`);
      root.style.setProperty('--st-flag-w',    `${logoPos.flagW    ?? 38}px`);
      root.style.setProperty('--st-flag-h',    `${logoPos.flagH    ?? 24}px`);
    }
    if (template === 'skater-profile') {
      root.style.setProperty('--sp-flag-h',    `${logoPos.flagH    ?? 36}px`);
      if (logoPos.flagW && logoPos.flagW > 0) {
        root.style.setProperty('--sp-flag-w',  `${logoPos.flagW}px`);
      } else {
        root.style.setProperty('--sp-flag-w',  'auto');
      }
    }
    if (template === 'officials') {
      root.style.setProperty('--of-col-role',   `${logoPos.colRole ?? 220}px`);
      root.style.setProperty('--of-role-align', logoPos.ofRoleAlign || 'right');
    }
    if (template === 'elements') {
      // NOTE: `pos` from the earlier if-block is out of scope here — use `logoPos`
      // (same object: (config.positions || {})[template] || {}).
      root.style.setProperty('--el-skater-size', `${logoPos.elSkaterSize ?? 18}px`);
      root.style.setProperty('--el-total-size',  `${logoPos.elTotalSize  ?? 26}px`);
      root.style.setProperty('--el-label-size',  `${logoPos.elLabelSize  ?? 9}px`);
      root.style.setProperty('--el-code-size',   `${logoPos.elCodeSize   ?? 15}px`);
      root.style.setProperty('--el-value-size',  `${logoPos.elValueSize  ?? 14}px`);
      root.style.setProperty('--el-title-x',     `${logoPos.elTitleX     ?? 0}px`);
      root.style.setProperty('--el-title-y',     `${logoPos.elTitleY     ?? 0}px`);
      // Two-phase entry: header drops in first; body (rows + light rail)
      // slides down from behind it after this delay. Operator-tunable.
      root.style.setProperty('--el-body-delay',  `${logoPos.elBodyDelay  ?? 2000}ms`);
      // Highest TES summary row — independent size + colour controls so
      // it can be made bigger/bolder/different-tinted than the per-element
      // rows, or muted to recede. 0/empty falls back to CSS defaults.
      if (logoPos.elHighestLabelSize > 0) {
        root.style.setProperty('--el-highest-label-size', `${logoPos.elHighestLabelSize}px`);
      } else root.style.removeProperty('--el-highest-label-size');
      if (logoPos.elHighestScoreSize > 0) {
        root.style.setProperty('--el-highest-score-size', `${logoPos.elHighestScoreSize}px`);
      } else root.style.removeProperty('--el-highest-score-size');
      if (logoPos.elHighestLabelColor) {
        root.style.setProperty('--el-highest-label-color', logoPos.elHighestLabelColor);
      } else root.style.removeProperty('--el-highest-label-color');
      if (logoPos.elHighestScoreColor) {
        root.style.setProperty('--el-highest-score-color', logoPos.elHighestScoreColor);
      } else root.style.removeProperty('--el-highest-score-color');
      // Expose auto-fit flag and the operator's manual width so the elements
      // graphic JS can decide whether to override panel width on each render.
      window.elementsAutoFit       = !!logoPos.elAutoFit;
      window.elementsManualWidth   = Number(logoPos.width) || 420;
    }

    // Global header title override — applies to Start Order, Rankings,
    // Rank 6 / Standings, and Officials. Empty string = no override.
    window.globalHeaderOverride   = String(config.globalHeaderOverride   || '').trim();
    window.globalHeaderOverrideFr = String(config.globalHeaderOverrideFr || '').trim();
    // Global override for the lower-third / manual-skater detail card text.
    // Per-template ltInfoText (set inside each card's Position & Size) still
    // wins when present — most-specific override beats this general one.
    window.globalDetailOverride   = String(config.globalDetailOverride   || '').trim();
    window.globalDetailOverrideFr = String(config.globalDetailOverrideFr || '').trim();

    // ── 6. Elements display mode ──────────────────────────────────────────
    window.elementsDisplayMode = config.elementsDisplayMode || 'code';
    // Elements layout mode: 'list' (default, full element list) or 'single'
    // (only the current element shown, replacing the previous one).
    window.elementsLayoutMode  = config.elementsLayoutMode  || 'list';

    // ── 7. Elements total label ("Technical Score" / "Score technique") ───
    const labelEn = config.elementsTotalLabel   || 'TES';
    const labelFr = config.elementsTotalLabelFr || 'NTÉ';
    const totalLabelEl = document.getElementById('el-total-label');
    if (totalLabelEl) {
      totalLabelEl.textContent = (lang === 'fr' ? labelFr : labelEn).toUpperCase();
    }
    // Highest-TES summary label (e.g. "Highest Technical Score" / "Meilleur Score Technique")
    // Exposed for the elements graphic to read at render time. Falls back to
    // sensible defaults when the operator hasn't customised them.
    window.elementsHighestLabel   = config.elementsHighestLabel   || 'Highest Technical Score';
    window.elementsHighestLabelFr = config.elementsHighestLabelFr || 'Meilleur Score Technique';
    // Operator option: hide the small "TES" / "NTÉ" label above the score
    window.elementsHideTotalLabel = !!config.elementsHideTotalLabel;
    // Operator option: hide the GOE light-rail row entirely
    window.elementsHideLightRail  = !!config.elementsHideLightRail;
    // Operator option: hide the Highest TES summary row entirely
    window.elementsHideHighest    = !!config.elementsHideHighest;
    // Operator option: show the leader's name under the Highest TES label
    window.elementsHighestShowName = !!config.elementsHighestShowName;

    // Notify any open graphics JS that config has changed (e.g. elements re-render)
    window.dispatchEvent(new CustomEvent('graphics-config-updated', { detail: { config } }));

    if (window.GraphicsConfig?.debug) {
      console.log('[theme-loader] applied for template:', template || '(unknown)', config.eventName, `lang=${lang}`);
    }
  }

  // Hide the .header-event-info line whenever there's a real subtitle visible
  // (so the operator's Subtitle Source dropdown shows ONE line, not two).
  // Uses a MutationObserver so changes from graphic JS render() calls also sync.
  const SUBTITLE_SELECTOR = '.of-subtitle, .so-subtitle, .rk-subtitle, .st-subtitle, .sp-subtitle';
  function syncSubtitleVisibility() {
    document.querySelectorAll('.header-event-info').forEach(el => {
      const sib = el.parentElement?.querySelector(SUBTITLE_SELECTOR);
      const subHasText = !!(sib && sib.textContent && sib.textContent.trim());
      el.style.display = subHasText ? 'none' : '';
    });
  }
  // One-time observer on each subtitle element so live render() changes
  // toggle the event-info line automatically.
  let _subObserverWired = false;
  function wireSubtitleObserver() {
    if (_subObserverWired) return;
    _subObserverWired = true;
    const subs = document.querySelectorAll(SUBTITLE_SELECTOR);
    if (!subs.length) return;
    const obs = new MutationObserver(() => {
      // Coalesce to one rAF tick to avoid thrash.
      if (obs._pending) return;
      obs._pending = true;
      requestAnimationFrame(() => { obs._pending = false; syncSubtitleVisibility(); });
    });
    subs.forEach(s => obs.observe(s, { childList: true, characterData: true, subtree: true }));
  }
  // Wire after first applyConfig so the subtitle elements exist.
  document.addEventListener('DOMContentLoaded', wireSubtitleObserver);

  function applyHeaderOverride() {
    if (!template) return;
    const lang = document.documentElement.lang || 'en';
    const ovr = (window.configHeaderOverrides || {})[template] || {};
    // Match both prefixed IDs (rk-title, so-title, etc.) AND the generic "title"/"subtitle"
    // IDs that some templates use (starting-order in particular).
    const titleEl    = document.getElementById('rk-title')  || document.getElementById('so-title')  ||
                       document.getElementById('of-title')  || document.getElementById('el-title')  ||
                       document.getElementById('st-title')  ||
                       document.getElementById('sp-title')  || document.getElementById('title');
    const subtitleEl = document.getElementById('rk-subtitle') || document.getElementById('so-subtitle') ||
                       document.getElementById('of-subtitle') || document.getElementById('st-subtitle') ||
                       document.getElementById('sp-subtitle') || document.getElementById('subtitle');
    const src = ovr.titleSource || 'auto';
    const pick = (en, fr) => (lang === 'fr' && fr) ? fr : (en || fr || '');

    // Only force-override the title here for 'custom' or 'event' sources.
    // For 'auto' / 'category' / 'segment', the graphic JS handles it via
    // GraphicsUtils.resolveTitle() using live data.
    if (titleEl) {
      if (src === 'custom' && (ovr.title || ovr.titleFr)) {
        titleEl.textContent = pick(ovr.title, ovr.titleFr);
      } else if (src === 'event' && (ovr.eventName || ovr.eventNameFr)) {
        titleEl.textContent = pick(ovr.eventName, ovr.eventNameFr);
      }
    }
    if (subtitleEl && (ovr.subtitle || ovr.subtitleFr)) {
      subtitleEl.textContent = pick(ovr.subtitle, ovr.subtitleFr);
    }
  }

  // Expose globally so ws-listener can call it on config-update
  window.applyTheme = applyTheme;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTheme);
  } else {
    applyTheme();
  }

  setInterval(applyTheme, 750);
})();
