// Shared Express-style response facade — wraps a Node ServerResponse with the
// common methods that serve.mjs (app.use intercept) and http-handler-chain.mjs
// (handler-chain dispatch) both build inline. Each caller adds its own
// route-specific extensions (stream, render) on the returned object.
//
// One response abstraction — no two paths building the same wrapper twice.



import { sendJson } from './http-response.mjs';
import { canWriteResponse } from './http-response.mjs';


















/**
 * Creates an Express-style response facade wrapping a Node.js ServerResponse.
 * All response-ending methods are chainable (return `res`).
 *
 * `onEnd` is called after every response-ending method (json, send, sendStatus,
 * end). serve.mjs uses this to flip its `handled` flag in the `app.use`
 * intercept.
 */
export function createResponseFacade(nodeRes                , { onEnd }                        = {})                 {
  let pendingStatus = 200;
  let facadeEnded = false;

  function markEnded()       {
    if (facadeEnded) return;
    facadeEnded = true;
    if (onEnd) onEnd();
  }

  const res = {
    status(code        ) {
      pendingStatus = code;
      return res                  ;
    },
    json(value         ) {
      const wrote = sendJson(nodeRes, pendingStatus, value, {}, { operation: 'res.json' });
      if (wrote) markEnded();
      return res                  ;
    },
    send(value          ) {
      if (!canWriteResponse(nodeRes, 'res.send')) return res                  ;
      const payload = typeof value === 'string' ? value : String(value);
      nodeRes.writeHead(pendingStatus, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      nodeRes.end(payload);
      markEnded();
      return res                  ;
    },
    sendStatus(code        ) {
      if (!canWriteResponse(nodeRes, 'res.sendStatus')) return res                  ;
      nodeRes.writeHead(code);
      nodeRes.end();
      markEnded();
      return res                  ;
    },
    get headersSent() {
      return nodeRes.headersSent;
    },
    writeHead(...args                                         ) {
      return (nodeRes.writeHead                                )(...args);
    },
    end(...args                                   ) {
      (nodeRes.end                                )(...args);
      markEnded();
      return res                  ;
    },
    setHeader(...args                                         ) {
      return (nodeRes.setHeader                                )(...args);
    },
    raw: nodeRes,
  };
  // Expose the pending status so callers that add custom methods (stream,
  // render) can read the code that was set via res.status(...).
  Object.defineProperty(res, '_pendingStatus', {
    get() { return pendingStatus; },
    enumerable: false,
  });
  return res                  ;
}
