export type ErrorCodeEntry = {
  readonly code: string;
  readonly status: number;
  readonly message: string;
};

export const ERROR_CODES = Object.freeze({
  'auth.denied.grant':       Object.freeze({ code: 'auth.denied.grant',       status: 403, message: 'Principal lacks required grant.' }),
  'auth.denied.route':       Object.freeze({ code: 'auth.denied.route',       status: 403, message: 'Principal lacks route access.' }),
  'subscribe.rejected.grant': Object.freeze({ code: 'subscribe.rejected.grant', status: 403, message: 'Subscribe rejected due to grant.' }),
  'subscribe.rejected.scope': Object.freeze({ code: 'subscribe.rejected.scope', status: 403, message: 'Subscribe rejected due to scope.' }),
  'projection.failed':       Object.freeze({ code: 'projection.failed',       status: 500, message: 'Projection failed.' }),
  'projection.unauthorized': Object.freeze({ code: 'projection.unauthorized',  status: 403, message: 'Projection unauthorized.' }),
  'history.forbidden':       Object.freeze({ code: 'history.forbidden',       status: 403, message: 'History access denied.' }),
  'history.erased':          Object.freeze({ code: 'history.erased',          status: 410, message: 'History erased or expired.' }),
  'authoring-stream-unavailable': Object.freeze({ code: 'authoring-stream-unavailable', status: 409, message: 'Authoring stream is unavailable.' }),
  'authoring-lease-unavailable':  Object.freeze({ code: 'authoring-lease-unavailable',  status: 409, message: 'Authoring lease is unavailable.' }),
  'position-token-unavailable':   Object.freeze({ code: 'position-token-unavailable',   status: 409, message: 'Position token is unavailable.' }),
  'position-no-longer-visible':   Object.freeze({ code: 'position-no-longer-visible',   status: 409, message: 'Position is no longer visible.' }),
  'position-invalid':            Object.freeze({ code: 'position-invalid',            status: 400, message: 'Position is invalid.' }),
  'authoring-stream-capacity':   Object.freeze({ code: 'authoring-stream-capacity',   status: 409, message: 'Authoring stream capacity exceeded.' }),
} as const);

type ErrorCodeKey = keyof typeof ERROR_CODES;

export function errorCode(code: ErrorCodeKey | string): ErrorCodeEntry {
  const entry = (ERROR_CODES as Readonly<Record<string, ErrorCodeEntry>>)[code];
  if (!entry) throw new TypeError(`unknown error code '${code}'`);
  return entry;
}
