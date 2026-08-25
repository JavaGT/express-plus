const DOUBLE_RESPONSE_WARNING_CODE = 'WB_DOUBLE_RESPONSE';











export function responseHasStarted(res                  )          {
  return Boolean(res.headersSent || res.writableEnded || res.destroyed);
}

export function warnLateResponse(
  res                  ,
  operation        ,
  cause                  ,
)       {
  const req = res.req;
  const method = req?.method ?? 'UNKNOWN';
  const url = req?.url ?? 'UNKNOWN_URL';
  const state = [
    `headersSent=${Boolean(res.headersSent)}`,
    `writableEnded=${Boolean(res.writableEnded)}`,
    `destroyed=${Boolean(res.destroyed)}`,
  ].join(', ');
  const causeMessage =
    cause instanceof Error ? `${cause.name}: ${cause.message}`
    : cause ? String(cause)
    : undefined;
  process.emitWarning(
    new Error(
      `Attempted to write response after it had already started in ${operation} ` +
      `for ${method} ${url} (${state})${causeMessage ? ` — cause: ${causeMessage}` : ''}`,
    ),
    { code: DOUBLE_RESPONSE_WARNING_CODE, type: 'DoubleResponseWarning' },
  );
}

export function canWriteResponse(
  res                  ,
  operation        ,
  cause                  ,
)          {
  if (!responseHasStarted(res)) return true;
  warnLateResponse(res, operation, cause);
  return false;
}










export function sendJson(
  res                  ,
  status        ,
  body         ,
  headers                  = {},
  options                  = {},
)          {
  if (!canWriteResponse(res, options.operation ?? 'sendJson', options.cause)) return false;
  // JSON.stringify returns the value `undefined` for an `undefined` body —
  // treat that as an EMPTY response (status only, no payload) instead of
  // letting Buffer.byteLength(undefined) throw mid-request.
  const payload = JSON.stringify(body) ?? '';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
  return true;
}






export function committedEventHeaders(
  result                                                           ,
  actionId        ,
  scope                = null,
)                         {
  const events = Array.isArray(result?.events) ? result.events : [];
  const relevantEvents = scope ? events.filter((event) => event.scope === scope) : events;
  const seq = relevantEvents.reduce(
    (max, event) => Number.isFinite(event.seq) ? Math.max(max, event.seq          ) : max,
    -Infinity,
  );
  return {
    'x-workbench-action-id': actionId,
    ...(Number.isFinite(seq) ? { 'x-workbench-seq': String(seq) } : {}),
  };
}

export function projectedCursorHeaders(
  cursors                                                                  ,
)                         {
  if (!cursors || cursors.length === 0) return {};
  const headers                         = {};
  for (const { field, lastSeq } of cursors) {
    headers[`x-workbench-projected-${field}`] = String(lastSeq);
  }
  return headers;
}
