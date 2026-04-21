// MCP server template CRUD route (M3). Mounted at /api/mcp-server-templates.
// All writes hit the mcpTemplateService; errorHandler maps AppError subclasses
// (BadRequestError 400 / NotFoundError 404 / ConflictError 409) and passes
// `err.details` through for DELETE 409 responses so the UI can list the
// blocking references.
//
// The legacy GET /api/skill-packs/templates stays in place for skill-pack
// view compatibility; this router is the canonical MCP template CRUD
// endpoint going forward.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createMcpTemplatesRouter({ mcpTemplateService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ templates: mcpTemplateService.listTemplates() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const template = mcpTemplateService.createTemplate(req.body || {});
    res.status(201).json({ template });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ template: mcpTemplateService.getTemplate(req.params.id) });
  }));

  // GET /:id/references — operators can inspect who uses a template before
  // attempting DELETE. Returns the same shape DELETE 409 emits so the UI
  // can prefetch and stay consistent.
  router.get('/:id/references', asyncHandler(async (req, res) => {
    const existing = mcpTemplateService.getTemplate(req.params.id);
    const refs = mcpTemplateService.findReferences(existing.id, existing.alias);
    res.json({ references: refs });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const template = mcpTemplateService.updateTemplate(req.params.id, req.body || {});
    res.json({ template });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    mcpTemplateService.deleteTemplate(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = { createMcpTemplatesRouter };
