function errorHandler(err, req, res, next) {
  // Map SQLite constraint errors to proper HTTP status codes
  if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).json({ error: 'Referenced record does not exist' });
  }
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return res.status(409).json({ error: 'Record already exists' });
  }
  if (err?.code?.startsWith?.('SQLITE_CONSTRAINT')) {
    return res.status(400).json({ error: err.message || 'Constraint violation' });
  }

  // PR3a / P1-8: recognize `.status` (Express / http-errors convention),
  // `.httpStatus` (the repo-native convention — pmCleanupService,
  // pmSpawnService, conversationService, reconciliationService all set it),
  // and `.statusCode` (fetch / node http errors). Precedence order matters:
  //   1) `.status`     — highest because Express uses it idiomatically
  //   2) `.httpStatus` — the repo convention; Codex R1 flagged that
  //                      statusCode beating httpStatus would mask
  //                      intentional service-level overrides when a caught
  //                      library error already carries statusCode
  //   3) `.statusCode` — last resort for third-party errors
  //   4) 500           — unknown
  const status = err?.status || err?.httpStatus || err?.statusCode || 500;
  const message = err?.message || 'Internal Server Error';
  const payload = { error: message };
  if (err?.details) payload.details = err.details;

  if (status === 500) {
    console.error('[errorHandler]', err);
  }

  res.status(status).json(payload);
}

module.exports = { errorHandler };
