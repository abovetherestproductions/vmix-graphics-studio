/**
 * Unified normalizer entry point.
 *
 * Auto-detects source format (JSON vs CSV) and routes to the correct adapter.
 * Also exposes HTTP endpoint helpers used by server.js.
 *
 * Usage from server:
 *   const normalizers = require('./normalizers');
 *   const payload = await normalizers.fromUrl('http://scoring.example.com/startOrder.php', 'starting-order');
 *   const payload = normalizers.fromFile('/path/to/officials.csv', 'officials', { title: 'SP Officials' });
 */

'use strict';

const path = require('path');
const https = require('https');
const http  = require('http');
const skateCanada = require('./skate-canada-json');
const csvAdapter  = require('./csv-adapter');

// ── Fetch helper ───────────────────────────────────────────────────────────

/**
 * Fetches a URL and parses the response as JSON.
 * Follows up to 5 redirects automatically.
 * Throws a descriptive error if the response is not JSON or the request fails.
 */
function fetchJson(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;

    const req = lib.get(url, { headers: { 'Accept': 'application/json, */*' } }, res => {
      // Follow redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`));
        const redirectUrl = new URL(res.headers.location, url).toString();
        return fetchJson(redirectUrl, redirectsLeft - 1).then(resolve, reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // drain
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const trimmed = data.trimStart();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          // Likely an HTML error page — show first 120 chars for debugging
          return reject(new Error(
            `Non-JSON response from ${url} (HTTP ${res.statusCode}): ${trimmed.slice(0, 120)}`
          ));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed from ${url}: ${e.message}`)); }
      });
    });

    req.on('error', err => reject(new Error(`Network error fetching ${url}: ${err.message}`)));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

// ── From URL (Skate Canada online system) ─────────────────────────────────

async function fromUrl(url, template, options = {}) {
  const raw = await fetchJson(url);
  return fromRawJson(raw, template, options);
}

// ── From raw JSON object ───────────────────────────────────────────────────

function fromRawJson(raw, template, options = {}) {
  switch (template) {
    case 'starting-order': return skateCanada.normalizeStartingOrder(raw, options.groupNumber ?? null);
    case 'scoring':        return skateCanada.normalizeScoring(raw);
    case 'standings':      return skateCanada.normalizeStandings(raw, options.maxRows ?? null);
    case 'officials':      return skateCanada.normalizeOfficials(raw);
    default: throw new Error(`Unknown template: ${template}`);
  }
}

// ── From local file (CSV or JSON) ─────────────────────────────────────────

function fromFile(filePath, template, options = {}) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv' || ext === '.tsv') {
    return fromCsv(filePath, template, options);
  }

  // JSON file
  const fs  = require('fs');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return fromRawJson(raw, template, options);
}

function fromCsv(filePath, template, options = {}) {
  switch (template) {
    case 'event-info':      return csvAdapter.csvToEventInfo(filePath, options);
    case 'starting-order': return csvAdapter.csvToStartingOrder(filePath, options);
    case 'officials':      return csvAdapter.csvToOfficials(filePath, options);
    case 'standings':      return csvAdapter.csvToStandings(filePath, options);
    case 'rankings':       return csvAdapter.csvToRankings(filePath, options);
    case 'scoring':        return csvAdapter.csvToScoring(filePath, options);
    case 'elements':       return csvAdapter.csvToElements(filePath, options);
    default: throw new Error(`CSV adapter not available for template: ${template}`);
  }
}

module.exports = { fromUrl, fromFile, fromRawJson, fromCsv, fetchJson };
