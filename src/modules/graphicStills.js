'use strict';

/**
 * Render graphics to transparent PNG stills.
 *
 * For rebuilding a stream after the fact: drop the name bar in when a skater
 * is announced, the score panel when the scores are read. The PNGs carry a
 * real alpha channel, so they key straight over recorded video.
 *
 * The graphic pages themselves do the drawing — same HTML, CSS, fonts and
 * theme vMix loads — so a still is what the live graphic actually looked
 * like rather than an approximation of it.
 *
 * Uses puppeteer-core against a browser already on the machine. Bundling
 * Chromium would add ~570 MB to every install; Chrome or Edge is present on
 * any Windows box we deploy to.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');

const ROOT     = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const OUT_ROOT = path.join(ROOT, 'exports');

// Graphics that can be rebuilt from stored data, and how many stills each
// produces. Clocks are excluded — nothing to reconstruct.
const PER_SKATER = {
  'manual-skater': { label: 'Skater Name Bar',  suffix: 'name'     },
  'scoring':       { label: 'Scoring',          suffix: 'score'    },
  'elements':      { label: 'Elements Tracker', suffix: 'elements' },
};

// ── browser discovery ───────────────────────────────────────────────────────

/**
 * Find an installed Chromium-based browser.
 *
 * Order is deliberate: an explicit override first, then Chrome (what the
 * production machines have), then Edge (always present on Windows, so the
 * safety net), then a Chromium left in puppeteer's cache on a dev machine.
 */
function findBrowser() {
  const tryPath = p => { try { return p && fs.existsSync(p) ? p : null; } catch { return null; } };

  if (process.env.VMIX_CHROME_PATH) {
    const p = tryPath(process.env.VMIX_CHROME_PATH);
    if (p) return { path: p, name: 'set by VMIX_CHROME_PATH' };
    throw new Error(`VMIX_CHROME_PATH is set but nothing is there: ${process.env.VMIX_CHROME_PATH}`);
  }

  const candidates = process.platform === 'win32'
    ? [
        ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
        ['Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
        ['Chrome', path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')],
        ['Edge',   'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
        ['Edge',   'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
        ['Brave',  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ]
    : process.platform === 'darwin'
    ? [
        ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ['Edge',   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
        ['Brave',  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
        ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ]
    : [
        ['Chrome', '/usr/bin/google-chrome'],
        ['Chrome', '/usr/bin/google-chrome-stable'],
        ['Chromium', '/usr/bin/chromium'],
        ['Chromium', '/usr/bin/chromium-browser'],
        ['Edge',   '/usr/bin/microsoft-edge'],
      ];

  for (const [name, p] of candidates) {
    const hit = tryPath(p);
    if (hit) return { path: hit, name };
  }

  // A dev machine that has run `npm install puppeteer` has a Chromium here.
  try {
    const cache = path.join(os.homedir(), '.cache', 'puppeteer');
    for (const kind of ['chrome', 'chrome-headless-shell']) {
      const dir = path.join(cache, kind);
      if (!fs.existsSync(dir)) continue;
      for (const build of fs.readdirSync(dir).sort().reverse()) {
        for (const rel of [
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-linux64/chrome',
          'chrome-win64/chrome.exe',
          'chrome-headless-shell-mac-arm64/chrome-headless-shell',
          'chrome-headless-shell-mac-x64/chrome-headless-shell',
          'chrome-headless-shell-linux64/chrome-headless-shell',
          'chrome-headless-shell-win64/chrome-headless-shell.exe',
        ]) {
          const hit = tryPath(path.join(dir, build, rel));
          if (hit) return { path: hit, name: 'bundled Chromium (dev machine)' };
        }
      }
    }
  } catch { /* fall through to the error below */ }

  throw new Error(
    'No Chrome, Edge or Chromium found on this machine. Install Google Chrome, ' +
    'or set VMIX_CHROME_PATH to a browser executable.'
  );
}

// ── data ────────────────────────────────────────────────────────────────────

function apiGet(baseUrl, p) {
  const u = new URL(baseUrl + p);
  return new Promise((resolve, reject) => {
    https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: 15000 }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`Bad JSON from ${p}`)); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error(`Timed out: ${p}`)); });
  });
}

/** Filesystem-safe, readable, sorts by skate order. */
function safeName(order, name) {
  const clean = String(name || 'unknown')
    .replace(/\s*\/\s*/g, ' and ')          // pairs and dance names carry a slash
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${String(order ?? 0).padStart(2, '0')} ${clean}`;
}

function folderName(catName, segName) {
  return `${catName} ${segName}`.replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-');
}

// ── the job ─────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.segmentId
 * @param {string[]} opts.graphics    keys of PER_SKATER
 * @param {string}   opts.scoreKind   'segment' | 'category'
 * @param {string}   opts.apiBaseUrl  Skate Canada API base
 * @param {number}   opts.port        this server's port
 * @param {function} opts.onProgress  ({ done, total, message }) => void
 * @param {object}   [opts.poller]    sc-api service — paused while rendering
 */
async function exportStills(opts) {
  const {
    segmentId, graphics, scoreKind = 'segment',
    apiBaseUrl, port = 3012, onProgress = () => {}, poller = null,
  } = opts;

  if (!segmentId) throw new Error('segmentId is required');
  const wanted = (graphics || []).filter(g => PER_SKATER[g]);
  if (!wanted.length) throw new Error('Pick at least one graphic');

  const newApi = require(path.join(ROOT, 'normalizers', 'skate-canada-new-api.js'));
  const browser0 = findBrowser();
  onProgress({ done: 0, total: 0, message: `Using ${browser0.name}` });

  const seg = (await apiGet(apiBaseUrl, `/segment/${segmentId}`)).Segment;
  if (!seg) throw new Error(`No segment ${segmentId}`);
  const catId = seg.segmentCategoryId || seg.categoryId;
  const cat = catId ? (await apiGet(apiBaseUrl, `/category/${catId}`)).Category : {};
  const entries = ((await apiGet(apiBaseUrl, `/segment/${segmentId}/entries`)).CompetitorEntries || [])
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (!entries.length) throw new Error('That segment has no entries');

  const catName = newApi.catEn(cat) || 'Category';
  const outDir = path.join(OUT_ROOT, folderName(catName, seg.segmentName));
  fs.mkdirSync(outDir, { recursive: true });

  // Category totals — the entry DTO only carries this segment's score.
  const priorBySkater = new Map();
  if (scoreKind === 'category' && catId) {
    onProgress({ done: 0, total: 0, message: 'Summing the other segments…' });
    for (const s of ((await apiGet(apiBaseUrl, `/category/${catId}/segments`)).Segments || [])) {
      const sid = newApi.safeStr(s.segmentId);
      if (!sid || sid === segmentId) continue;
      for (const e of ((await apiGet(apiBaseUrl, `/segment/${sid}/entries`)).CompetitorEntries || [])) {
        const k = newApi.safeStr(e.skaterId || e.skatingCompetitorId);
        const v = newApi.safeNum(e.score);
        if (k && v != null) priorBySkater.set(k, (priorBySkater.get(k) || 0) + v);
      }
    }
  }

  // The live poller rewrites these same files every couple of seconds. Left
  // running it overwrites each payload between the write and the screenshot,
  // so stills come out carrying the CURRENT event's data — the elements
  // panel's "Highest TES" is the giveaway. Pause it for the duration.
  const wasPolling = !!(poller && poller.isActive && poller.isActive());
  if (wasPolling) {
    onProgress({ done: 0, total: 0, message: 'Pausing live polling…' });
    try { poller.stop(); } catch { /* not fatal — worst case a still is stale */ }
  }

  // Borrow the live data files; always hand them back.
  const touched = wanted.map(g => path.join(DATA_DIR, `${g}.json`));
  const backup = new Map();
  for (const f of touched) if (fs.existsSync(f)) backup.set(f, fs.readFileSync(f));
  const restore = () => {
    for (const [f, buf] of backup) { try { fs.writeFileSync(f, buf); } catch {} }
    if (wasPolling) { try { poller.start(); } catch { /* operator can restart it */ } }
  };

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: browser0.path,
    headless: true,
    args: ['--force-device-scale-factor=1', '--disable-lcd-text', '--no-sandbox'],
  });

  const total = entries.length * wanted.length;
  const files = [];
  let done = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    for (const entry of entries) {
      const label = safeName(entry.sortOrder, entry.competitorName);

      for (const graphic of wanted) {
        const meta = PER_SKATER[graphic];
        onProgress({ done, total, message: `${label} — ${meta.label}` });

        let payload = null;
        if (graphic === 'manual-skater') {
          payload = newApi.normalizeLowerThird(entry, cat, seg, { visible: true, state: 'visible' });
        } else if (graphic === 'scoring') {
          const comps = (await apiGet(apiBaseUrl, `/entry/${entry.competitorEntryId}/components`)).Components || [];
          let adjs = await apiGet(apiBaseUrl, `/entry/${entry.competitorEntryId}/adjustments`);
          if (!Array.isArray(adjs)) adjs = [];
          const prior = priorBySkater.get(newApi.safeStr(entry.skaterId || entry.skatingCompetitorId));
          const catTotal = scoreKind === 'category' && prior != null
            ? Math.round((prior + (newApi.safeNum(entry.score) || 0)) * 100) / 100
            : null;
          payload = newApi.normalizeScoring(entry, comps, adjs, cat, seg, 'en', { visible: true, state: 'visible' }, catTotal);
        } else if (graphic === 'elements') {
          const els = (await apiGet(apiBaseUrl, `/entry/${entry.competitorEntryId}/elements`)).SkateElements || [];
          if (!els.length) { done++; continue; }        // withdrew, or never skated
          let hi = 0, hiName = '';
          for (const e of entries) if ((e.tes || 0) > hi) { hi = e.tes; hiName = e.competitorName; }
          payload = newApi.normalizeElements(els, entry, cat, seg, { visible: true, state: 'visible' },
            { highestTes: hi, highestTesName: hiName, scoredCount: entries.filter(e => e.score > 0).length });
        }
        if (!payload) { done++; continue; }

        payload.control = { visible: true, state: 'visible' };
        fs.writeFileSync(path.join(DATA_DIR, `${graphic}.json`), JSON.stringify(payload, null, 2));

        await page.goto(`http://localhost:${port}/graphics/${graphic}/`, { waitUntil: 'networkidle0', timeout: 25000 });
        await page.evaluate(() => document.fonts.ready);

        if (graphic === 'scoring') {
          // The total counts up, and a category total is revealed later still
          // (entry animation + --sc-reveal-delay-ms). Waiting a fixed time
          // either races the reveal or wastes seconds, so wait for the number
          // itself to land on what we know it should be.
          const want = payload.data.catTotal != null && payload.data.catTotal > payload.data.total
            ? payload.data.catTotal : payload.data.total;
          await page.waitForFunction(expected => {
            const el = document.getElementById('val-total');
            if (!el) return false;
            const shown = parseFloat(String(el.textContent).replace(/[^\d.]/g, ''));
            return Number.isFinite(shown) && Math.abs(shown - expected) < 0.005;
          }, { timeout: 20000, polling: 120 }, want).catch(() => {});
          await new Promise(r => setTimeout(r, 1100));
        } else if (graphic === 'elements') {
          // The rows are in the DOM immediately, but the body they sit in
          // starts at max-height:0 and only expands after --el-body-delay
          // (2s by default), after which each row fades in. Counting rows
          // therefore succeeds while the panel is still shut — wait for the
          // body to have real height AND the last row to have faded in.
          const rows = payload.data.rows.length;
          await page.waitForFunction(n => {
            const body = document.querySelector('.el-body');
            if (!body || body.getBoundingClientRect().height < 20) return false;
            const all = document.querySelectorAll('.el-row');
            if (all.length < n) return false;
            const last = all[all.length - 1];
            return parseFloat(getComputedStyle(last).opacity) > 0.9;
          }, { timeout: 25000, polling: 150 }, rows).catch(() => {});
          await new Promise(r => setTimeout(r, 900));
        } else {
          await new Promise(r => setTimeout(r, 2600));
        }

        // Clip to the graphic rather than the 1920x1080 frame, so the PNG is
        // only as big as the bar and drops straight onto a timeline.
        const box = await page.evaluate(() => {
          const el = document.querySelector('.lower-third, .manual-skater, .scoring, .elements, #graphic-root');
          if (!el) return null;
          const parts = [...el.querySelectorAll('*')]
            .filter(n => { const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.01; })
            .map(n => n.getBoundingClientRect()).filter(r => r.width > 1 && r.height > 1);
          const own = el.getBoundingClientRect();
          if (own.width > 1 && own.height > 1) parts.push(own);
          if (!parts.length) return null;
          const pad = 2;
          const x1 = Math.max(0, Math.min(...parts.map(r => r.left)) - pad);
          const y1 = Math.max(0, Math.min(...parts.map(r => r.top)) - pad);
          const x2 = Math.min(1920, Math.max(...parts.map(r => r.right)) + pad);
          const y2 = Math.min(1080, Math.max(...parts.map(r => r.bottom)) + pad);
          return { x: Math.floor(x1), y: Math.floor(y1), width: Math.ceil(x2 - x1), height: Math.ceil(y2 - y1) };
        });
        if (!box || box.width < 4 || box.height < 4) { done++; continue; }

        const file = path.join(outDir, `${label} - ${meta.suffix}.png`);
        // omitBackground is what gives a real alpha channel rather than a
        // screenshot with the page background baked in.
        await page.screenshot({ path: file, omitBackground: true, clip: box });
        files.push(path.basename(file));
        done++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    restore();
  }

  onProgress({ done: total, total, message: 'Done' });
  return { outDir, files, count: files.length, category: catName, segment: seg.segmentName };
}

module.exports = { exportStills, findBrowser, PER_SKATER, OUT_ROOT };
