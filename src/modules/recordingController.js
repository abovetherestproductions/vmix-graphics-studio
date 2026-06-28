const crypto = require('crypto');
const path = require('path');
const files = require('./recordingFiles');

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createRecordingController({ getSettings, stateService, vmixService, logger }) {
  let activeSession = null;
  const processingSessions = new Map();
  let lastProcessedFile = null;
  let lastError = null;
  let recordingActionInProgress = false;

  function getStatus() {
    return {
      recording: ['recording', 'stopping'].includes(activeSession?.status),
      actionInProgress: recordingActionInProgress,
      activeSession,
      processingSessions: Array.from(processingSessions.values()),
      lastProcessedFile,
      lastError,
    };
  }

  async function runExclusiveRecordingAction(action) {
    if (recordingActionInProgress) {
      return {
        success: false,
        action: 'busy',
        message: 'A recording action is already in progress. Please wait for it to finish before pressing the toggle again.',
        ...getStatus(),
      };
    }

    recordingActionInProgress = true;
    try {
      return await action();
    } finally {
      recordingActionInProgress = false;
    }
  }

  function createFilePlan(snapshot, settings = getSettings()) {
    const hasMetadata = files.hasSkaterMetadata(snapshot);

    if (!hasMetadata && settings.safety?.moveUncertainFilesToNeedsReview !== false) {
      return {
        snapshot,
        hasMetadata,
        needsReview: true,
        finalFolder: settings.localRecordingSorter?.needsReviewFolder,
        finalFileName: files.buildNeedsReviewFileName(snapshot),
      };
    }

    if (!hasMetadata) {
      return {
        snapshot,
        hasMetadata,
        needsReview: true,
        leaveInPlace: true,
        finalFolder: null,
        finalFileName: null,
      };
    }

    return {
      snapshot,
      hasMetadata,
      needsReview: false,
      finalFolder: files.buildCategoryFolder(snapshot, settings),
      finalFileName: files.buildFinalFileName(snapshot, settings),
    };
  }

  function createSession(startSnapshot, vmixWasRecording = false) {
    const filePlan = createFilePlan(startSnapshot);
    return {
      sessionId: uuid(),
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      startSnapshot,
      stopSnapshot: null,
      filePlan,
      vmixWasRecording,
      rawFilePath: null,
      finalFilePath: null,
      status: 'recording',
    };
  }

  async function startLocalRecordingNow() {
    const vmixStatus = await vmixService.getRecordingStatus();
    if (vmixStatus.recording) {
      activeSession = activeSession || createSession(stateService.snapshot(), true);
      logger.log('recording already active', { session: activeSession });
      return {
        success: true,
        action: 'already_recording',
        vmixRecording: true,
        sessionId: activeSession.sessionId,
        message: 'vMix is already recording.',
      };
    }

    const startSnapshot = stateService.snapshot();
    activeSession = createSession(startSnapshot, false);
    lastError = null;
    logger.log('recording started', { sessionId: activeSession.sessionId, startSnapshot, filePlan: activeSession.filePlan });
    await vmixService.startRecording();
    return {
      success: true,
      action: 'started',
      vmixRecording: true,
      sessionId: activeSession.sessionId,
      message: 'vMix recording started',
    };
  }

  async function processStoppedFile(session) {
    const settings = getSettings();
    const folder = settings.vmix?.vmixRecordingFolder;
    const discoveryTimeoutMs = settings.safety?.recordingFileDiscoveryTimeoutMs || 180000;
    const finalizationTimeoutMs = settings.safety?.recordingFinalizationTimeoutMs || 180000;
    const found = await files.waitForRecordingFile({
      folder,
      timestamp: session.startedAt,
      expectedFilePath: session.rawFilePath,
    }, { timeoutMs: discoveryTimeoutMs });
    if (found.warning) logger.log('recording file warning', { sessionId: session.sessionId, warning: found.warning, candidates: found.candidates });
    if (!found.filePath) {
      session.status = 'needs_review';
      lastError = found.warning || 'No finalized MP4 was found in the vMix recording folder.';
      logger.log('recording file missing', { sessionId: session.sessionId, folder, message: lastError });
      return {
        success: false,
        action: 'needs_review',
        message: lastError,
      };
    }

    session.rawFilePath = found.filePath;
    logger.log('raw MP4 detected', { sessionId: session.sessionId, rawFilePath: found.filePath });

    const finalized = await files.waitForFileToFinalize(found.filePath, { timeoutMs: finalizationTimeoutMs });
    if (!finalized.finalized) {
      session.status = 'needs_review';
      lastError = finalized.warning || 'MP4 did not finalize in time.';
      logger.log('recording finalization timeout', { sessionId: session.sessionId, rawFilePath: found.filePath, warning: lastError });
      return {
        success: false,
        action: 'needs_review',
        rawFilePath: found.filePath,
        message: lastError,
      };
    }

    const filePlan = session.filePlan || createFilePlan(session.startSnapshot || session.stopSnapshot, settings);
    let finalFolder = filePlan.finalFolder;
    let finalFileName = filePlan.finalFileName;

    if (!filePlan.hasMetadata && filePlan.leaveInPlace) {
      session.status = 'needs_review';
      lastError = 'Recording stopped but metadata was missing. File was left in the vMix recording folder.';
      logger.log('recording metadata missing', { sessionId: session.sessionId, rawFilePath: found.filePath });
      return {
        success: false,
        action: 'needs_review',
        rawFilePath: found.filePath,
        message: lastError,
      };
    } else if (filePlan.needsReview) {
      session.status = 'needs_review';
    } else {
      session.status = 'processing';
    }

    try {
      const finalPath = files.moveRecordingToFinalFolder(found.filePath, finalFolder, finalFileName, settings);
      session.finalFilePath = finalPath;
      lastProcessedFile = finalPath;
      lastError = null;
      if (session.status !== 'needs_review') session.status = 'completed';
      logger.log('final MP4 path', { sessionId: session.sessionId, finalFilePath: finalPath, status: session.status });
      return {
        success: session.status === 'completed',
        action: session.status === 'completed' ? 'stopped' : 'needs_review',
        vmixRecording: false,
        finalFilePath: finalPath,
        needsReviewPath: session.status === 'needs_review' ? finalPath : undefined,
        message: session.status === 'completed'
          ? 'Recording stopped and file processed'
          : 'Recording stopped but metadata was missing. File moved to Needs Review.',
      };
    } catch (err) {
      session.status = 'error';
      lastError = err.message;
      logger.log('recording move error', { sessionId: session.sessionId, rawFilePath: found.filePath, finalFolder, finalFileName, error: err.message });
      return {
        success: false,
        action: 'error',
        rawFilePath: found.filePath,
        message: `Recording stopped but the file could not be moved: ${err.message}`,
      };
    }
  }

  function processStoppedFileInBackground(session) {
    processingSessions.set(session.sessionId, session);
    processStoppedFile(session)
      .then(result => {
        logger.log('recording background processing complete', {
          sessionId: session.sessionId,
          action: result.action,
          success: result.success,
          finalFilePath: result.finalFilePath,
          needsReviewPath: result.needsReviewPath,
          message: result.message,
        });
      })
      .catch(err => {
        session.status = 'error';
        lastError = err.message;
        logger.log('recording background processing error', { sessionId: session.sessionId, error: err.message });
      })
      .finally(() => {
        processingSessions.delete(session.sessionId);
      });
  }

  async function stopLocalRecordingNow() {
    const vmixStatus = await vmixService.getRecordingStatus();
    const session = activeSession || createSession(stateService.snapshot(), true);
    if (vmixStatus.recordingFilePath) session.rawFilePath = vmixStatus.recordingFilePath;
    const shouldSendStop = vmixStatus.recording || session.status === 'recording' || session.vmixWasRecording;
    activeSession = session;
    session.status = 'stopping';
    session.stoppedAt = new Date().toISOString();
    session.stopSnapshot = stateService.snapshot();
    logger.log('recording stopped', {
      sessionId: session.sessionId,
      stopSnapshot: session.stopSnapshot,
      rawFilePath: session.rawFilePath,
    });

    if (shouldSendStop) await vmixService.stopRecording();
    session.status = 'processing';
    processStoppedFileInBackground(session);
    activeSession = null;
    return {
      success: true,
      action: 'stopped',
      vmixRecording: false,
      sessionId: session.sessionId,
      message: 'vMix recording stopped. MP4 finalization is continuing in the background.',
    };
  }

  async function toggleLocalRecordingNow() {
    try {
      if (activeSession && activeSession.status === 'recording') {
        return await stopLocalRecordingNow();
      }
      if (activeSession && activeSession.status === 'stopping') {
        return {
          success: false,
          action: 'busy',
          sessionId: activeSession.sessionId,
          message: 'Recording is stopping. Please wait for vMix to finish the stop command before toggling again.',
          ...getStatus(),
        };
      }
      const vmixStatus = await vmixService.getRecordingStatus();
      if (vmixStatus.recording) return await stopLocalRecordingNow();
      return await startLocalRecordingNow();
    } catch (err) {
      lastError = err.message;
      if (activeSession) activeSession.status = 'error';
      logger.log('recording toggle error', { error: err.message });
      return { success: false, action: 'error', message: err.message };
    }
  }

  async function startLocalRecording() {
    return runExclusiveRecordingAction(startLocalRecordingNow);
  }

  async function stopLocalRecording() {
    return runExclusiveRecordingAction(stopLocalRecordingNow);
  }

  async function toggleLocalRecording() {
    return runExclusiveRecordingAction(toggleLocalRecordingNow);
  }

  function previewLocalFilename() {
    return {
      success: true,
      previewPath: files.previewLocalFilename(stateService.snapshot(), getSettings()),
      snapshot: stateService.snapshot(),
    };
  }

  function testRecordingFolder() {
    return files.testFolderAccess(getSettings().vmix?.vmixRecordingFolder);
  }

  function testOutputFolder() {
    const settings = getSettings();
    const rootResult = files.testFolderAccess(settings.localRecordingSorter?.outputRootFolder);
    const reviewResult = files.testFolderAccess(settings.localRecordingSorter?.needsReviewFolder);
    return {
      success: rootResult.success && reviewResult.success,
      outputRootFolder: rootResult,
      needsReviewFolder: reviewResult,
      pathModuleSeparator: path.sep,
    };
  }

  return {
    getStatus,
    startLocalRecording,
    stopLocalRecording,
    toggleLocalRecording,
    previewLocalFilename,
    testRecordingFolder,
    testOutputFolder,
  };
}

module.exports = { createRecordingController };
