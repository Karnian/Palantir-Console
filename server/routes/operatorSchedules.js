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

function createOperatorSchedulesRouter({ operatorScheduleService, operatorScheduler }) {
  const router = express.Router();

  router.get('/operator-instances/:instanceId/schedules', asyncHandler(async (req, res) => {
    res.json({ schedules: operatorScheduleService.listSchedules(req.params.instanceId) });
  }));

  router.post('/operator-instances/:instanceId/schedules', asyncHandler(async (req, res) => {
    assertHumanSameOrigin(req);
    const schedule = operatorScheduleService.createSchedule(req.params.instanceId, req.body || {});
    res.status(201).json({ schedule });
  }));

  router.get('/operator-schedules/:id', asyncHandler(async (req, res) => {
    res.json({ schedule: operatorScheduleService.getSchedule(req.params.id) });
  }));

  router.patch('/operator-schedules/:id', asyncHandler(async (req, res) => {
    assertHumanSameOrigin(req);
    const schedule = operatorScheduleService.updateSchedule(req.params.id, req.body || {});
    res.json({ schedule });
  }));

  router.delete('/operator-schedules/:id', asyncHandler(async (req, res) => {
    assertHumanSameOrigin(req);
    const schedule = operatorScheduleService.archiveSchedule(req.params.id);
    res.json({ schedule });
  }));

  router.post('/operator-schedules/:id/run-now', asyncHandler(async (req, res) => {
    assertHumanSameOrigin(req);
    const invocation = operatorScheduleService.runNow(req.params.id);
    if (operatorScheduler && typeof operatorScheduler.tick === 'function') operatorScheduler.tick();
    res.status(202).json({ invocation });
  }));

  router.get('/operator-schedules/:id/invocations', asyncHandler(async (req, res) => {
    const invocations = operatorScheduleService.listInvocations(req.params.id, req.query.limit);
    res.json({ invocations });
  }));

  return router;
}

module.exports = { createOperatorSchedulesRouter, assertHumanSameOrigin };
