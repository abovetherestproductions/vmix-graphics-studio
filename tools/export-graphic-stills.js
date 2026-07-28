'use strict';

/**
 * Command-line front end for the stills exporter.
 *
 * Same engine as Tools → Export Stills in the app; this is here for batching
 * several segments without clicking through the UI.
 *
 *   node tools/export-graphic-stills.js --segment <id> [options]
 *
 *     --segment <id>    REQUIRED. Skate Canada segment GUID.
 *     --graphics a,b    manual-skater,scoring,elements (default: first two)
 *     --score category  cumulative category total instead of this segment's
 *     --port <n>        port the graphics server is on (default 3012)
 *
 * The server must be running. Live polling is paused while it renders and
 * resumed afterwards, and the live data files are put back either way.
 *
 * NOTE: run through the app instead when polling is active, so the running
 * server pauses its own poller — this entry point can only ask over HTTP.
 */

const http = require('http');
const { exportStills, PER_SKATER } = require('../src/modules/graphicStills');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const SEGMENT  = arg('segment');
const PORT     = Number(arg('port', 3012));
const GRAPHICS = arg('graphics', 'manual-skater,scoring').split(',').map(s => s.trim()).filter(Boolean);
const SCORE    = arg('score', 'segment');

if (!SEGMENT) {
  console.error('\n  --segment <segmentId> is required.');
  console.error(`  --graphics accepts: ${Object.keys(PER_SKATER).join(', ')}\n`);
  process.exit(1);
}

function post(path, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { host: 'localhost', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      r => { r.resume(); r.on('end', resolve); });
    req.on('error', resolve);   // server may not be running; not fatal here
    req.write(data); req.end();
  });
}

function get(path) {
  return new Promise(resolve => {
    http.get({ host: 'localhost', port: PORT, path, timeout: 4000 }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

(async () => {
  // This process is not the server, so it cannot pause the poller directly —
  // ask over HTTP, and put it back at the end if it was running.
  const status = await get('/api/status');
  const wasPolling = !!status?.livePollActive;
  if (wasPolling) {
    console.log('  Pausing live polling…');
    await post('/api/sc-api/stop');
    await new Promise(r => setTimeout(r, 800));
  }

  let last = -1;
  try {
    const result = await exportStills({
      segmentId: SEGMENT,
      graphics: GRAPHICS,
      scoreKind: SCORE === 'category' ? 'category' : 'segment',
      apiBaseUrl: 'https://sc-css-public-api-cmh9d3htgxfpdkb7.canadacentral-01.azurewebsites.net',
      port: PORT,
      onProgress: p => {
        if (p.total && p.done !== last) { last = p.done; console.log(`  [${p.done}/${p.total}] ${p.message}`); }
        else if (!p.total) console.log(`  ${p.message}`);
      },
    });
    console.log(`\n  ${result.count} PNGs`);
    console.log(`  ${result.outDir}\n`);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (wasPolling) { console.log('  Resuming live polling…'); await post('/api/sc-api/refresh'); }
  }
})();
