class AppError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class BadRequestError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409);
  }
}

class ForbiddenError extends AppError {
  constructor(message) {
    super(message, 403);
  }
}

function sanitizeMessage(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) {
      text = text.split(secret).join('[redacted]');
    }
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[redacted]@')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

module.exports = {
  AppError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  sanitizeMessage,
};
