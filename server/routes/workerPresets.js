const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createWorkerPresetsRouter({ presetService }) {
  const router = express.Router();

  // GET /api/worker-presets/plugin-refs — must precede /:id
  router.get('/plugin-refs', asyncHandler(async (req, res) => {
    res.json({ plugin_refs: presetService.listPluginRefs() });
  }));

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ presets: presetService.listPresets() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const preset = presetService.createPreset(req.body || {});
    res.status(201).json({ preset });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ preset: presetService.getPreset(req.params.id) });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const preset = presetService.updatePreset(req.params.id, req.body || {});
    res.json({ preset });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const preset = presetService.deletePreset(req.params.id);
    res.json({ preset });
  }));

  return router;
}

module.exports = { createWorkerPresetsRouter };
