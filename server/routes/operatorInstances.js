'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ForbiddenError } = require('../utils/errors');

function assertHumanSameOrigin(req) {
  if (!req.auth || req.auth.method !== 'cookie') throw new ForbiddenError('cookie auth required');
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try { originHost = new URL(origin).host; } catch { throw new ForbiddenError('cross-origin write blocked'); }
  if (!req.headers.host || originHost.toLowerCase() !== String(req.headers.host).toLowerCase()) {
    throw new ForbiddenError('cross-origin write blocked');
  }
}

function createOperatorInstancesRouter({ operatorInstanceService, operatorIdentityLifecycleService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ instances: operatorInstanceService.listInstances() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    assertHumanSameOrigin(req);
    const instance = operatorInstanceService.createInstance(req.body || {});
    res.status(201).json({ instance });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ instance: operatorInstanceService.getInstance(req.params.id) });
  }));

  router.post('/:id/refs', asyncHandler(async (req, res) => {
    const instance = operatorInstanceService.addRef(req.params.id, req.body || {});
    const ref = instance.refs.find((item) => item.project_id === req.body?.project_id) || null;
    res.status(201).json({ instance, ref });
  }));

  router.delete('/:id/refs/:projectId', asyncHandler(async (req, res) => {
    const instance = operatorInstanceService.removeRef(req.params.id, req.params.projectId);
    res.json({ instance });
  }));

  router.patch('/:id/profile', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'profile assignment requires human (cookie) auth' });
    }
    const profileId = (req.body || {}).profile_id;
    if (typeof profileId !== 'string') {
      return res.status(400).json({ error: 'profile_id must be a string' });
    }
    const instance = await operatorIdentityLifecycleService.assignProfile(req.params.id, profileId);
    res.json({ instance });
  }));

  router.delete('/:id/profile', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'profile assignment requires human (cookie) auth' });
    }
    const instance = await operatorIdentityLifecycleService.unassignProfile(req.params.id);
    res.json({ instance });
  }));

  // F-1: PATCH the Codex Fast Mode toggle. Cookie(human)-only — fast mode is a
  // cost decision (2.5× credits) so an Operator must not self-promote its own
  // tier (mirrors the R4 active-write actor split, routes/memory.js). Caveat:
  // in a PALANTIR_PM_TOKEN-undivided deployment req.auth.method is an actor
  // hint, not a hard security boundary — this blocks accidental cost abuse, not
  // a determined spoof.
  router.patch('/:id/fast-mode', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'fast-mode toggle requires human (cookie) auth' });
    }
    const raw = (req.body || {}).fast_mode;
    if (raw !== 0 && raw !== 1 && raw !== null) {
      return res.status(400).json({ error: 'fast_mode must be 0, 1, or null' });
    }
    const instance = operatorInstanceService.setFastMode(req.params.id, raw);
    res.json({ instance });
  }));

  return router;
}

module.exports = { createOperatorInstancesRouter };
