'use strict';

/**
 * Export graphics as transparent PNG stills, one per skater.
 *
 * For rebuilding a stream after the fact: drop the name bar in when a skater
 * is announced, the score panel when the scores are read. The PNGs carry a
 * real alpha channel, so they key straight over the recorded video with no
 * matte and no background to punch out.
 *
 * Renders the actual graphic pages in headless Chrome — the same HTML, CSS,
 * fonts and theme vMix loads — so a still is pixel-identical to what the
 * live graphic looked like. Nothing is re-drawn or approximated.
 *
 * Usage:
 *   node tools/export-graphic-stills.js --segment <segmentId> [options]
 *
 *   --segment <id>     REQUIRED. Skate Canada segment GUID.
 *   --out <dir>        Output folder (default: exports/<category>-<segment>)
 *   --graphics a,b     Which to render (default: manual-skater,scoring)
 *   --score category   Show the category total instead of this segment's score
 *   --port <n>         Port the graphics server is on (default: 3012)
 *
 * The server must be running, and this borrows its data files while it works
 * — it restores them and the live config when finished, including on error.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'public', 'data');
const API_HOST  = 'sc-css-public-api-cmh9d3htgxfpdkb7.canadacentral-01.azurewebsites.net';

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg  = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SEGMENT  = arg('segment');
const PORT     = Number(arg('port', 3012));
const GRAPHICS = arg('graphics', 'manual-skater,scoring').split(',').map(s => s.trim()).filter(Boolean);
const SCORE_KIND = arg('score', 'segment');   // 'segment' | 'category'
let   OUT_DIR  = arg('out');

if (!SEGMENT) {
  console.error('\n  --segment <segmentId> is required.\n');
  console.error('  Find it in the Event & Skater Selector, or:');
  console.error('  curl -s http://localhost:3012/api/sc-api/browse/category/<categoryId>\n');
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const say = m => console.log(`  ${m}`);
const step = m => console.log(`\n=== ${m} ===`);

function apiGet(p) {
  return new Promise((resolve, reject) => {
    require('https').get({ hostname: API_HOST, path: p }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function localGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p, timeout: 5000 }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => resolve(b));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

/** Filesystem-safe, readable, and stable enough to sort by skate order. */
function safeName(order, name) {
  const clean = String(name || 'unknown')
    .replace(/\s*\/\s*/g, ' and ')       // pairs/dance names carry a slash
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${String(order ?? 0).padStart(2, '0')} ${clean}`;
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const puppeteer = require('puppeteer');

  step('Reading the segment');
  const seg = (await apiGet(`/segment/${SEGMENT}`)).Segment;
  if (!seg) throw new Error(`No segment ${SEGMENT}`);
  // The DTO calls it segmentCategoryId; the other spellings are belt-and-braces.
  const catId = seg.segmentCategoryId || seg.categoryId || seg.category?.categoryId;
  const cat   = catId ? (await apiGet(`/category/${catId}`)).Category : {};
  const entries = ((await apiGet(`/segment/${SEGMENT}/entries`)).CompetitorEntries || [])
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const newApi = require(path.join(ROOT, 'normalizers', 'skate-canada-new-api.js'));
  const catName = newApi.catEn(cat) || 'Category';
  say(`${catName} — ${seg.segmentName}`);
  say(`${entries.length} entries`);

  if (!OUT_DIR) {
    OUT_DIR = path.join(ROOT, 'exports',
      `${catName} ${seg.segmentName}`.replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-'));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  say(`Output: ${OUT_DIR}`);

  // Category totals, when asked for — the entry DTO only carries this segment.
  let priorBySkater = new Map();
  if (SCORE_KIND === 'category') {
    step('Summing the other segments for category totals');
    const segs = (await apiGet(`/category/${catId}/segments`)).Segments || [];
    for (const s of segs) {
      const sid = newApi.safeStr(s.segmentId);
      if (!sid || sid === SEGMENT) continue;
      const ents = (await apiGet(`/segment/${sid}/entries`)).CompetitorEntries || [];
      for (const e of ents) {
        const k = newApi.safeStr(e.skaterId || e.skatingCompetitorId);
        const v = newApi.safeNum(e.score);
        if (k && v != null) priorBySkater.set(k, (priorBySkater.get(k) || 0) + v);
      }
      say(`${s.segmentName}: ${ents.filter(e => e.score > 0).length} scored`);
    }
  }

  // Borrow the live data files; always hand them back.
  const touched = GRAPHICS.map(g => path.join(DATA_DIR, `${g}.json`));
  const backup = new Map();
  for (const f of touched) if (fs.existsSync(f)) backup.set(f, fs.readFileSync(f));
  const restore = () => {
    for (const [f, buf] of backup) { try { fs.writeFileSync(f, buf); } catch {} }
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--force-device-scale-factor=1', '--disable-lcd-text'],
  });

  let written = 0;
  try {
    step('Rendering');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    for (const entry of entries) {
      const label = safeName(entry.sortOrder, entry.competitorName);

      for (const graphic of GRAPHICS) {
        let payload;
        if (graphic === 'manual-skater' || graphic === 'lower-third') {
          payload = newApi.normalizeLowerThird(entry, cat, seg, { visible: true, state: 'visible' });
        } else if (graphic === 'scoring') {
          const comps = (await apiGet(`/entry/${entry.competitorEntryId}/components`)).Components || [];
          let adjs = await apiGet(`/entry/${entry.competitorEntryId}/adjustments`);
          if (!Array.isArray(adjs)) adjs = [];
          const skaterKey = newApi.safeStr(entry.skaterId || entry.skatingCompetitorId);
          const prior = priorBySkater.get(skaterKey);
          const catTotal = SCORE_KIND === 'category' && prior != null
            ? Math.round((prior + (newApi.safeNum(entry.score) || 0)) * 100) / 100
            : null;
          payload = newApi.normalizeScoring(entry, comps, adjs, cat, seg, 'en',
                                            { visible: true, state: 'visible' }, catTotal);
        } else {
          throw new Error(`Don't know how to build a payload for "${graphic}"`);
        }
        if (!payload) { say(`skipped ${label} (${graphic}) — no payload`); continue; }

        payload.control = { visible: true, state: 'visible' };
        fs.writeFileSync(path.join(DATA_DIR, `${graphic}.json`), JSON.stringify(payload, null, 2));

        await page.goto(`http://localhost:${PORT}/graphics/${graphic}/`,
                        { waitUntil: 'networkidle0', timeout: 20000 });
        await page.evaluate(() => document.fonts.ready);

        if (graphic === 'scoring') {
          // The total counts up, and when a category total is present it is
          // revealed later still (entry animation + --sc-reveal-delay-ms,
          // 5s on this config). Waiting a fixed time either races the reveal
          // or wastes seconds, so wait for the number itself to settle on the
          // value we know it should end at.
          const want = payload.data.catTotal != null && payload.data.catTotal > payload.data.total
            ? payload.data.catTotal
            : payload.data.total;
          const ok = await page.waitForFunction(
            expected => {
              const el = document.getElementById('val-total');
              if (!el) return false;
              const shown = parseFloat(String(el.textContent).replace(/[^\d.]/g, ''));
              return Number.isFinite(shown) && Math.abs(shown - expected) < 0.005;
            },
            { timeout: 20000, polling: 120 }, want
          ).then(() => true).catch(() => false);
          if (!ok) say(`  ! ${label}: total never reached ${want} — capturing anyway`);
          // Let the reveal's pulse/pop animations finish before the shutter.
          await new Promise(r => setTimeout(r, 1100));
        } else {
          // Name bars just slide in.
          await new Promise(r => setTimeout(r, 2600));
        }

        // Clip to the graphic itself rather than the 1920x1080 frame, so the
        // PNG is only as big as the bar and drops straight onto a timeline.
        const box = await page.evaluate(() => {
          const el = document.querySelector('.lower-third, .manual-skater, .scoring, #graphic-root');
          if (!el) return null;
          const parts = [...el.querySelectorAll('*')]
            .filter(n => { const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.01; })
            .map(n => n.getBoundingClientRect())
            .filter(r => r.width > 1 && r.height > 1);
          const own = el.getBoundingClientRect();
          if (own.width > 1 && own.height > 1) parts.push(own);
          if (!parts.length) return null;
          const pad = 2;
          const x1 = Math.max(0, Math.min(...parts.map(r => r.left))   - pad);
          const y1 = Math.max(0, Math.min(...parts.map(r => r.top))    - pad);
          const x2 = Math.min(1920, Math.max(...parts.map(r => r.right))  + pad);
          const y2 = Math.min(1080, Math.max(...parts.map(r => r.bottom)) + pad);
          return { x: Math.floor(x1), y: Math.floor(y1), width: Math.ceil(x2 - x1), height: Math.ceil(y2 - y1) };
        });
        if (!box || box.width < 4 || box.height < 4) { say(`skipped ${label} (${graphic}) — nothing visible`); continue; }

        const suffix = graphic === 'scoring' ? 'score' : 'name';
        const file = path.join(OUT_DIR, `${label} - ${suffix}.png`);
        // omitBackground is what gives a real alpha channel instead of a
        // screenshot with the page background baked in.
        await page.screenshot({ path: file, omitBackground: true, clip: box });
        written++;
        say(`${path.basename(file)}  (${box.width}x${box.height})`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    restore();
    // Nudge the server to reload the restored files.
    try { await localGet('/api/config'); } catch {}
  }

  step('Done');
  say(`${written} PNG${written === 1 ? '' : 's'} in ${OUT_DIR}`);
  say('Live data files restored.');
})().catch(err => {
  console.error(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
