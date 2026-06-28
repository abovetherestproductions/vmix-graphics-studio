/**
 * Per-template "Text Case" registry — drives the operator UI dropdowns and
 * is consumed by theme-loader to apply case overrides at runtime.
 *
 * Each entry: { key, label, selector, defaultUpper, isName? }
 *   - key:           short id stored in pos.caps[key]
 *   - label:         human label shown in the operator panel
 *   - selector:      CSS selector inside the graphic page
 *   - defaultUpper:  whether the source CSS uppercases by default
 *   - isName:        TRUE for person-name fields — these support the
 *                    "firstlast" mode (e.g. "Steve MUFF"), which is
 *                    implemented by rewriting textContent rather than
 *                    pure CSS text-transform. They also inherit from the
 *                    global `nameFormat` config when their per-graphic
 *                    mode is 'default'.
 *
 * Saved value (per template): pos.caps[key] = 'upper' | 'normal' | 'firstlast' | 'default'
 *   'default' (or missing) → for name fields, follow window.graphicsNameFormat;
 *                            for non-name fields, leave the CSS alone.
 *   'firstlast' is only valid on isName:true entries; on others it's a no-op.
 */
window.GraphicsCapsTargets = {
  'starting-order': [
    { key:'title',    label:'Header Title', selector:'.so-title',    defaultUpper:true  },
    { key:'subtitle', label:'Subtitle',     selector:'.so-subtitle', defaultUpper:false },
    { key:'name',     label:'Skater Name',  selector:'.so-name',     defaultUpper:false, isName:true },
    { key:'club',     label:'Club',         selector:'.so-club',     defaultUpper:false },
  ],
  'rankings': [
    { key:'title',    label:'Header Title', selector:'.rk-title',    defaultUpper:true  },
    { key:'subtitle', label:'Subtitle',     selector:'.rk-subtitle', defaultUpper:false },
    { key:'name',     label:'Skater Name',  selector:'.rk-name',     defaultUpper:false, isName:true },
    { key:'club',     label:'Club',         selector:'.rk-club',     defaultUpper:false },
  ],
  'standings': [
    { key:'title',    label:'Header Title', selector:'.st-title',    defaultUpper:true  },
    { key:'subtitle', label:'Subtitle',     selector:'.st-subtitle', defaultUpper:false },
    { key:'name',     label:'Skater Name',  selector:'.st-name',     defaultUpper:false, isName:true },
    { key:'club',     label:'Club',         selector:'.st-club',     defaultUpper:false },
  ],
  'officials': [
    { key:'title',    label:'Header Title', selector:'.of-title',    defaultUpper:true  },
    { key:'subtitle', label:'Subtitle',     selector:'.of-subtitle', defaultUpper:false },
    { key:'role',     label:'Role',         selector:'.of-role',     defaultUpper:false },
    { key:'name',     label:'Name',         selector:'.of-name',     defaultUpper:false, isName:true },
  ],
  'scoring': [
    { key:'name',     label:'Skater Name',  selector:'.sc-skater-name', defaultUpper:false, isName:true },
    { key:'club',     label:'Club',         selector:'.sc-skater-club', defaultUpper:false },
    { key:'rankLbl',  label:'Place Label',  selector:'.sc-rank-label',  defaultUpper:true  },
    { key:'scoreLbl', label:'Score Labels', selector:'.sc-score-label', defaultUpper:true  },
  ],
  'elements': [
    { key:'skater',   label:'Skater Name',  selector:'.el-skater',     defaultUpper:false, isName:true },
    { key:'totalLbl', label:'Total Label',  selector:'.el-total-label',defaultUpper:true  },
    { key:'name',     label:'Element Name', selector:'.el-name',       defaultUpper:false },
  ],
  'lower-third': [
    { key:'line1',    label:'Line 1',       selector:'.lt-line1',    defaultUpper:true,  isName:true },
    { key:'line2',    label:'Line 2',       selector:'.lt-line2',    defaultUpper:false },
  ],
  'manual-skater': [
    { key:'line1',    label:'Skater Name',  selector:'.lt-line1',    defaultUpper:true,  isName:true },
    { key:'line2',    label:'Club',         selector:'.lt-line2',    defaultUpper:false },
  ],
  'skater-profile': [
    { key:'name',     label:'Skater Name',  selector:'.sp-name',     defaultUpper:true,  isName:true },
    { key:'club',     label:'Club',         selector:'.sp-club',     defaultUpper:false },
    { key:'event',    label:'Event/Header', selector:'.sp-event',    defaultUpper:true  },
    { key:'section',  label:'Section',      selector:'.sp-section',  defaultUpper:false },
  ],
};

// ── Name formatter: "Steve MUFF" style ────────────────────────────────────
// Particles ("van", "de", "von", …) attach to the last-name chunk and are
// uppercased with it. Suffixes ("Jr.", "III", …) likewise. Hyphenated last
// names are treated as a single token. Pair / dance team names (separated
// by "/" or "&") are formatted per side.
const NAME_PARTICLES = new Set([
  'van','von','de','del','della','di','da','dos','do',
  'le','la','les','du','des','der','den','ten','ter','te','het',
  'af','av','of','y','e','lo','los'
]);
const NAME_SUFFIXES = new Set([
  'jr','jr.','sr','sr.','ii','iii','iv','v'
]);

window.formatNameFirstLast = function formatNameFirstLast(input) {
  if (!input) return input;
  const str = String(input).trim();
  if (!str) return str;
  // Pair / dance team: apply per side, preserving the exact separator + spacing.
  const pairMatch = str.match(/^(.+?)(\s*[\/&]\s*)(.+)$/);
  if (pairMatch) {
    return formatNameFirstLast(pairMatch[1]) + pairMatch[2] + formatNameFirstLast(pairMatch[3]);
  }
  const tokens = str.split(/\s+/);
  if (tokens.length < 2) return str; // mononym → leave as-is
  // Walk back over trailing suffixes (Jr., III, …) so the core last-name
  // token is the last non-suffix token.
  let endIdx = tokens.length - 1;
  while (endIdx > 0 && NAME_SUFFIXES.has(tokens[endIdx].toLowerCase())) endIdx--;
  // Then walk back over particles preceding the core.
  let startIdx = endIdx;
  while (startIdx > 0 && NAME_PARTICLES.has(tokens[startIdx - 1].toLowerCase())) startIdx--;
  // Defensive: if everything is particles + suffix, treat the whole string
  // as the last name (no first-name portion).
  if (startIdx === 0) {
    return tokens.map(t => t.toUpperCase()).join(' ');
  }
  const firstParts = tokens.slice(0, startIdx);
  const lastParts  = tokens.slice(startIdx); // particles + core + suffixes
  return firstParts.join(' ') + ' ' + lastParts.map(t => t.toUpperCase()).join(' ');
};

/**
 * Apply caps overrides for a template. `caps` is the saved object
 * { key: 'upper'|'normal'|'default' }.
 *
 * Uses a MutationObserver so the override sticks even when graphic JS
 * later recreates the row elements (rankings, standings, etc.).
 */
window.applyGraphicsCaps = function applyGraphicsCaps(template, caps) {
  const targets = (window.GraphicsCapsTargets || {})[template];
  if (!targets) return;
  const map = caps || {};

  function paint() {
    const globalFmt = window.graphicsNameFormat || 'default';
    targets.forEach(t => {
      const userMode = map[t.key] || 'default';
      // For person-name fields, 'default' inherits the global nameFormat.
      const effective = (t.isName && userMode === 'default') ? globalFmt : userMode;

      document.querySelectorAll(t.selector).forEach(el => {
        if (t.isName && effective === 'firstlast') {
          // Suppress any CSS uppercase that would clobber the partial-case rewrite.
          el.style.textTransform = 'none';
          applyNameRewrite(el, 'firstlast');
        } else {
          // Restore the original source text if we'd previously rewritten this
          // element, so the field reverts cleanly when the operator switches modes.
          if (el.dataset.nameLastOut && el.textContent === el.dataset.nameLastOut && el.dataset.nameSource) {
            el.textContent = el.dataset.nameSource;
          }
          delete el.dataset.nameLastOut;
          // Standard CSS text-transform path.
          el.style.textTransform =
              effective === 'upper'  ? 'uppercase'
            : effective === 'normal' ? 'none'
            : '';                                       // '' clears the inline override
        }
      });
    });
  }

  // Rewrite an element's textContent in place. Tracks the source text in a
  // data attribute so repeated MutationObserver-driven paints are idempotent
  // and we can detect when graphic JS has written new source data.
  function applyNameRewrite(el, mode) {
    const cur = el.textContent;
    const lastOut = el.dataset.nameLastOut;
    // If the text matches our last output, graphic JS hasn't touched it —
    // use the cached source. Otherwise treat the current text as a fresh
    // source from graphic JS and re-cache it.
    const source = (lastOut && lastOut === cur && el.dataset.nameSource)
                 ? el.dataset.nameSource
                 : cur;
    el.dataset.nameSource = source;
    let out = source;
    if (mode === 'firstlast') {
      out = window.formatNameFirstLast ? window.formatNameFirstLast(source) : source;
    } else if (mode === 'upper') {
      out = source.toUpperCase();
    }
    if (out !== cur) el.textContent = out;
    el.dataset.nameLastOut = out;
  }

  paint();

  // Re-apply when row content gets re-rendered (graphic JS often replaces
  // .innerHTML on data updates, which wipes inline styles).
  if (!window._capsObserver) {
    let pending = false;
    window._capsObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; paint(); });
    });
    window._capsObserver.observe(document.body, { childList: true, subtree: true });
    window._capsRepaint = paint;
  } else {
    window._capsRepaint = paint;
  }
};
