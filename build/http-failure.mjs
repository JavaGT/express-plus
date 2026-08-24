import {
  failureFromError,
  failureOutcome,
  isWorkbenchFailure,
  sanitizeUnexpectedFailure,

} from './outcome.mjs';

export function statusForFailure(value                            )                                    {
  const category = isWorkbenchFailure(value) ? value.category : 'internal';
  switch (category) {
    case 'invalid-input': return 400;
    case 'denied': return 403;
    case 'unknown-action':
    case 'not-found': return 404;
    case 'not-acceptable': return 406;
    case 'conflict': return 409;
    default: return 500;
  }
}






export function failureResponse(
  workbenchFailure         ,
  { status }                      = {},
)                  {
  const normalized = isWorkbenchFailure(workbenchFailure)
    ? workbenchFailure
    : sanitizeUnexpectedFailure();
  return Object.freeze({
    status: status ?? statusForFailure(normalized),
    body: failureOutcome(normalized),
  });
}








export function sendFailure(
  sendJson          ,
  res         ,
  workbenchFailure         ,
  { status, headers }                                         = {},
)          {
  const response = failureResponse(workbenchFailure, { status });
  return sendJson(res, response.status, response.body, headers);
}

export function failureForHttpError(error         )                   {
  return failureFromError(error);
}
