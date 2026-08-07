import {
  failureFromError,
  failureOutcome,
  isWorkbenchFailure,
  sanitizeUnexpectedFailure,
  type WorkbenchFailure,
} from './outcome.ts';

export function statusForFailure(value: WorkbenchFailure | unknown): 400 | 403 | 404 | 409 | 500 {
  const category = isWorkbenchFailure(value) ? value.category : 'internal';
  switch (category) {
    case 'invalid-input': return 400;
    case 'denied': return 403;
    case 'unknown-action':
    case 'not-found': return 404;
    case 'conflict': return 409;
    default: return 500;
  }
}

export interface FailureResponse {
  readonly status: number;
  readonly body: ReturnType<typeof failureOutcome>;
}

export function failureResponse(
  workbenchFailure: unknown,
  { status }: { status?: number } = {},
): FailureResponse {
  const normalized = isWorkbenchFailure(workbenchFailure)
    ? workbenchFailure
    : sanitizeUnexpectedFailure();
  return Object.freeze({
    status: status ?? statusForFailure(normalized),
    body: failureOutcome(normalized),
  });
}

export type SendJson = (
  res: unknown,
  status: number,
  body: unknown,
  headers?: unknown,
) => unknown;

export function sendFailure(
  sendJson: SendJson,
  res: unknown,
  workbenchFailure: unknown,
  { status, headers }: { status?: number; headers?: unknown } = {},
): unknown {
  const response = failureResponse(workbenchFailure, { status });
  return sendJson(res, response.status, response.body, headers);
}

export function failureForHttpError(error: unknown): WorkbenchFailure {
  return failureFromError(error);
}
