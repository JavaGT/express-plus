export const FAILURE_CATEGORIES = Object.freeze([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'conflict',
  'internal',
]);

const failureCategories = new Set(FAILURE_CATEGORIES);

export function failure(category, message, details) {
  if (!failureCategories.has(category)) {
    throw new TypeError(`unknown failure category '${category}'`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('failure message must be a non-empty string');
  }

  const result = { category, message };
  if (details !== undefined) {
    result.details = details && typeof details === 'object'
      ? Object.freeze({ ...details })
      : details;
  }
  return Object.freeze(result);
}

export function failureOutcome(workbenchFailure) {
  if (!isWorkbenchFailure(workbenchFailure)) {
    throw new TypeError('failureOutcome requires a WorkbenchFailure');
  }
  return Object.freeze({ ok: false, failure: workbenchFailure });
}

export function isWorkbenchFailure(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && failureCategories.has(value.category)
    && typeof value.message === 'string'
    && value.message.length > 0,
  );
}

export function sanitizeUnexpectedFailure() {
  return failure('internal', 'Internal error.');
}

const categoryByStatus = new Map([
  [400, 'invalid-input'],
  [401, 'denied'],
  [403, 'denied'],
  [404, 'not-found'],
  [409, 'conflict'],
]);

export function failureFromError(error) {
  if (isWorkbenchFailure(error)) return error;
  if (isWorkbenchFailure(error?.failure)) return error.failure;

  const statusCategory = categoryByStatus.get(error?.status);
  if (statusCategory) {
    return failure(statusCategory, String(error?.message || 'Request failed.'));
  }

  if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
    return failure('conflict', 'The requested change conflicts with existing data.');
  }

  return sanitizeUnexpectedFailure(error);
}
