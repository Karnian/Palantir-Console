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
    const { layer } = req.query;
    if (layer !== 'top' && layer !== 'operator') {
      return res.status(400).json({ error: 'layer must be top or operator' });
    }

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
