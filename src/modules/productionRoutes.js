function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch((err) => {
      res.status(500).json({ success: false, message: err.message });
    });
  };
}

function ok(res, body) {
  res.json({ success: true, ...body });
}

function registerDual(app, path, handler) {
  app.get(path, handler);
  app.post(path, handler);
}

function registerProductionRoutes(app, services) {
  const {
    settingsService,
    stateService,
    vmixService,
    recordingController,
    recordingRepairService,
    dailymotionService,
    logger,
    graphics,
  } = services;

  app.get('/api/settings', (_req, res) => {
    res.json({
      success: true,
      settings: settingsService.getPublicSettings(),
      warnings: settingsService.validateSettings(),
    });
  });

  app.post('/api/settings', (req, res) => {
    const settings = settingsService.writeSettings(req.body || {});
    logger.log('settings updated', { sections: Object.keys(req.body || {}) });
    res.json({ success: true, settings, warnings: settingsService.validateSettings(settings) });
  });

  app.get('/api/production/status', asyncHandler(async (_req, res) => {
    const settings = settingsService.getPublicSettings();
    const vmix = await vmixService.testConnection();
    const dailymotion = await dailymotionService.getRecordingStatus();
    res.json({
      success: true,
      current: stateService.readState(),
      settingsWarnings: settingsService.validateSettings(settings),
      vmix,
      localRecording: recordingController.getStatus(),
      dailymotion,
      previews: {
        localFilename: recordingController.previewLocalFilename().previewPath,
        dailymotionTitle: dailymotionService.previewTitle(),
      },
    });
  }));

  app.get('/api/state/current', (_req, res) => ok(res, { state: stateService.readState() }));
  app.post('/api/state/current', (req, res) => ok(res, { state: stateService.updateState(req.body || {}) }));
  app.post('/api/state/current-category', (req, res) => ok(res, { state: stateService.setCurrentCategory(req.body || {}) }));
  app.post('/api/state/current-skater', (req, res) => ok(res, { state: stateService.setCurrentSkater(req.body || {}) }));
  registerDual(app, '/api/state/next-skater', (_req, res) => ok(res, stateService.nextSkater()));
  registerDual(app, '/api/state/previous-skater', (_req, res) => ok(res, stateService.previousSkater()));

  app.get('/api/vmix/status', asyncHandler(async (_req, res) => ok(res, await vmixService.testConnection())));
  app.get('/api/vmix/recording/status', asyncHandler(async (_req, res) => {
    try {
      const vmix = await vmixService.getRecordingStatus();
      res.json({ success: true, ...recordingController.getStatus(), vmixRecording: vmix.recording });
    } catch (err) {
      res.json({
        success: false,
        ...recordingController.getStatus(),
        vmixRecording: false,
        message: err.message,
      });
    }
  }));
  registerDual(app, '/api/vmix/recording/toggle', asyncHandler(async (_req, res) => res.json(await recordingController.toggleLocalRecording())));
  registerDual(app, '/api/vmix/recording/start', asyncHandler(async (_req, res) => res.json(await recordingController.startLocalRecording())));
  registerDual(app, '/api/vmix/recording/stop', asyncHandler(async (_req, res) => res.json(await recordingController.stopLocalRecording())));
  registerDual(app, '/api/recording/local/toggle', asyncHandler(async (_req, res) => res.json(await recordingController.toggleLocalRecording())));
  registerDual(app, '/api/recording/local/start', asyncHandler(async (_req, res) => res.json(await recordingController.startLocalRecording())));
  registerDual(app, '/api/recording/local/stop', asyncHandler(async (_req, res) => res.json(await recordingController.stopLocalRecording())));

  app.get('/api/test/vmix', asyncHandler(async (_req, res) => ok(res, await vmixService.testConnection())));
  app.get('/api/test/recording-folder', (_req, res) => ok(res, recordingController.testRecordingFolder()));
  app.get('/api/test/output-folder', (_req, res) => ok(res, recordingController.testOutputFolder()));
  app.get('/api/preview/local-filename', (_req, res) => ok(res, recordingController.previewLocalFilename()));
  app.get('/api/preview/dailymotion-title', (_req, res) => ok(res, { title: dailymotionService.previewTitle(), snapshot: stateService.snapshot() }));
  app.post('/api/recording/repair/scan', asyncHandler(async (_req, res) => res.json(recordingRepairService.scan())));
  app.post('/api/recording/repair/apply', asyncHandler(async (req, res) => {
    const status = recordingController.getStatus();
    if (status.recording || status.actionInProgress || status.processingSessions?.length) {
      return res.status(409).json({
        success: false,
        message: 'Recording repair cannot run while a recording is active or being processed.',
      });
    }
    return res.json(recordingRepairService.apply(req.body?.token));
  }));

  app.get('/api/dailymotion/recording/status', asyncHandler(async (_req, res) => res.json({ success: true, ...await dailymotionService.getRecordingStatus() })));
  registerDual(app, '/api/dailymotion/recording/toggle', asyncHandler(async (_req, res) => res.json(await dailymotionService.toggleRecording())));
  registerDual(app, '/api/dailymotion/recording/start', asyncHandler(async (_req, res) => res.json(await dailymotionService.startRecording())));
  registerDual(app, '/api/dailymotion/recording/stop', asyncHandler(async (_req, res) => res.json(await dailymotionService.stopRecording())));
  registerDual(app, '/api/recording/dailymotion/toggle', asyncHandler(async (_req, res) => res.json(await dailymotionService.toggleRecording())));
  app.post('/api/dailymotion/recording/rename-latest', asyncHandler(async (_req, res) => res.json(await dailymotionService.renameLatest())));
  app.get('/api/dailymotion/recording/rename-latest', asyncHandler(async (_req, res) => res.json(await dailymotionService.renameLatest())));
  app.get('/api/test/dailymotion', asyncHandler(async (_req, res) => res.json({ success: true, ...await dailymotionService.testConnection() })));

  registerDual(app, '/api/recording/all/toggle', asyncHandler(async (_req, res) => {
    const local = await recordingController.toggleLocalRecording();
    const settings = settingsService.readSettings();
    const dailymotion = settings.dailymotion?.dailymotionEnabled
      ? await dailymotionService.toggleRecording()
      : { success: true, action: 'skipped', message: 'Dailymotion is disabled.' };
    res.json({
      success: !!local.success && !!dailymotion.success,
      local,
      dailymotion,
      message: local.success && dailymotion.success ? 'Recording toggle completed.' : 'One or more recording systems reported an issue.',
    });
  }));

  registerDual(app, '/api/control/next-skater', (_req, res) => ok(res, stateService.nextSkater()));
  registerDual(app, '/api/control/previous-skater', (_req, res) => ok(res, stateService.previousSkater()));
  registerDual(app, '/api/control/show-start-order', (_req, res) => ok(res, graphics.show('starting-order')));
  registerDual(app, '/api/control/show-results', (_req, res) => ok(res, graphics.show('rankings')));
  registerDual(app, '/api/control/clear-graphics', (_req, res) => {
    const hidden = graphics.templates.map(template => graphics.hide(template));
    ok(res, { hidden });
  });
  registerDual(app, '/api/control/vmix-record-toggle', asyncHandler(async (_req, res) => res.json(await recordingController.toggleLocalRecording())));
  registerDual(app, '/api/control/vmix-record-start', asyncHandler(async (_req, res) => res.json(await recordingController.startLocalRecording())));
  registerDual(app, '/api/control/vmix-record-stop', asyncHandler(async (_req, res) => res.json(await recordingController.stopLocalRecording())));
  registerDual(app, '/api/control/dailymotion-record-toggle', asyncHandler(async (_req, res) => res.json(await dailymotionService.toggleRecording())));
  registerDual(app, '/api/control/all-record-toggle', asyncHandler(async (_req, res) => {
    const local = await recordingController.toggleLocalRecording();
    const settings = settingsService.readSettings();
    const dailymotion = settings.dailymotion?.dailymotionEnabled
      ? await dailymotionService.toggleRecording()
      : { success: true, action: 'skipped', message: 'Dailymotion is disabled.' };
    res.json({ success: !!local.success && !!dailymotion.success, local, dailymotion });
  }));
}

module.exports = { registerProductionRoutes };
