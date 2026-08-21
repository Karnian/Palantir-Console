const express = require('express');
const { managerOperationManifest } = require('../services/managerOperationManifest');

const PROJECTED_FIELDS = [
  'id',
  'method',
  'path_template',
  'path_params',
  'query',
  'request_body',
  'constraints',
];

function createAgentContextRouter({ goalFeatureActive, isSpecialistAvailable }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    if (req.auth?.actor !== 'manager') {
      return res.status(403).json({ error: 'manager capability required' });
    }

    const layer = req.auth.layer;
    if (layer !== 'top' && layer !== 'operator') {
      return res.status(403).json({ error: 'manager capability has invalid layer' });
    }
    if (req.query.layer !== undefined && req.query.layer !== layer) {
      return res.status(400).json({ error: 'query layer does not match authenticated layer' });
    }

    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Authorization');

    const goalActive = goalFeatureActive();
    const specialistAvailable = isSpecialistAvailable();
    const operations = managerOperationManifest.operations
      .filter(operation => (
        operation.layers.includes(layer)
        && (
          operation.availability === 'always'
          || (operation.availability === 'goal_mode' && goalActive)
          || (operation.availability === 'specialist_mounted' && specialistAvailable)
        )
      ))
      .map(operation => Object.fromEntries(
        PROJECTED_FIELDS.map(field => [field, operation[field]]),
      ));

    return res.json({ layer, operations });
  });

  return router;
}

module.exports = { createAgentContextRouter };
