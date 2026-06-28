const http = require('http');

function encodeQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function requestText(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`vMix returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`vMix request timed out after ${timeoutMs}ms`));
    });
  });
}

function textTag(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].trim() : '';
}

function tagAttribute(xml, tagName, attributeName) {
  const tagMatch = String(xml || '').match(new RegExp(`<${tagName}\\b([^>]*)>`, 'i'));
  if (!tagMatch) return '';
  const attributeMatch = tagMatch[1].match(new RegExp(`\\b${attributeName}\\s*=\\s*"([^"]*)"`, 'i'));
  return attributeMatch ? attributeMatch[1].trim() : '';
}

function createVmixService(getSettings) {
  function getBaseUrl() {
    const settings = getSettings();
    const host = settings.vmix?.vmixHost || process.env.VMIX_HOST || '127.0.0.1';
    const port = Number(settings.vmix?.vmixPort || process.env.VMIX_PORT || 8088);
    return `http://${host}:${port}/api/`;
  }

  async function getVmixState() {
    const xml = await requestText(getBaseUrl());
    return {
      connected: true,
      rawXml: xml,
      recording: /^true$/i.test(textTag(xml, 'recording')),
      recordingFilePath: tagAttribute(xml, 'recording', 'filename1'),
      version: textTag(xml, 'version'),
      preset: textTag(xml, 'preset'),
    };
  }

  async function getRecordingStatus() {
    const state = await getVmixState();
    return {
      recording: state.recording,
      recordingFilePath: state.recordingFilePath,
      connected: true,
      version: state.version,
      preset: state.preset,
    };
  }

  async function callFunction(functionName, params = {}) {
    const qs = encodeQuery({ Function: functionName, ...params });
    const body = await requestText(`${getBaseUrl()}?${qs}`);
    return { success: true, functionName, response: body };
  }

  async function startRecording() {
    return callFunction('StartRecording');
  }

  async function stopRecording() {
    return callFunction('StopRecording');
  }

  async function toggleRecording() {
    const status = await getRecordingStatus();
    if (status.recording) {
      await stopRecording();
      return { action: 'stopped', recording: false };
    }
    await startRecording();
    return { action: 'started', recording: true };
  }

  async function browserNavigate(inputName, url) {
    return callFunction('BrowserNavigate', { Input: inputName, Value: url });
  }

  function normalizeOverlayNumber(overlayNumber) {
    const number = Math.min(Math.max(Number(overlayNumber) || 1, 1), 4);
    return number;
  }

  async function overlayIn(overlayNumber, inputName) {
    const number = normalizeOverlayNumber(overlayNumber);
    return callFunction(`OverlayInput${number}In`, { Input: inputName });
  }

  async function overlayOut(overlayNumber, inputName) {
    const number = normalizeOverlayNumber(overlayNumber);
    return callFunction(`OverlayInput${number}Out`, inputName ? { Input: inputName } : {});
  }

  function parseOverlaySlot(xml, overlayNumber) {
    const match = xml.match(new RegExp(`<overlay number="${overlayNumber}"[^>]*>([^<]*)</overlay>`, 'i'));
    if (!match) return null;
    const content = match[1].trim();
    return content || null;
  }

  function inputMatchesIdentifier(xml, slotInputNumber, inputIdentifier) {
    if (!slotInputNumber || !inputIdentifier) return false;
    const target = String(inputIdentifier).trim();
    if (target === slotInputNumber) return true;
    const inputRegex = new RegExp(
      `<input\\b[^>]*\\bnumber="${slotInputNumber}"[^>]*?(?:\\s+key="([^"]*)")?[^>]*?(?:\\s+title="([^"]*)")?[^>]*>`,
      'i'
    );
    const inputMatch = xml.match(inputRegex);
    if (!inputMatch) return false;
    const key = inputMatch[1] || '';
    const title = inputMatch[2] || '';
    const targetLc = target.toLowerCase();
    return targetLc === title.trim().toLowerCase() || targetLc === key.toLowerCase();
  }

  // Single round-trip query: returns { slot, mine } where slot is the input
  // number currently on the overlay channel (or null if empty), and mine is
  // true iff that input matches the given identifier. Used by stateless
  // toggles to decide show vs hide.
  async function getOverlayState(overlayNumber, inputIdentifier) {
    const number = normalizeOverlayNumber(overlayNumber);
    try {
      const xml = await requestText(getBaseUrl(), 2000);
      const slot = parseOverlaySlot(xml, number);
      const mine = slot ? inputMatchesIdentifier(xml, slot, inputIdentifier) : false;
      return { slot, mine };
    } catch {
      return { slot: null, mine: false };
    }
  }

  async function testConnection() {
    try {
      const state = await getVmixState();
      return { success: true, connected: true, recording: state.recording, version: state.version, preset: state.preset };
    } catch (err) {
      return { success: false, connected: false, error: err.message };
    }
  }

  return {
    getBaseUrl,
    getVmixState,
    getRecordingStatus,
    startRecording,
    stopRecording,
    toggleRecording,
    browserNavigate,
    overlayIn,
    overlayOut,
    getOverlayState,
    testConnection,
  };
}

module.exports = { createVmixService, tagAttribute, textTag };
