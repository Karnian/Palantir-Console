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

  const status = err?.status || 500;
  const message = err?.message || 'Internal Server Error';
  const payload = { error: message };
  if (err?.details) payload.details = err.details;

  if (status === 500) {
    console.error('[errorHandler]', err);
  }

  res.status(status).json(payload);
}

module.exports = { errorHandler };
