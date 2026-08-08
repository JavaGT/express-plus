// Node HTTP/SSE skin for public LiveDelivery. Applications mount this handler
// directly; it never receives raw log rows or application projection callbacks.

                                                                 

                                                
                                             
                                                                                                        

const JSON_LIMIT = 1024 * 1024;

function requestUrl(req                 )      {
  return new URL(req.url ?? '/', 'http://workbench.local');
}

function reject(res                , status        , message        )       {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function scopeFrom(url     )                {
  const scope = url.searchParams.get('scope');
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > 512) return null;
  return scope;
}

function afterFrom(url     )                      {
  const raw = url.searchParams.get('after');
  if (raw === null) return 0;
  if (/^(0|[1-9][0-9]*)$/.test(raw)) {
    const after = Number(raw);
    return Number.isSafeInteger(after) ? after : null;
  }
  try {
    const cursor = JSON.parse(raw)                                             ;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || !Number.isSafeInteger(cursor.anchor) || (cursor.anchor          ) < 0
      || !Number.isSafeInteger(cursor.aggregate) || (cursor.aggregate          ) < 0
      || Object.keys(cursor).length !== 2) return null;
    return Object.freeze({ anchor: cursor.anchor          , aggregate: cursor.aggregate           });
  } catch {
    return null;
  }
}

// Bootstraps and catch-ups are one-time page-load responses: a document's
// recipient view plus (for unredacted recipients) its family checkpoint seed.
// Those legitimately reach several MB on large documents. Per-keystroke SSE
// frames stay at JSON_LIMIT so folds cannot silently demote to resync.
const BOOTSTRAP_LIMIT = 16 * 1024 * 1024;

function writeJson(res                , value         , maxBytes = JSON_LIMIT)       {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maxBytes) throw new Error('live delivery response exceeds limit');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Bind a public LiveDelivery to conventional Node HTTP routes.
 *
 * `GET {path}/bootstrap?scope=<scope>&mode=snapshot|catchup&after=<cursor>`
 * returns a package-owned recipient snapshot/catch-up result. `GET
 * {path}/events?scope=<scope>&after=<cursor>` is an SSE stream whose data
 * frames are arrays of recipient envelopes. Return false for unrelated routes.
 */
export function createLiveDeliveryHttpHandler({ delivery, principalOf, path = '/live-delivery', maxSubscriptions = 100, log = null }   
                              
                                                                                                         
                
                            
                            
 ) {
  if (!delivery || typeof delivery.bootstrap !== 'function' || typeof delivery.catchup !== 'function' || typeof delivery.subscribe !== 'function') {
    throw new TypeError('delivery must be a LiveDelivery');
  }
  if (typeof principalOf !== 'function') throw new TypeError('principalOf is required');
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('path must be an absolute path');
  if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1) throw new TypeError('maxSubscriptions must be a positive safe integer');

  let subscriptions = 0;

  return async function handleLiveDelivery(req                 , res                )                   {
    const url = requestUrl(req);

    // Authoring ack endpoint
    if (url.pathname === `${path}/authoring/ack`) {
      if (req.method !== 'POST') { reject(res, 405, 'method not allowed'); return true; }
      let body         ;
      try {
        const { readRequestBody } = await import('./http-body.mjs');
        body = await readRequestBody(req                                                    , { jsonOnly: true });
      } catch {
        reject(res, 400, 'invalid body');
        return true;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(res, 400, 'invalid ack request');
        return true;
      }
      const ack = body                           ;
      if (ack.version !== 1 ||
          typeof ack.entity !== 'string' || typeof ack.field !== 'string' || typeof ack.documentId !== 'string' ||
          typeof ack.stream !== 'string' || typeof ack.lease !== 'string' || typeof ack.snapshot !== 'string') {
        reject(res, 400, 'invalid ack request');
        return true;
      }
      let principal           ;
      // Demo-only principal hint (viewAs) is carried in the ack body alongside the
      // document identity; the real sessionPrincipalOf ignores it.
      try { principal = await principalOf(req, { viewAs: ack.viewAs ?? null }); } catch { reject(res, 403, 'access denied'); return true; }
      if (!principal || typeof principal !== 'object') { reject(res, 403, 'access denied'); return true; }
      const documentIdentity = { entity: ack.entity          , field: ack.field          , documentId: ack.documentId           };
      const document = delivery.resolveAnnotatedTextDocument ? delivery.resolveAnnotatedTextDocument(documentIdentity) : null;
      if (!document) { reject(res, 404, 'document not found'); return true; }
      const result = await delivery.acknowledgeAuthoringSnapshot({ document, principal, stream: ack.stream          , lease: ack.lease          , snapshot: ack.snapshot           });
       if (!result) { reject(res, 409, 'acknowledgement rejected'); return true; }
      const { sendJson } = await import('./http-response.mjs');
      sendJson(res, 200, { ok: true, acknowledgedThrough: result.acknowledgedThrough });
      return true;
    }

    if (url.pathname !== `${path}/bootstrap` && url.pathname !== `${path}/events`) return false;
    if (req.method !== 'GET') {
      reject(res, 405, 'method not allowed');
      return true;
    }
    const scope = scopeFrom(url);
    const after = afterFrom(url);
    const documentIdentity = url.searchParams.has('documentId') ? {
      entity: url.searchParams.get('entity'), field: url.searchParams.get('field'), documentId: url.searchParams.get('documentId'),
    } : null;
    const resolvedDocument = documentIdentity ? delivery.resolveAnnotatedTextDocument?.(documentIdentity                                                         ) : null;
    const document                               = resolvedDocument && url.searchParams.has('authoringClient')
      ? { ...resolvedDocument, clientNonce: url.searchParams.get('authoringClient') }
      : resolvedDocument;
    const effectiveScope = document?.scope ?? scope;
    if (!effectiveScope || after === null || (documentIdentity && (!document || (scope !== null && scope !== effectiveScope)))) {
      reject(res, 400, 'invalid live delivery request');
      return true;
    }
    let principal           ;
    try { principal = await principalOf(req); } catch { reject(res, 403, 'access denied'); return true; }
    if (!principal || typeof principal !== 'object') { reject(res, 403, 'access denied'); return true; }

    let releaseStream                      = null;
    try {
      if (url.pathname === `${path}/bootstrap`) {
        const mode = url.searchParams.get('mode');
        if (mode === 'snapshot') {
          // The delivery seam creates the snapshot from its recipient-hydrated row.
          const result = await delivery.bootstrap({ principal, scope: effectiveScope, document });
          writeJson(res, result, BOOTSTRAP_LIMIT);
        } else if (mode === 'catchup') {
          const result = await delivery.catchup({ principal, scope: effectiveScope, after, document });
          // A small event count can still contain a large recipient envelope.
          // Replace oversized replay with the same paired opaque recovery.
          const encoded = JSON.stringify(result);
          writeJson(res, Buffer.byteLength(encoded) > JSON_LIMIT
            ? await delivery.bootstrap({ principal, scope: effectiveScope, document })
            : result, BOOTSTRAP_LIMIT);
        } else {
          reject(res, 400, 'invalid live delivery mode');
        }
        return true;
      }

      // Reserve before any await so concurrent upgrades cannot race the cap.
      if (subscriptions >= maxSubscriptions) { reject(res, 503, 'live delivery capacity reached'); return true; }
      subscriptions += 1;
      const controller = new AbortController();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        subscriptions -= 1;
        controller.abort();
      };
      releaseStream = release;
      // IncomingMessage 'close' also fires after a fully read request body;
      // only the response lifecycle represents an SSE stream cancellation.
      res.once('close', release);
      let revoked = false;
      const activation = await delivery.subscribe({
        principal,
        scope: effectiveScope,
        document,
        after,
        signal: controller.signal,
        revoke: () => { revoked = true; release(); if (res.headersSent && !res.writableEnded) res.end(); },
        deliver: async (envelopes) => {
          if (controller.signal.aborted) throw new Error('live delivery stream closed');
          const payload = JSON.stringify(envelopes);
          const frame = Buffer.byteLength(payload) > JSON_LIMIT
            ? JSON.stringify([{ type: 'resync', seq: (envelopes.at(-1)                                )?.seq ?? after, reason: 'recipient-snapshot-required' }])
            : payload;
          if (!res.write(`data: ${frame}\n\n`)) {
            await new Promise      ((resolve, reject) => {
              const onDrain = () => { res.off('close', onClose); resolve(); };
              const onClose = () => { res.off('drain', onDrain); reject(new Error('live delivery stream closed')); };
              res.once('drain', onDrain);
              res.once('close', onClose);
            });
          }
        },
      });
      // Public delivery reports an admission denial through revoke rather than
      // exposing raw authorization errors. Before streaming starts we can map
      // that terminal outcome to ordinary HTTP authorization semantics.
      if (revoked) {
        release();
        reject(res, 403, 'access denied');
        return true;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      await activation.activate();
      if (revoked && !res.writableEnded) res.end();
      return true;
    } catch (error) {
      log?.error?.('live', 'HTTP live delivery request failed', {
        path: url.pathname,
        mode: url.searchParams.get('mode') ?? null,
        scope: url.searchParams.get('scope') ?? null,
        entity: url.searchParams.get('entity') ?? null,
        field: url.searchParams.get('field') ?? null,
        documentId: url.searchParams.get('documentId') ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      releaseStream?.();
      // Surface the underlying framework error (message only, no stack) so a
      // client's bootstrap failure is diagnosable instead of an opaque 400.
      const denied = (error                                         )?.code === 'live-delivery-revoked';
      const detail = !denied && error instanceof Error && typeof error.message === 'string'
        ? `live delivery unavailable: ${error.message}`
        : 'live delivery unavailable';
      if (url.pathname === `${path}/events`) {
        if (!res.headersSent) reject(res, denied ? 403 : 400, detail);
        else if (!res.writableEnded) res.end();
      } else if (!res.headersSent) {
        reject(res, denied ? 403 : 400, detail);
      }
      return true;
    }
  };
}
