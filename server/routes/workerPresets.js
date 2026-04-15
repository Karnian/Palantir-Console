const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createWorkerPresetsRouter({ presetService }) {
  const router = express.Router();

  // GET /api/worker-presets/plugin-refs — must precede /:id
  // Returns { plugin_refs: [...], warnings: [{dir, reason}] }.
  // Directories with malformed/non-object plugin.json are excluded from
  // plugin_refs and reported in warnings.
  router.get('/plugin-refs', asyncHandler(async (req, res) => {
    const { plugin_refs, warnings } = presetService.listPluginRefs();
    res.json({ plugin_refs, warnings });
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
