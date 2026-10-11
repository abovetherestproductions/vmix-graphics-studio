(function () {
  const root       = document.getElementById('graphic-root');
  const nameRowEl  = document.getElementById('sp-name-row');
  const photoWrap  = document.getElementById('sp-photo-wrap');
  const photoSlot  = document.getElementById('sp-photo-slot-1');
  const photoEl    = document.getElementById('sp-photo');
  const initials1  = document.getElementById('sp-initials-1');
  const photo2Slot = document.getElementById('sp-photo-slot-2');
  const photo2El   = document.getElementById('sp-photo-2');
  const initials2  = document.getElementById('sp-initials-2');
  const detailsEl  = document.getElementById('sp-details');
  const bioEl      = document.getElementById('sp-bio');
  const pbEventEl  = document.getElementById('sp-pb-event');
  const statSbEl   = document.getElementById('stat-sb');
  const statPbEl   = document.getElementById('stat-pb');
  const eventEl    = document.getElementById('sp-event');
  const subtitleEl = document.getElementById('sp-subtitle');
  const nameEl     = document.getElementById('sp-name');
  const clubEl     = document.getElementById('sp-club');
  const sbEl       = document.getElementById('sp-sb');
  const pbEl       = document.getElementById('sp-pb');
  const flagEl     = document.getElementById('sp-flag');
  const capFlagEl  = document.getElementById('sp-flag-cap');

  // Portraits-first layout (see the Portraits section of the stylesheet).
  const cEl        = document.getElementById('sp-c');
  const cFlagEl    = document.getElementById('sp-c-flag');
  const cCountryEl = document.getElementById('sp-c-country');
  const cDiscEl    = document.getElementById('sp-c-disc');
  const cPeople    = [1, 2].map(n => ({
    person: document.getElementById('sp-c-p' + n),
    photo:  document.getElementById('sp-c-photo-' + n),
    img:    document.getElementById('sp-c-img-' + n),
    ini:    document.getElementById('sp-c-ini-' + n),
    first:  document.getElementById('sp-c-first-' + n),
    last:   document.getElementById('sp-c-last-' + n),
  }));

  let currentRevision = null;
  let currentVisible  = false;
  let busy            = false;
  let queuedPayload   = null;
  let lastPayload     = null;

  function log(...args) {
    if (window.GraphicsConfig?.debug) console.log('[skater-profile]', ...args);
  }

  function fmt(n) {
    if (n == null || n === '') return '—';
    const num = Number(n);
    return Number.isFinite(num) ? num.toFixed(2) : '—';
  }

  /**
   * Which optional rows the operator has switched on for this graphic.
   *
   * Every detail defaults to OFF and the two score tiles default to ON, so a
   * graphic with no settings saved renders exactly as it did before any of
   * this existed.
   */
  function shown() {
    const o = (window.configHeaderOverrides || {})['skater-profile'] || {};
    return {
      // Detail rows are opt-in and named by their data-field, so a new row
      // needs nothing here beyond its markup and its switch.
      row: field => o['spShow' + field.charAt(0).toUpperCase() + field.slice(1)] === true,
      // Portraits first is the default; Compact is the earlier layout, kept
      // for when the supplied portraits are too weak to lead with.
      layout:       o.spLayout === 'compact' ? 'compact' : 'portraits',
      header:       o.spShowHeader       !== false,
      headerAlign:  ['left', 'center', 'right'].includes(o.spHeaderAlign) ? o.spHeaderAlign : 'right',
      bio:          o.spShowBio          === true,
      pbEvent:      o.spShowPbEvent      === true,
      seasonBest:   o.spShowSeasonBest   !== false,
      personalBest: o.spShowPersonalBest !== false,
    };
  }


  // ── Portraits ────────────────────────────────────────────────────────────

  /** "Romain LE GAC" -> "RL". The ISU writes surnames in capitals, so the
   *  surname is the first all-caps word after the given name. */
  function initialsOf(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const sur = parts.find((w, i) => i > 0 && w === w.toUpperCase() && /[A-ZÀ-Ý]/.test(w))
             || (parts.length > 1 ? parts[parts.length - 1] : '');
    return (parts[0][0] + (sur ? sur[0] : '')).toUpperCase();
  }

  /** "Romain LE GAC" -> { given: "Romain", surname: "LE GAC" }. The surname
   *  starts at the first all-caps word after the given name; with no such
   *  word, the last word is taken as the surname. */
  function splitName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { given: '', surname: parts[0] || '' };
    const i = parts.findIndex((w, k) => k > 0 && w === w.toUpperCase() && /[A-ZÀ-Ý]/.test(w));
    const at = i > 0 ? i : parts.length - 1;
    return { given: parts.slice(0, at).join(' '), surname: parts.slice(at).join(' ') };
  }

  function setPortrait(slot, img, initialsEl, url, name) {
    initialsEl.textContent = initialsOf(name);
    if (!url) {
      slot.classList.add('is-empty');
      img.removeAttribute('src');
      return;
    }
    // Retry an image that failed earlier: the first selection of a skater can
    // beat the server's portrait download, and the next render should pick it
    // up instead of staying on initials for the rest of the session.
    const retry = slot.classList.contains('is-empty');
    slot.classList.remove('is-empty');
    if (retry || img.getAttribute('src') !== url) img.src = url;
  }

  // A portrait that fails to load becomes initials rather than a broken-image
  // icon. Wired once; render() only ever sets the source.
  [[photoSlot, photoEl], [photo2Slot, photo2El], ...cPeople.map(c => [c.photo, c.img])].forEach(([slot, img]) => {
    img.addEventListener('error', () => { if (img.getAttribute('src')) slot.classList.add('is-empty'); });
    img.addEventListener('load',  () => slot.classList.remove('is-empty'));
  });

  // ── Name fitting ─────────────────────────────────────────────────────────

  /**
   * Shrink the name until every line fits on one line, down to half size.
   *
   * The portrait takes width from the name, so a long surname that used to
   * fit comfortably can now overflow. Ellipsising a name on a graphic whose
   * whole job is introducing the athlete is the worst outcome, so the size
   * gives way first. fitTitleOneLine in utils.js is not used because it wraps
   * to a second line at its floor and cannot see text clipped inside child
   * lines, which is exactly how a team's names are built.
   */
  function fitName() {
    const lines = nameEl.classList.contains('is-team')
      ? [...nameEl.querySelectorAll('.sp-name-line')]
      : [nameEl];
    nameEl.style.fontSize = '';
    const base = parseFloat(getComputedStyle(nameEl).fontSize) || 44;
    const overflows = () => lines.some(el => el.scrollWidth > el.clientWidth + 1);
    if (!overflows()) return;
    let lo = Math.max(14, Math.floor(base * 0.5)), hi = base;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      nameEl.style.fontSize = `${mid}px`;
      if (overflows()) hi = mid - 1; else lo = mid;
    }
    nameEl.style.fontSize = `${lo}px`;
  }

  /**
   * Portraits-first: shrink each surname to fit its plate, down to 55%. On a
   * team both end up at the smaller of the two sizes, so one long surname does
   * not leave its partner looking mismatched.
   */
  function fitCNames() {
    const shown = cPeople.filter(c => !c.person.hidden);
    const sizes = shown.map(c => {
      c.last.style.fontSize = '';
      const base = parseFloat(getComputedStyle(c.last).fontSize) || 32;
      const overflows = () => c.last.scrollWidth > c.last.clientWidth + 1;
      if (!overflows()) return base;
      let lo = Math.max(14, Math.floor(base * 0.55)), hi = base;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        c.last.style.fontSize = `${mid}px`;
        if (overflows()) hi = mid - 1; else lo = mid;
      }
      return lo;
    });
    const common = Math.min(...sizes);
    shown.forEach(c => { c.last.style.fontSize = `${common}px`; });
  }

  /**
   * Portraits-first only. Values wrap as far as they need to, so a very long
   * entry makes the card taller than the screen allows. Before anything is cut
   * off, the portraits give up height, ten pixels at a time, down to a floor
   * at which a face is still a face. Only entries that would otherwise be cut
   * ever shrink them, so an ordinary card keeps the portrait height set in the
   * operator panel. Past the floor the foot of the card clips, as before.
   */
  const PORTRAIT_FLOOR = 170;
  function fitPortraitHeight() {
    root.style.removeProperty('--sp-c-photo-h-fit');
    if (!root.classList.contains('layout-portraits')) return;
    const body = document.querySelector('.sp-body');
    if (!body || body.scrollHeight <= body.clientHeight) return;
    const first = cPeople.find(c => !c.person.hidden && c.photo.offsetHeight);
    if (!first) return;                      // no portraits showing, nothing to give back
    let h = Math.floor(first.photo.offsetHeight);
    while (h > PORTRAIT_FLOOR && body.scrollHeight > body.clientHeight) {
      h = Math.max(PORTRAIT_FLOOR, h - 10);
      root.style.setProperty('--sp-c-photo-h-fit', `${h}px`);
    }
  }

  function fitNames() {
    if (root.classList.contains('layout-portraits')) fitCNames(); else fitName();
    fitPortraitHeight();
  }

  function scheduleNameFit() {
    // Two frames for layout to settle, and again once the display font is in:
    // measuring against a fallback font gives the wrong answer.
    requestAnimationFrame(() => requestAnimationFrame(fitNames));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitNames);
  }

  function render(payload) {
    lastPayload = payload;
    const data = payload.data || {};

    // Title source dropdown (auto/category/segment/event/custom) handled here.
    // 'auto' uses data.event for back-compat with the existing payload shape.
    eventEl.textContent = window.GraphicsUtils.resolveTitle(
      'skater-profile',
      { ...data, title: data.event, titleEn: data.event },
      data.event || ''
    );
    // The title gives way before it is cut off: shrunk to fit its space, down
    // to 70% of the size set in the panel, then wrapped. It matters most when
    // the text is centred beside a logo, which leaves it the least room.
    if (window.GraphicsUtils.fitTitleOneLine) window.GraphicsUtils.fitTitleOneLine(eventEl);
    // Second line. Defaults to the category, which on this graphic is the
    // discipline — "Men", "Ice Dance". Empty collapses the line rather than
    // leaving a gap under the title.
    subtitleEl.textContent = window.GraphicsUtils.resolveSubtitle(
      'skater-profile', data, ''
    );
    // Teams get a line each so both names stay whole; singles keep the
    // existing behaviour, including the shrink-to-initials fallback.
    const twoNames = !!(data.skater1Name && data.skater2Name);
    nameEl.classList.toggle('is-team', twoNames);
    nameEl.style.fontSize = '';   // drop last render's fitted size
    nameEl.textContent = '';
    delete nameEl.dataset.initialsInput; // clear the initials memo either way
    if (twoNames) {
      for (const who of [data.skater1Name, data.skater2Name]) {
        const line = document.createElement('div');
        line.className = 'sp-name-line';
        line.textContent = who;
        nameEl.appendChild(line);
      }
    } else {
      window.GraphicsUtils.applyInitialsIfNeeded(nameEl, data.name || '');
    }
    clubEl.textContent     = data.club     || '';
    sbEl.textContent       = fmt(data.seasonBest);
    pbEl.textContent       = fmt(data.personalBest);

    const show = shown();

    // Header off: the whole bar goes and the body starts at the top of the
    // card, so everything beneath it moves up.
    root.classList.toggle('no-header', !show.header);
    // Header text alignment, plus whether there is a logo for centred text to
    // keep clear of (the loader hides the logo wrapper when it is switched off).
    ['left', 'center', 'right'].forEach(a => root.classList.toggle('hdr-' + a, show.headerAlign === a));
    const logoWrap = document.querySelector('.sp-logo-wrap');
    root.classList.toggle('hdr-nologo', !logoWrap || getComputedStyle(logoWrap).display === 'none');
    root.classList.toggle('layout-portraits', show.layout === 'portraits');
    root.classList.toggle('layout-compact',   show.layout === 'compact');

    // Score tiles. Hiding both collapses the row rather than leaving a gap.
    statSbEl.hidden = !show.seasonBest;
    statPbEl.hidden = !show.personalBest;
    const pbEvent = show.pbEvent && show.personalBest && (data.personalBestEvent || '');
    pbEventEl.hidden = !pbEvent;
    pbEventEl.textContent = pbEvent || '';

    // Optional detail rows — a row appears only when switched on AND the
    // feed actually has something for it, so an empty label never airs.
    let anyDetail = false;
    detailsEl.querySelectorAll('.sp-detail').forEach(rowEl => {
      const field = rowEl.dataset.field;
      const raw   = data[field];
      // A field with two answers arrives as an array — one line per skater,
      // stacked like their names. Everything else is a plain string.
      const lines = (Array.isArray(raw) ? raw : [raw])
        .map(v => (v == null ? '' : String(v).trim()))
        .filter(Boolean);
      const on = show.row(field) && lines.length > 0;
      rowEl.hidden = !on;
      if (on) {
        const valueEl = rowEl.querySelector('.sp-detail-value');
        const stacked = lines.length > 1;
        valueEl.classList.toggle('is-stacked', stacked);
        if (stacked) {
          valueEl.textContent = '';
          for (const line of lines) {
            const el = document.createElement('div');
            el.className = 'sp-detail-line';
            el.textContent = line;
            valueEl.appendChild(el);
          }
        } else {
          valueEl.textContent = lines[0];
        }
        anyDetail = true;
      }
    });
    detailsEl.hidden = !anyDetail;

    const bio = show.bio && (data.bio || '').trim();
    bioEl.hidden = !bio;
    bioEl.textContent = bio || '';

    // Portraits sit in the name row. A team shows one per skater whenever
    // either exists, so the rows stay level with the names, and the one that
    // is missing becomes an initials tile. A single skater shows theirs or
    // nothing - the flag and name simply start further left.
    const url1 = (data.photoUrl  || '').trim();
    const url2 = (data.photoUrl2 || '').trim();
    const hasPhotos = twoNames ? !!(url1 || url2) : !!url1;
    photoWrap.hidden = !hasPhotos;
    nameRowEl.classList.toggle('is-team', twoNames);
    nameRowEl.classList.toggle('has-photos', hasPhotos);
    setPortrait(photoSlot, photoEl, initials1, url1, data.skater1Name || data.name);
    photo2Slot.hidden = !twoNames;
    if (twoNames) setPortrait(photo2Slot, photo2El, initials2, url2, data.skater2Name);
    else photo2El.removeAttribute('src');

    // Portraits-first block, built from the same data. A team is two people
    // side by side; a single skater is one person with the name beside them.
    const cNames = twoNames ? [data.skater1Name, data.skater2Name] : [data.skater1Name || data.name];
    const cUrls  = twoNames ? [url1, url2] : [url1];
    cEl.classList.toggle('is-team', twoNames);
    cEl.classList.toggle('is-single', !twoNames);
    cEl.classList.toggle('no-photos', !cUrls.some(Boolean));
    cPeople.forEach((c, i) => {
      const present = i < cNames.length;
      c.person.hidden = !present;
      if (!present) { c.img.removeAttribute('src'); return; }
      const { given, surname } = splitName(cNames[i]);
      c.first.textContent = given;
      c.first.hidden = !given;
      c.last.textContent = surname;
      c.last.style.fontSize = '';          // drop last render's fitted size
      setPortrait(c.photo, c.img, c.ini, cUrls[i], cNames[i]);
    });
    cCountryEl.textContent = data.club || '';
    cDiscEl.textContent = subtitleEl.textContent;
    cFlagEl.classList.toggle('is-on', !!data.flagUrl);
    if (data.flagUrl) {
      window.GraphicsUtils.wireFlagFallback(cFlagEl, cFlagEl);
      cFlagEl.src = data.flagUrl;
    }

    if (data.flagUrl) {
      window.GraphicsUtils.wireFlagFallback(flagEl, flagEl);
      flagEl.src = data.flagUrl;
      flagEl.style.display = '';
    } else {
      flagEl.style.display = 'none';
    }

    // A team's flag lives in the caption under the pair instead (see the
    // stylesheet); a single skater's stays beside their name.
    const capFlag = twoNames && !!data.flagUrl;
    capFlagEl.classList.toggle('is-on', capFlag);
    if (capFlag) {
      window.GraphicsUtils.wireFlagFallback(capFlagEl, capFlagEl);
      capFlagEl.src = data.flagUrl;
    }

    scheduleNameFit();
  }

  function animateIn(payload) {
    render(payload);
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
      }, 320);
    });
  }

  async function animateUpdate(payload) {
    await animateOut();
    await window.GraphicsUtils.delay(60);
    animateIn(payload);
  }

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
      if (queuedPayload) { const n = queuedPayload; queuedPayload = null; handlePayload(n); }
    }
  }

  new window.JsonPoller({
    url: '/data/skater-profile.json',
    intervalMs: window.GraphicsConfig?.pollIntervalMs || 500,
    onData: handlePayload,
    onError: e => console.error('[skater-profile] poll error:', e),
  }).start();

  if (window.WsListener) window.WsListener.subscribe('skater-profile', handlePayload);

  // Re-render when operator changes config (caps, header text, etc.)
  window.addEventListener('graphics-config-updated', () => {
    if (lastPayload) render(lastPayload);
  });
})();
