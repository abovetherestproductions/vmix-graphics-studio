const fs = require('fs');
const path = require('path');

function scrubSecrets(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrubSecrets);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|client_secret/i.test(key)) out[key] = '[redacted]';
    else out[key] = scrubSecrets(item);
  }
  return out;
}

function createActionLogger(rootDir, getSettings) {
  const logDir = path.join(rootDir, 'logs');
  const logPath = path.join(logDir, 'recording-actions.log');

  function log(action, details = {}) {
    const settings = getSettings ? getSettings() : {};
    if (settings.safety?.writeActionLog === false) return;
    fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      action,
      details: scrubSecrets(details),
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }

  return { logPath, log };
}

module.exports = { createActionLogger };
