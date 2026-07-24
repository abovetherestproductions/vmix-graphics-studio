'use strict';

const http = require('http');

/**
 * Thin wrapper around the vMix HTTP API.
 * vMix listens on port 8088 by default and returns XML responses.
 * All we need is fire-and-forget for recording commands.
 */
function createVmixClient({ getSettings }) {

  function cfg()  { return getSettings().vmix || {}; }
  function host() { return cfg().vmixHost || 'localhost'; }
  function port() { return Number(cfg().vmixPort) || 8088; }

  function command(fn, value = '') {
    const path = `/api/?Function=${encodeURIComponent(fn)}${value ? '&Value=' + encodeURIComponent(value) : ''}`;
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: host(), port: port(), path, timeout: 4000 }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('vMix timeout')); });
    });
  }

  async function setFilename(filename) {
    await command('SetRecordingFilename', filename);
  }

  async function startRecording(filename) {
    if (filename) await setFilename(filename);
    await command('StartRecording');
  }

  async function stopRecording() {
    await command('StopRecording');
  }

  // Returns vMix state XML as a string — caller can check <recording> node if needed
  async function getState() {
    return command('');
  }

  return { command, setFilename, startRecording, stopRecording, getState };
}

module.exports = { createVmixClient };
