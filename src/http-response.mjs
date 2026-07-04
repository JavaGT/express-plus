export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function committedEventHeaders(result, actionId, scope = null) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const relevantEvents = scope ? events.filter((event) => event.scope === scope) : events;
  const seq = relevantEvents.reduce(
    (max, event) => Number.isFinite(event.seq) ? Math.max(max, event.seq) : max,
    -Infinity,
  );
  return {
    'x-workbench-action-id': actionId,
    ...(Number.isFinite(seq) ? { 'x-workbench-seq': String(seq) } : {}),
  };
}

export function projectedCursorHeaders(cursors) {
  if (!cursors || cursors.length === 0) return {};
  const headers = {};
  for (const { field, lastSeq } of cursors) {
    headers[`x-workbench-projected-${field}`] = String(lastSeq);
  }
  return headers;
}
