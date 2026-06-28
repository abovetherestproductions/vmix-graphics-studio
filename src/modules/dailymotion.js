const https = require('https');

function requestJson(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.dailymotion.com',
      path: apiPath,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (res.statusCode >= 400) {
          reject(new Error(parsed.error?.message || parsed.message || `Dailymotion HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function formatText(format, snapshot = {}) {
  return String(format || '')
    .replace(/\{eventName\}/g, snapshot.eventName || '')
    .replace(/\{categoryName\}/g, snapshot.categoryName || '')
    .replace(/\{segmentName\}/g, snapshot.segmentName || '')
    .replace(/\{segmentNumber\}/g, snapshot.segmentNumber || '')
    .replace(/\{skaterName\}/g, snapshot.skaterName || '')
    .replace(/\{club\}/g, snapshot.club || '')
    .replace(/\{startOrder\}/g, snapshot.startOrder || '')
    .trim();
}

function createDailymotionService(getSettings, getSnapshot, logger) {
  let lastStatus = 'unknown';
  let latestVod = null;
  let lastError = null;

  function configStatus() {
    const settings = getSettings();
    const dm = settings.dailymotion || {};
    const token = process.env.DAILYMOTION_ACCESS_TOKEN || '';
    const missing = [];
    if (!dm.dailymotionEnabled) missing.push('Dailymotion is disabled in settings.');
    if (!dm.dailymotionLiveVideoId) missing.push('Dailymotion live video ID is missing.');
    if (!token) missing.push('DAILYMOTION_ACCESS_TOKEN is missing.');
    return { settings, dm, token, missing, enabled: dm.dailymotionEnabled && dm.dailymotionLiveVideoId && token };
  }

  async function getRecordingStatus() {
    const cfg = configStatus();
    if (!cfg.enabled) {
      return {
        enabled: !!cfg.dm.dailymotionEnabled,
        configured: false,
        recordStatus: 'not_configured',
        liveVideoId: cfg.dm.dailymotionLiveVideoId || '',
        latestVodId: latestVod?.id || '',
        latestVodTitle: latestVod?.title || '',
        lastError,
        message: cfg.missing.join(' '),
      };
    }
    try {
      const data = await requestJson('GET', `/video/${encodeURIComponent(cfg.dm.dailymotionLiveVideoId)}?fields=id,title,record_status`, null, cfg.token);
      lastStatus = data.record_status || data.recordStatus || 'unknown';
      lastError = null;
      return {
        enabled: true,
        configured: true,
        recordStatus: lastStatus,
        liveVideoId: cfg.dm.dailymotionLiveVideoId,
        latestVodId: latestVod?.id || '',
        latestVodTitle: latestVod?.title || '',
        lastError,
      };
    } catch (err) {
      lastError = err.message;
      return { enabled: true, configured: true, recordStatus: lastStatus, liveVideoId: cfg.dm.dailymotionLiveVideoId, lastError };
    }
  }

  async function setRecordStatus(recordStatus) {
    const cfg = configStatus();
    if (!cfg.enabled) return { success: false, ...await getRecordingStatus() };
    // Dailymotion live manual recording is controlled through record_status on
    // the live video. If the API account requires a form-encoded variant, this
    // is the only call shape that should need adjusting.
    const data = await requestJson('POST', `/video/${encodeURIComponent(cfg.dm.dailymotionLiveVideoId)}`, { record_status: recordStatus }, cfg.token);
    lastStatus = data.record_status || recordStatus;
    lastError = null;
    logger?.log(`dailymotion recording ${recordStatus}`, { liveVideoId: cfg.dm.dailymotionLiveVideoId });
    return { success: true, enabled: true, recordStatus: lastStatus, liveVideoId: cfg.dm.dailymotionLiveVideoId };
  }

  async function startRecording() {
    return setRecordStatus('started');
  }

  async function stopRecording() {
    const stopped = await setRecordStatus('stopped');
    const latest = await getLatestRecordingForLiveVideo();
    return { ...stopped, latestVodId: latest?.id || '', latestVodTitle: latest?.title || '' };
  }

  async function toggleRecording() {
    const status = await getRecordingStatus();
    if (!status.configured) return { success: false, action: 'not_configured', ...status };
    if (['started', 'starting'].includes(status.recordStatus)) {
      const stopped = await stopRecording();
      return { ...stopped, action: 'stopped' };
    }
    const started = await startRecording();
    return { ...started, action: 'started' };
  }

  async function getLatestRecordingForLiveVideo() {
    const cfg = configStatus();
    if (!cfg.enabled) return null;
    // TODO: Confirm the exact recordings collection path for the connected
    // Dailymotion account; this endpoint shape follows the public video-child
    // collection pattern and fails safely if unavailable.
    try {
      const data = await requestJson(
        'GET',
        `/video/${encodeURIComponent(cfg.dm.dailymotionLiveVideoId)}/recordings?fields=id,title,created_time&limit=1&sort=recent`,
        null,
        cfg.token
      );
      latestVod = Array.isArray(data.list) ? data.list[0] : null;
      return latestVod;
    } catch (err) {
      lastError = err.message;
      return null;
    }
  }

  async function updateVodMetadata(videoId, title, description) {
    const cfg = configStatus();
    if (!cfg.enabled) return { success: false, message: cfg.missing.join(' ') };
    if (!videoId) return { success: false, message: 'No Dailymotion VOD video ID is available.' };
    const body = { title };
    if (description) body.description = description;
    const data = await requestJson('POST', `/video/${encodeURIComponent(videoId)}`, body, cfg.token);
    latestVod = { id: videoId, title: data.title || title };
    logger?.log('dailymotion VOD renamed', { videoId, title });
    return { success: true, videoId, title: latestVod.title };
  }

  async function renameLatest() {
    const cfg = configStatus();
    if (!cfg.enabled) return { success: false, action: 'not_configured', ...await getRecordingStatus() };
    const latest = await getLatestRecordingForLiveVideo();
    if (!latest?.id) return { success: false, message: 'No latest Dailymotion recording was found.' };
    const snapshot = getSnapshot();
    const title = formatText(cfg.dm.dailymotionVodTitleFormat || '{eventName} - {categoryName}', snapshot);
    const description = formatText(cfg.dm.dailymotionVodDescriptionFormat || '', snapshot);
    const renamed = await updateVodMetadata(latest.id, title, description);
    return { ...renamed, latestVodId: latest.id, latestVodTitle: title };
  }

  async function testConnection() {
    return getRecordingStatus();
  }

  function previewTitle(snapshot = getSnapshot()) {
    const cfg = configStatus();
    return formatText(cfg.dm.dailymotionVodTitleFormat || '{eventName} - {categoryName}', snapshot);
  }

  return {
    getRecordingStatus,
    startRecording,
    stopRecording,
    toggleRecording,
    getLatestRecordingForLiveVideo,
    updateVodMetadata,
    renameLatest,
    testConnection,
    previewTitle,
  };
}

module.exports = { createDailymotionService };
