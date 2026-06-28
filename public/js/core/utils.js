// Per-template natural header labels (English + French) used by the
// 'fixed' title source and as a fallback when the live feed's category
// collapses to a meaningless discipline marker after cleaning.
const TEMPLATE_LABELS = {
  'officials':      { en: 'Officials',         fr: 'Officiels' },
  'rankings':       { en: 'Final Standings',   fr: 'Classement final' },
  'standings':      { en: 'Current Standings', fr: 'Classement actuel' },
  'starting-order': { en: 'Starting Order',    fr: 'Ordre de départ' },
  'skater-profile': { en: 'Skater Profile',    fr: 'Profil du patineur' },
};

window.GraphicsUtils = {
  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  },

  safeText(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  },

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /**
   * Shrink a header title's font-size to keep it on a single line.
   *
   * The CSS-configured font size (from the operator's slider) is the upper
   * bound; this helper only ever shrinks, never grows. Designed for French
   * headers where the translated category/segment text can be 30–50% wider
   * than the English equivalent and would otherwise wrap to two lines or
   * get clipped by the panel's overflow.
   *
   * Requires the target element to have `white-space: nowrap` so the
   * overflow check (`scrollWidth > offsetWidth`) is meaningful — that CSS
   * is added alongside the call sites where needed.
   *
   * Uses binary search across the [min, configured] range so the right
   * size lands in ~6 layout queries regardless of how far it has to shrink.
   * Falls back to ellipsis (via CSS) when even the min size doesn't fit.
   */
  fitTitleOneLine(el, options = {}) {
    if (!el) return;
    const measureAndFit = () => {
      // Reset prior inline so we start from the CSS-defined base.
      el.style.fontSize  = '';
      el.style.whiteSpace = '';
      const ow = el.offsetWidth;
      // Guard against measuring during animation — if the container is
      // suspiciously narrow, bail out and let the deferred re-run catch it.
      if (!ow || ow < 160) return;
      // 2px tolerance — sub-pixel rounding on flex layout can otherwise
      // trip the overflow check when the text actually fits.
      if (el.scrollWidth <= ow + 2) return;
      const base = parseFloat(getComputedStyle(el).fontSize) || 36;
      // Conservative minimum (70% of configured size) — readable on air.
      const min  = options.minSize ?? Math.max(14, Math.floor(base * 0.7));
      let lo = min, hi = base;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        el.style.fontSize = `${mid}px`;
        if (el.scrollWidth <= el.offsetWidth + 2) lo = mid;
        else hi = mid - 1;
      }
      el.style.fontSize = `${lo}px`;
      // If we hit the floor and the text still overflows, let it wrap to
      // two lines instead of ellipsising — a wrapped FR title reads far
      // better on air than "NOVICE PATINAGE EN…". The CSS rule still has
      // white-space:nowrap as the default; this inline override only
      // applies when we genuinely can't fit on one line at min font size.
      if (lo === min && el.scrollWidth > el.offsetWidth + 2) {
        el.style.whiteSpace = 'normal';
      }
    };
    // First pass: as soon as layout has had two frames to settle.
    requestAnimationFrame(() => requestAnimationFrame(measureAndFit));
    // Second pass: after any in/out animation completes. Catches the case
    // where the first pass ran while the panel was still sliding in and
    // the flex parent hadn't reached its final width yet — which was
    // making the title shrink far more than it needed to.
    setTimeout(measureAndFit, 900);
  },

  /**
   * Strip the redundant "Singles" word from a category name, plus any
   * trailing numeric sub-category index (e.g. "Novice Women Singles 1"
   * → "Novice Women"). Pairs and Dance categories are left untouched —
   * "Senior Pairs" stays "Senior Pairs", "Senior Ice Dance" stays as-is.
   *
   * Used by the title resolver and the info-card builders so the on-air
   * display reads cleanly without operator intervention for singles events.
   */
  cleanCategoryName(category) {
    if (!category) return '';
    const original = String(category).trim();
    let c = original;
    // Drop trailing sub-category number ("Novice Women Singles 1").
    c = c.replace(/\s+\d+$/, '');
    // English: drop the standalone word "Singles" / "Single" — boundary-aware
    // so it doesn't mangle hypothetical words like "Singletrack".
    c = c.replace(/\s*\bsingles?\b\s*/i, ' ');
    // French: drop the "en simple" phrase (e.g. "Femmes Senior en simple"
    // → "Femmes Senior") and any standalone "Simple" / "Simples" used as a
    // discipline marker (e.g. "Patinage Simple Femmes Senior" → "Patinage
    // Femmes Senior"). Run the phrase strip first so "en" doesn't get left
    // dangling, then handle the standalone case.
    c = c.replace(/\s*\ben\s+simples?\b\s*/i, ' ');
    c = c.replace(/\s*\bsimples?\b\s*/i, ' ');
    c = c.replace(/\s+/g, ' ').trim();
    // Sanity check — if the strip collapsed the category to a single word
    // (or empty), the original was likely a bare discipline marker like
    // "Patinage Simple" or "Singles" with no real category content. Return
    // empty so the auto-resolver falls through to the template's natural
    // title (e.g. "Officials") instead of rendering a meaningless fragment
    // OR the bare marker on air.
    if (!c || c.split(/\s+/).length < 2) return '';
    return c;
  },

  /**
   * Returns true when the original category includes the word "Singles".
   * Used by callers that want to append the segment name after stripping
   * (singles events read better as "Category + Segment").
   */
  isSinglesCategory(category) {
    const s = String(category || '');
    // English: "Singles" / "Single"
    if (/\bsingles?\b/i.test(s)) return true;
    // French: "en simple" / "en simples", or standalone "Simple" / "Simples"
    // as a discipline marker. Word-boundary regex so unrelated words don't
    // false-match.
    if (/\b(?:en\s+)?simples?\b/i.test(s)) return true;
    return false;
  },

  /**
   * Attach a one-time `error` handler to a flag <img> so that a missing or
   * broken flag asset (e.g. "QC.png" when only "BC.png" is on disk) hides
   * the wrapping element instead of displaying the browser's broken-image
   * icon. Re-armed on every call so the same image can recover later if the
   * src changes to a valid one.
   *
   * @param {HTMLImageElement} imgEl   — the flag <img>
   * @param {HTMLElement} wrapEl       — the container to hide on error
   *                                     (falls back to imgEl.parentElement)
   */
  wireFlagFallback(imgEl, wrapEl) {
    if (!imgEl) return;
    const wrap = wrapEl || imgEl.parentElement;
    // PESSIMISTIC: hide the wrap until the image actually loads. Eliminates
    // the visible "flash" on rows whose flag asset is missing — previously
    // the optimistic-show + onerror-hide cycle would briefly paint a broken
    // image icon, and the resulting mid-load layout shift threw off
    // applyInitialsIfNeeded's width measurement (root cause of the
    // "first-letter then …" name truncation).
    if (wrap) wrap.style.visibility = 'hidden';
    imgEl.onerror = () => {
      if (wrap) { wrap.style.display = 'none'; wrap.style.visibility = ''; }
      imgEl.removeAttribute('src');
    };
    imgEl.onload = () => {
      if (wrap) { wrap.style.display = ''; wrap.style.visibility = ''; }
    };
  },

  /**
   * Resolve the title for a graphic based on the operator's titleSource setting.
   *
   * titleSource values set in operator per template:
   *   'auto'      — use normalizer's data.title/titleEn/titleFr
   *   'category'  — use data.categoryName (fallback: data.title)
   *   'segment'   — use data.segmentName (fallback: data.title)
   *   'event'     — use event-config.eventName / eventNameFr
   *   'custom'    — use titleOverride / titleOverrideFr free-text
   *
   * @param {string} template  - template name (e.g. 'rankings')
   * @param {Object} data      - graphic payload.data
   * @param {string} fallback  - fallback title if nothing resolves
   * @returns {string}
   */
  resolveTitle(template, data, fallback = '') {
    const lang = document.documentElement.lang || 'en';
    const isFr = lang === 'fr';
    const ovr  = (window.configHeaderOverrides || {})[template] || {};
    const src  = ovr.titleSource || 'auto';

    // Pick English or French from a (en, fr) pair with graceful fallback
    const pick = (en, fr) => (isFr && fr) ? fr : (en || fr || '');

    // Global header title override — wins on the listed templates regardless
    // of titleSource. Lets the operator override the auto-pulled category
    // mid-event from a single field. Per-template `custom` titles still win
    // when set, since they're a more specific intent than the global.
    const GLOBAL_TARGETS = new Set(['starting-order', 'rankings', 'standings', 'officials']);
    if (GLOBAL_TARGETS.has(template) && src !== 'custom') {
      const g = pick(window.globalHeaderOverride || '', window.globalHeaderOverrideFr || '');
      if (g) return g;
    }

    let out = '';
    switch (src) {
      case 'custom':
        out = pick(ovr.title, ovr.titleFr);
        break;
      case 'event':
        out = pick(ovr.eventName, ovr.eventNameFr);
        break;
      case 'category': {
        // Operator explicitly picked Category. Always return the
        // language-appropriate category from the feed — cleaned where
        // possible, raw if cleaning collapses. No cross-language fallback:
        // showing English text in a FR render is worse than showing the
        // raw FR string the feed gave us. If the feed is sparse, operator
        // can pick "Default label" or "Custom" instead.
        const raw = pick(data?.categoryName, data?.categoryNameFr)
                 || pick(ovr.categoryName,  ovr.categoryNameFr);
        out = this.cleanCategoryName(raw) || raw;
        break;
      }
      case 'segment':
        out = pick(data?.segmentName, data?.segmentNameFr)
           || pick(ovr.segmentName,  ovr.segmentNameFr);
        break;
      case 'fixed': {
        // Use the template's natural broadcast label, language-aware:
        //   officials  → "Officials" / "Officiels"
        //   rankings   → "Final Rankings" / "Classement final"
        //   standings  → "Rankings" / "Classement"
        //   start-order → "Starting Order" / "Ordre de départ"
        const tl = TEMPLATE_LABELS[template] || {};
        out = pick(tl.en, tl.fr) || fallback;
        break;
      }
      case 'auto':
      default: {
        // Smart default: combine the normalised category with the segment,
        // mirroring what the lower-third detail line does. Works for every
        // discipline — singles, pairs, dance — with the "Singles" word
        // stripped automatically when present. Operator can opt out per-card
        // by picking 'category' or 'segment' (or 'custom' / 'event') from
        // the Title Source dropdown.
        const autoCat = pick(data?.categoryName, data?.categoryNameFr)
                     || pick(ovr.categoryName,  ovr.categoryNameFr);
        const autoSeg = pick(data?.segmentName, data?.segmentNameFr)
                     || pick(ovr.segmentName,  ovr.segmentNameFr);
        const cleanCat = this.cleanCategoryName(autoCat);
        if (cleanCat && autoSeg) {
          // De-dupe in case the feed already baked the segment into the
          // category (e.g. "Senior Pairs Free Program" + segment "Free Program").
          const cl = cleanCat.toLowerCase();
          const sl = autoSeg.toLowerCase();
          out = cl.includes(sl) ? cleanCat : `${cleanCat} ${autoSeg}`.trim();
        } else if (cleanCat) {
          out = cleanCat;
        } else if (autoSeg) {
          out = autoSeg;
        } else {
          // Last-resort fallback to whatever the normaliser stamped on
          // data.titleEn / data.title (e.g. "Officials" or legacy data).
          out = pick(data?.titleEn || data?.title, data?.titleFr);
        }
        break;
      }
    }

    return out || fallback;
  },

  /**
   * Resolve subtitle the same way as title.
   *
   * subtitleSource values:
   *   'auto'   — use data.subtitle (default)
   *   'event'  — use event-config.eventName / eventNameFr
   *   'custom' — use subtitleOverride / subtitleOverrideFr free-text
   *
   * Back-compat: if subtitleSource is missing but a custom subtitle override
   * is set, treat that as 'custom' (matches the previous behavior).
   */
  resolveSubtitle(template, data, fallback = '') {
    const lang = document.documentElement.lang || 'en';
    const isFr = lang === 'fr';
    const ovr  = (window.configHeaderOverrides || {})[template] || {};
    const pick = (en, fr) => (isFr && fr) ? fr : (en || fr || '');

    let src = ovr.subtitleSource || 'auto';
    if (src === 'auto' && (ovr.subtitle || ovr.subtitleFr)) src = 'custom';

    let out = '';
    switch (src) {
      case 'event':
        out = pick(ovr.eventName, ovr.eventNameFr);
        break;
      case 'category':
        out = pick(data?.categoryName, data?.categoryNameFr)
           || pick(ovr.categoryName,  ovr.categoryNameFr);
        break;
      case 'segment':
        out = pick(data?.segmentName, data?.segmentNameFr)
           || pick(ovr.segmentName,  ovr.segmentNameFr);
        break;
      case 'fixed': {
        // Template's natural broadcast label, language-aware. Same map the
        // title resolver uses, so subtitles can show e.g. "Final Standings"
        // beneath the live category title.
        const tl = TEMPLATE_LABELS[template] || {};
        out = pick(tl.en, tl.fr) || fallback;
        break;
      }
      case 'custom':
        out = pick(ovr.subtitle, ovr.subtitleFr);
        break;
      case 'auto':
      default:
        out = data?.subtitle || '';
    }
    return out || fallback;
  },

  /**
   * Set element text, then—on pairs/dance names containing " / "—shorten
   * first names to initials if the text overflows the element's width.
   * e.g. "Steve Muff / Sherry Parker" → "S. Muff / S. Parker"
   */
  applyInitialsIfNeeded(el, fullText) {
    el.textContent = fullText;
    if (!fullText.includes(' / ')) return; // only pairs/dance
    // Double rAF so we measure AFTER the parent grid has fully laid out —
    // single rAF was racing the initial layout pass and producing a stale
    // offsetWidth (often 0), which forced shortening on every render and,
    // combined with the flag asset still loading, caused the "first letter
    // then …" truncation reported by operators.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ow = el.offsetWidth || 0;
      // If layout still isn't ready, fall back to shortening — better to
      // produce "F. Last / F. Last" than gamble on uncertain measurements.
      const fits = ow > 0 && el.scrollWidth <= ow;
      if (fits) return;
      const shortened = fullText
        .split(' / ')
        .map(name => {
          const parts = name.trim().split(' ');
          if (parts.length < 2) return name.trim();
          return parts[0][0].toUpperCase() + '. ' + parts.slice(1).join(' ');
        })
        .join(' / ');
      el.textContent = shortened;
    }));
  },
};
