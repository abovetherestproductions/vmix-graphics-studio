/**
 * Compositor theme loader — replaces theme-loader.js for the single-page
 * compositor (/compositor/). All 11 graphic roots live in one DOM, so CSS
 * position/animation vars must be scoped per-graphic-root element instead of
 * being written globally to :root (which would cause every graphic to share
 * the same position and animation preset).
 *
 * Global vars (colours, fonts, language) still go on :root — they apply to
 * all graphics identically and there are no conflicts.
 */
(function () {
  const COMPOSITOR_ROOTS = {
    'lower-third':    'lt-root',
    'elements':       'el-root',
    'messages':       'msg-root',
    'officials':      'of-root',
    'scoring':        'sc-root',
    'skater-profile': 'sp-root',
    'rankings':       'rk-root',
    'standings':      'st-root',
    'starting-order': 'so-root',
    'clock':          'clk-root',
    'time-of-day':    'tod-root',
  };

  const EASINGS = {
    smooth:    'cubic-bezier(0.22, 1, 0.36, 1)',
    snappy:    'cubic-bezier(0.4, 0, 0.2, 1)',
    cinematic: 'cubic-bezier(0.16, 1, 0.3, 1)',
    spring:    'cubic-bezier(0.34, 1.56, 0.64, 1)',
    linear:    'linear',
  };

  const PRESET_TRANSFORMS = {
    rise:  { bar: 'translateY(110%)',    panel: 'translateY(30px)' },
    slide: { bar: 'translateX(-110%)',   panel: 'translateX(-50px)' },
    fade:  { bar: 'translateY(0px)',     panel: 'translateY(0px)' },
    pop:   { bar: 'scale(0.90)',         panel: 'scale(0.94) translateY(8px)' },
    cut:   { bar: null,                  panel: null },
  };

  const BAR_TEMPLATES = new Set(['lower-third', 'manual-skater', 'interview']);

  let lastConfigSignature = '';

  async function applyTheme() {
    let config;
    try {
      const res = await fetch('/data/event-config.json?_=' + Date.now());
      if (!res.ok) return;
      config = await res.json();
    } catch { return; }

    const sig = JSON.stringify(config);
    if (sig === lastConfigSignature && !applyTheme.force) return;
    lastConfigSignature = sig;

    const docRoot = document.documentElement;

    // ── 1. Global colour / typography tokens → :root ──────────────────────
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
      if (value != null) docRoot.style.setProperty(prop, value);
    }
    const showRings = config.showHeaderRings !== false;
    docRoot.style.setProperty('--header-rings-opacity', showRings ? '1' : '0');

    // ── 2. Language ───────────────────────────────────────────────────────
    const lang = config.language || 'en';
    docRoot.setAttribute('lang', lang);
    document.querySelectorAll('[data-en]').forEach(el => {
      el.textContent = lang === 'fr' ? (el.dataset.fr || el.dataset.en) : el.dataset.en;
    });

    // ── 3. Logo URL (shared across all graphics) ─────────────────────────
    const logoFile = config.logoFile || '';
    const logoUrl  = logoFile ? `/assets/logos/${encodeURIComponent(logoFile)}` : '';
    window.configLogoUrl = logoUrl;

    // ── 4. Global name/header overrides ──────────────────────────────────
    window.graphicsNameFormat     = String(config.nameFormat || 'default');
    window.globalHeaderOverride   = String(config.globalHeaderOverride   || '').trim();
    window.globalHeaderOverrideFr = String(config.globalHeaderOverrideFr || '').trim();
    window.globalDetailOverride   = String(config.globalDetailOverride   || '').trim();
    window.globalDetailOverrideFr = String(config.globalDetailOverrideFr || '').trim();

    // ── 5. Elements global config ─────────────────────────────────────────
    window.elementsDisplayMode    = config.elementsDisplayMode    || 'code';
    window.elementsLayoutMode     = config.elementsLayoutMode     || 'list';
    window.elementsHighestLabel   = config.elementsHighestLabel   || 'Highest Technical Score';
    window.elementsHighestLabelFr = config.elementsHighestLabelFr || 'Meilleur Score Technique';
    window.elementsHideTotalLabel = !!config.elementsHideTotalLabel;
    window.elementsHideLightRail  = !!config.elementsHideLightRail;
    window.elementsHideHighest    = !!config.elementsHideHighest;
    window.elementsHighestShowName = !!config.elementsHighestShowName;

    const totalLabelEl = document.getElementById('el-total-label');
    if (totalLabelEl) {
      const labelEn = config.elementsTotalLabel   || 'TES';
      const labelFr = config.elementsTotalLabelFr || 'NTÉ';
      totalLabelEl.textContent = (lang === 'fr' ? labelFr : labelEn).toUpperCase();
    }

    // ── 6. Per-template position, animation, and style vars ──────────────
    // Written to each graphic's own root element so CSS vars resolve
    // independently per graphic rather than sharing one :root value.
    window.configHeaderOverrides = window.configHeaderOverrides || {};

    for (const [template, rootId] of Object.entries(COMPOSITOR_ROOTS)) {
      const graphicRoot = document.getElementById(rootId);
      if (!graphicRoot) continue;

      const pos = (config.positions || {})[template] || {};

      // Position + scale
      const x      = pos.x      ?? 0;
      const y      = pos.y      ?? 0;
      const scale  = pos.scale  ?? 1;
      const rowPad = pos.rowPad ?? 0;
      graphicRoot.style.setProperty('--pos-x',           `${x}px`);
      graphicRoot.style.setProperty('--pos-y',           `${y}px`);
      graphicRoot.style.setProperty('--pos-scale',       String(scale));
      graphicRoot.style.setProperty('--graphic-row-pad', `${rowPad}px`);

      const rowHeight = Number(pos.rowHeight) || 0;
      if (rowHeight > 0) graphicRoot.style.setProperty('--row-min-height', `${rowHeight}px`);
      else               graphicRoot.style.removeProperty('--row-min-height');

      // Width / height overrides
      graphicRoot.style.width  = pos.width  > 0 ? `${pos.width}px`  : '';
      graphicRoot.style.height = pos.height > 0 ? `${pos.height}px` : '';

      // Zoom — look for a panel element inside this graphic root
      const panelEl = graphicRoot.querySelector('.of-panel, .rk-panel, .so-panel, .st-panel');
      const zoomEl  = panelEl || graphicRoot;
      zoomEl.style.zoom = (pos.zoom != null && pos.zoom !== 100) ? String(pos.zoom / 100) : '';
      if (panelEl) panelEl.style.maxHeight = pos.height > 0 ? `${pos.height}px` : '';

      // Panel corner radius
      const rounded = pos.rounded !== false;
      const radius  = pos.radius != null ? pos.radius : 20;
      graphicRoot.style.setProperty('--panel-radius', rounded ? `${radius}px` : '0px');

      // Animation preset — scoped so each graphic can have its own preset
      const animPreset = pos.animPreset || 'default';
      const animSpeed  = pos.animSpeed  ?? null;
      const animEasing = pos.animEasing || 'smooth';
      const isBar      = BAR_TEMPLATES.has(template);

      if (animPreset && animPreset !== 'default') {
        const presetDef = PRESET_TRANSFORMS[animPreset];
        if (presetDef) {
          const tf = presetDef[isBar ? 'bar' : 'panel'];
          if (tf) graphicRoot.style.setProperty('--anim-extra-transform', tf);
          else    graphicRoot.style.removeProperty('--anim-extra-transform');
        }
        if (animPreset === 'cut') {
          graphicRoot.style.setProperty('--anim-duration',     '1ms');
          graphicRoot.style.setProperty('--anim-out-duration', '1ms');
        }
      } else {
        graphicRoot.style.removeProperty('--anim-extra-transform');
      }

      if (animSpeed != null && animPreset !== 'cut') {
        graphicRoot.style.setProperty('--anim-duration',     `${animSpeed}ms`);
        graphicRoot.style.setProperty('--anim-out-duration', `${Math.round(animSpeed * 0.72)}ms`);
      }

      const easingFn = EASINGS[animEasing] || EASINGS.smooth;
      graphicRoot.style.setProperty('--anim-easing',     easingFn);
      graphicRoot.style.setProperty('--anim-out-easing', 'ease-in');

      // Logo per graphic
      const logoShow    = pos.logoShow !== false;
      const logoHeight  = pos.logoHeight ?? 56;
      const logoX       = pos.logoX ?? 0;
      const logoY       = pos.logoY ?? 0;
      const logoOpacity = pos.logoOpacity ?? 0.90;
      graphicRoot.style.setProperty('--logo-height',  `${logoHeight}px`);
      graphicRoot.style.setProperty('--logo-x',       `${logoX}px`);
      graphicRoot.style.setProperty('--logo-y',       `${logoY}px`);
      graphicRoot.style.setProperty('--logo-opacity', String(logoOpacity));

      graphicRoot.querySelectorAll('.header-logo-wrap').forEach(wrap => {
        const show = logoShow && !!logoUrl;
        wrap.style.display = show ? '' : 'none';
        const img = wrap.querySelector('.header-logo');
        if (img && logoUrl) img.src = logoUrl;
      });

      // Lower-third inline logo (lt-logo-wrap — different from header-logo-wrap)
      if (template === 'lower-third') {
        const ltLogoWrap = graphicRoot.querySelector('.lt-logo-wrap');
        if (ltLogoWrap) {
          const show = logoShow && !!logoUrl;
          ltLogoWrap.style.display = show ? '' : 'none';
          const img = ltLogoWrap.querySelector('img');
          if (img && logoUrl) img.src = logoUrl;
        }
      }

      // Header event-info line
      const displayName = (lang === 'fr' && config.eventNameFr) ? config.eventNameFr : (config.eventName || '');
      const sub = config.headerSubtitle
        || [displayName, config.eventLocation, config.eventDate].filter(Boolean).join(' · ');
      graphicRoot.querySelectorAll('.header-event-info').forEach(el => {
        el.textContent = sub;
      });

      // configHeaderOverrides — read by graphic JS render() calls
      window.configHeaderOverrides[template] = {
        titleSource:    pos.titleSource       || 'auto',
        subtitleSource: pos.subtitleSource    || 'auto',
        title:          pos.titleOverride     || null,
        titleFr:        pos.titleOverrideFr   || null,
        subtitle:       pos.subtitleOverride  || null,
        subtitleFr:     pos.subtitleOverrideFr || null,
        eventName:      config.eventName      || '',
        eventNameFr:    config.eventNameFr    || '',
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

      // Apply title override for custom/event sources
      applyHeaderOverride(template, graphicRoot, lang);

      // ── Template-specific CSS vars ──────────────────────────────────────
      if (template === 'lower-third' || template === 'manual-skater' || template === 'interview') {
        graphicRoot.style.setProperty('--lt-flag-height', `${pos.ltFlagHeight ?? 68}px`);
        graphicRoot.style.setProperty('--lt-flag-pad',    `${pos.ltFlagPad    ?? 24}px`);
        graphicRoot.style.setProperty('--lt-flag-x',      `${pos.ltFlagX      ?? 0}px`);
        graphicRoot.style.setProperty('--lt-flag-y',      `${pos.ltFlagY      ?? 0}px`);
        const fw = Number(pos.ltFlagWidth) || 0;
        if (fw > 0) graphicRoot.style.setProperty('--lt-flag-width', `${fw}px`);
        else        graphicRoot.style.removeProperty('--lt-flag-width');
        graphicRoot.style.setProperty('--lt-flag-opacity',        `${(pos.ltFlagOpacity ?? 100) / 100}`);
        if (pos.ltBarBg) graphicRoot.style.setProperty('--lt-bar-bg', pos.ltBarBg);
        else             graphicRoot.style.removeProperty('--lt-bar-bg');
        graphicRoot.style.setProperty('--lt-line1-size',         `${pos.ltLine1Size  ?? 40}px`);
        graphicRoot.style.setProperty('--lt-line2-size',         `${pos.ltLine2Size  ?? 20}px`);
        graphicRoot.style.setProperty('--lt-body-pad-l',         `${pos.ltBodyPadL   ?? 28}px`);
        graphicRoot.style.setProperty('--lt-body-pad-r',         `${pos.ltBodyPadR   ?? 32}px`);
        graphicRoot.style.setProperty('--lt-info-card-bg',        pos.ltInfoBg || 'rgba(6,7,11,0.94)');
        graphicRoot.style.setProperty('--lt-info-card-color',     pos.ltInfoColor || '#ffffff');
        graphicRoot.style.setProperty('--lt-info-card-font-size', `${pos.ltInfoSize ?? 18}px`);
        graphicRoot.style.setProperty('--lt-info-card-right',     `${pos.ltInfoRight ?? 20}px`);
        graphicRoot.style.setProperty('--lt-info-card-radius',    `${pos.ltInfoRadius ?? 18}px`);
        graphicRoot.style.setProperty('--lt-info-card-max-width', `${pos.ltInfoMaxWidth ?? 760}px`);
      }

      if (template === 'scoring') {
        graphicRoot.style.setProperty('--sc-score-size',      `${pos.scScoreSize    ?? 28}px`);
        graphicRoot.style.setProperty('--sc-total-size',      `${pos.scTotalSize    ?? 36}px`);
        graphicRoot.style.setProperty('--sc-label-size',      `${pos.scLabelSize    ?? 11}px`);
        graphicRoot.style.setProperty('--sc-name-size',       `${pos.scNameSize     ?? 32}px`);
        graphicRoot.style.setProperty('--sc-club-size',       `${pos.scClubSize     ?? 14}px`);
        graphicRoot.style.setProperty('--sc-name-club-gap',   `${pos.scNameClubGap  ?? 8}px`);
        graphicRoot.style.setProperty('--sc-rank-num-size',   `${pos.scRankNumSize  ?? 42}px`);
        graphicRoot.style.setProperty('--sc-reveal-delay-ms', `${pos.scRevealDelayMs ?? 3000}`);
        graphicRoot.style.setProperty('--sc-flag-w',          `${pos.flagW ?? 52}px`);
        graphicRoot.style.setProperty('--sc-flag-h',          `${pos.flagH ?? 34}px`);
        graphicRoot.style.setProperty('--sc-flag-x',          `${pos.scFlagX ?? 0}px`);
        graphicRoot.style.setProperty('--sc-flag-y',          `${pos.scFlagY ?? 0}px`);
        graphicRoot.style.setProperty('--sc-panel-bg',         pos.scPanelBg || 'rgba(14,14,18,0.92)');
        graphicRoot.style.setProperty('--sc-logo-bg',          pos.scLogoBg  || 'rgba(0,0,0,0.18)');
        graphicRoot.style.setProperty('--sc-rank-bg',          pos.scRankBg  || 'rgba(0,0,0,0.28)');
      }

      if (template === 'starting-order') {
        window.startOrderLayoutLock = pos.layoutLock || 'compact';
        graphicRoot.style.setProperty('--so-title-size',    `${pos.soTitleSize    ?? 36}px`);
        graphicRoot.style.setProperty('--so-subtitle-size', `${pos.soSubtitleSize ?? 18}px`);
        graphicRoot.style.setProperty('--so-pos-size-lg',   `${pos.soPosSize      ?? 32}px`);
        graphicRoot.style.setProperty('--so-pos-size-md',   `${Math.round((pos.soPosSize ?? 32) * 0.875)}px`);
        graphicRoot.style.setProperty('--so-pos-size-sm',   `${Math.round((pos.soPosSize ?? 32) * 0.688)}px`);
        graphicRoot.style.setProperty('--so-name-size-lg',  `${pos.soNameSize     ?? 28}px`);
        graphicRoot.style.setProperty('--so-name-size-md',  `${Math.round((pos.soNameSize ?? 28) * 0.857)}px`);
        graphicRoot.style.setProperty('--so-name-size-sm',  `${Math.round((pos.soNameSize ?? 28) * 0.714)}px`);
        graphicRoot.style.setProperty('--so-club-size-lg',  `${pos.soClubSize     ?? 18}px`);
        graphicRoot.style.setProperty('--so-club-size-md',  `${Math.round((pos.soClubSize ?? 18) * 0.889)}px`);
        graphicRoot.style.setProperty('--so-club-size-sm',  `${Math.round((pos.soClubSize ?? 18) * 0.722)}px`);
        graphicRoot.style.setProperty('--so-title-sub-gap', `${pos.titleSubGap    ?? 4}px`);
        graphicRoot.style.setProperty('--so-col-pos',       `${pos.colPos  ?? 68}px`);
        graphicRoot.style.setProperty('--so-col-flag',      `${pos.colFlag ?? 46}px`);
        graphicRoot.style.setProperty('--so-flag-w',        `${pos.flagW   ?? 42}px`);
        graphicRoot.style.setProperty('--so-flag-h',        `${pos.flagH   ?? 27}px`);
        if (pos.soPosColor) graphicRoot.style.setProperty('--so-pos-color', pos.soPosColor);
        else                graphicRoot.style.removeProperty('--so-pos-color');
      }

      if (template === 'rankings') {
        graphicRoot.style.setProperty('--rk-title-size',    `${pos.rkTitleSize    ?? 36}px`);
        graphicRoot.style.setProperty('--rk-subtitle-size', `${pos.rkSubtitleSize ?? 18}px`);
        graphicRoot.style.setProperty('--rk-rank-size-lg',  `${pos.rkRankSize     ?? 26}px`);
        graphicRoot.style.setProperty('--rk-rank-size-md',  `${Math.round((pos.rkRankSize ?? 26) * 0.846)}px`);
        graphicRoot.style.setProperty('--rk-rank-size-sm',  `${Math.round((pos.rkRankSize ?? 26) * 0.692)}px`);
        graphicRoot.style.setProperty('--rk-name-size-lg',  `${pos.rkNameSize     ?? 26}px`);
        graphicRoot.style.setProperty('--rk-name-size-md',  `${Math.round((pos.rkNameSize ?? 26) * 0.846)}px`);
        graphicRoot.style.setProperty('--rk-name-size-sm',  `${Math.round((pos.rkNameSize ?? 26) * 0.692)}px`);
        graphicRoot.style.setProperty('--rk-club-size-lg',  `${pos.rkClubSize     ?? 15}px`);
        graphicRoot.style.setProperty('--rk-club-size-md',  `${Math.round((pos.rkClubSize ?? 15) * 0.867)}px`);
        graphicRoot.style.setProperty('--rk-club-size-sm',  `${Math.round((pos.rkClubSize ?? 15) * 0.8)}px`);
        graphicRoot.style.setProperty('--rk-total-size-lg', `${pos.rkTotalSize    ?? 24}px`);
        graphicRoot.style.setProperty('--rk-total-size-md', `${Math.round((pos.rkTotalSize ?? 24) * 0.917)}px`);
        graphicRoot.style.setProperty('--rk-total-size-sm', `${Math.round((pos.rkTotalSize ?? 24) * 0.792)}px`);
        graphicRoot.style.setProperty('--rk-title-sub-gap', `${pos.titleSubGap    ?? 3}px`);
        graphicRoot.style.setProperty('--rk-col-rank',      `${pos.colRank  ?? 52}px`);
        graphicRoot.style.setProperty('--rk-col-flag',      `${pos.colFlag  ?? 60}px`);
        graphicRoot.style.setProperty('--rk-col-total',     `${pos.colTotal ?? 82}px`);
        graphicRoot.style.setProperty('--rk-flag-w',        `${pos.flagW    ?? 42}px`);
        graphicRoot.style.setProperty('--rk-flag-h',        `${pos.flagH    ?? 27}px`);
      }

      if (template === 'officials') {
        graphicRoot.style.setProperty('--of-title-size',    `${pos.ofTitleSize    ?? 36}px`);
        graphicRoot.style.setProperty('--of-subtitle-size', `${pos.ofSubtitleSize ?? 16}px`);
        graphicRoot.style.setProperty('--of-role-size',     `${pos.ofRoleSize     ?? 14}px`);
        graphicRoot.style.setProperty('--of-name-size',     `${pos.ofNameSize     ?? 20}px`);
        graphicRoot.style.setProperty('--of-title-sub-gap', `${pos.titleSubGap    ?? 4}px`);
        graphicRoot.style.setProperty('--of-col-role',      `${pos.colRole ?? 220}px`);
        graphicRoot.style.setProperty('--of-role-align',     pos.ofRoleAlign || 'right');
      }

      if (template === 'standings') {
        graphicRoot.style.setProperty('--st-title-size',    `${pos.stTitleSize    ?? 32}px`);
        graphicRoot.style.setProperty('--st-subtitle-size', `${pos.stSubtitleSize ?? 15}px`);
        graphicRoot.style.setProperty('--st-rank-size',     `${pos.stRankSize     ?? 22}px`);
        graphicRoot.style.setProperty('--st-name-size',     `${pos.stNameSize     ?? 19}px`);
        graphicRoot.style.setProperty('--st-club-size',     `${pos.stClubSize     ?? 12}px`);
        graphicRoot.style.setProperty('--st-score-size',    `${pos.stScoreSize    ?? 22}px`);
        graphicRoot.style.setProperty('--st-title-sub-gap', `${pos.titleSubGap    ?? 4}px`);
        graphicRoot.style.setProperty('--st-col-rank',      `${pos.colRank  ?? 44}px`);
        graphicRoot.style.setProperty('--st-col-flag',      `${pos.colFlag  ?? 54}px`);
        graphicRoot.style.setProperty('--st-col-score',     `${pos.colScore ?? 82}px`);
        graphicRoot.style.setProperty('--st-flag-w',        `${pos.flagW    ?? 38}px`);
        graphicRoot.style.setProperty('--st-flag-h',        `${pos.flagH    ?? 24}px`);
      }

      if (template === 'time-of-day') {
        graphicRoot.style.setProperty('--tod-value-size', `${pos.todValueSize ?? 72}px`);
        graphicRoot.style.setProperty('--tod-label-size', `${pos.todLabelSize ?? 16}px`);
        if (pos.todPanelBg) {
          graphicRoot.style.setProperty('--tod-panel-bg',            pos.todPanelBg);
          graphicRoot.style.setProperty('--tod-panel-tint-opacity',  '0');
        } else {
          graphicRoot.style.removeProperty('--tod-panel-bg');
          graphicRoot.style.removeProperty('--tod-panel-tint-opacity');
        }
        if (pos.todValueColor) graphicRoot.style.setProperty('--tod-value-color', pos.todValueColor);
        else                   graphicRoot.style.removeProperty('--tod-value-color');
        if (pos.todLabelColor) graphicRoot.style.setProperty('--tod-label-color', pos.todLabelColor);
        else                   graphicRoot.style.removeProperty('--tod-label-color');
      }

      if (template === 'clock') {
        graphicRoot.style.setProperty('--clock-value-size', `${pos.clockValueSize ?? 72}px`);
        graphicRoot.style.setProperty('--clock-label-size', `${pos.clockLabelSize ?? 16}px`);
        if (pos.clockPanelBg) {
          graphicRoot.style.setProperty('--clock-panel-bg',           pos.clockPanelBg);
          graphicRoot.style.setProperty('--clock-panel-tint-opacity', '0');
        } else {
          graphicRoot.style.removeProperty('--clock-panel-bg');
          graphicRoot.style.removeProperty('--clock-panel-tint-opacity');
        }
        if (pos.clockValueColor) graphicRoot.style.setProperty('--clock-value-color', pos.clockValueColor);
        else                     graphicRoot.style.removeProperty('--clock-value-color');
        if (pos.clockLabelColor) graphicRoot.style.setProperty('--clock-label-color', pos.clockLabelColor);
        else                     graphicRoot.style.removeProperty('--clock-label-color');
      }

      if (template === 'skater-profile') {
        graphicRoot.style.setProperty('--sp-name-size', `${pos.spNameSize ?? 44}px`);
        graphicRoot.style.setProperty('--sp-club-size', `${pos.spClubSize ?? 18}px`);
        graphicRoot.style.setProperty('--sp-stat-size', `${pos.spStatSize ?? 32}px`);
        graphicRoot.style.setProperty('--sp-flag-h',    `${pos.flagH ?? 36}px`);
        graphicRoot.style.setProperty('--sp-flag-w',    (pos.flagW > 0) ? `${pos.flagW}px` : 'auto');
      }

      if (template === 'elements') {
        graphicRoot.style.setProperty('--el-skater-size', `${pos.elSkaterSize ?? 18}px`);
        graphicRoot.style.setProperty('--el-total-size',  `${pos.elTotalSize  ?? 26}px`);
        graphicRoot.style.setProperty('--el-label-size',  `${pos.elLabelSize  ?? 9}px`);
        graphicRoot.style.setProperty('--el-code-size',   `${pos.elCodeSize   ?? 15}px`);
        graphicRoot.style.setProperty('--el-value-size',  `${pos.elValueSize  ?? 14}px`);
        graphicRoot.style.setProperty('--el-title-x',     `${pos.elTitleX     ?? 0}px`);
        graphicRoot.style.setProperty('--el-title-y',     `${pos.elTitleY     ?? 0}px`);
        graphicRoot.style.setProperty('--el-body-delay',  `${pos.elBodyDelay  ?? 2000}ms`);
        if (pos.elHighestLabelSize > 0) graphicRoot.style.setProperty('--el-highest-label-size', `${pos.elHighestLabelSize}px`);
        else                            graphicRoot.style.removeProperty('--el-highest-label-size');
        if (pos.elHighestScoreSize > 0) graphicRoot.style.setProperty('--el-highest-score-size', `${pos.elHighestScoreSize}px`);
        else                            graphicRoot.style.removeProperty('--el-highest-score-size');
        if (pos.elHighestLabelColor)    graphicRoot.style.setProperty('--el-highest-label-color', pos.elHighestLabelColor);
        else                            graphicRoot.style.removeProperty('--el-highest-label-color');
        if (pos.elHighestScoreColor)    graphicRoot.style.setProperty('--el-highest-score-color', pos.elHighestScoreColor);
        else                            graphicRoot.style.removeProperty('--el-highest-score-color');
        window.elementsAutoFit     = !!pos.elAutoFit;
        window.elementsManualWidth = Number(pos.width) || 420;
      }

      // Per-element caps overrides
      if (typeof window.applyGraphicsCaps === 'function') {
        window.applyGraphicsCaps(template, pos.caps || {});
      }
    }

    // Subtitle visibility sync (hides .header-event-info when subtitle has text)
    wireSubtitleObserver();
    syncSubtitleVisibility();

    window.dispatchEvent(new CustomEvent('graphics-config-updated', { detail: { config } }));

    if (window.GraphicsConfig?.debug) {
      console.log('[compositor-theme-loader] applied, lang=' + lang, config.eventName || '');
    }
  }

  function applyHeaderOverride(template, rootEl, lang) {
    const ovr = (window.configHeaderOverrides || {})[template] || {};
    const src = ovr.titleSource || 'auto';
    if (src !== 'custom' && src !== 'event') return;
    const pick = (en, fr) => (lang === 'fr' && fr) ? fr : (en || fr || '');
    const titleEl    = rootEl.querySelector('[id$="-title"]') || rootEl.querySelector('[id="so-title"]');
    const subtitleEl = rootEl.querySelector('[id$="-subtitle"]') || rootEl.querySelector('[id="so-subtitle"]');
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

  const SUBTITLE_SELECTOR = '.of-subtitle, .so-subtitle, .rk-subtitle, .st-subtitle, .sp-subtitle';
  function syncSubtitleVisibility() {
    document.querySelectorAll('.header-event-info').forEach(el => {
      const sib = el.parentElement?.querySelector(SUBTITLE_SELECTOR);
      el.style.display = (sib && sib.textContent && sib.textContent.trim()) ? 'none' : '';
    });
  }
  let _subObserverWired = false;
  function wireSubtitleObserver() {
    if (_subObserverWired) return;
    _subObserverWired = true;
    const subs = document.querySelectorAll(SUBTITLE_SELECTOR);
    if (!subs.length) return;
    const obs = new MutationObserver(() => {
      if (obs._pending) return;
      obs._pending = true;
      requestAnimationFrame(() => { obs._pending = false; syncSubtitleVisibility(); });
    });
    subs.forEach(s => obs.observe(s, { childList: true, characterData: true, subtree: true }));
  }

  window.applyTheme = applyTheme;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTheme);
  } else {
    applyTheme();
  }

  setInterval(applyTheme, 750);
})();
