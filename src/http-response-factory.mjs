// Shared Express-style response facade — wraps a Node ServerResponse with the
// common methods that serve.mjs (app.use intercept) and http-handler-chain.mjs
// (handler-chain dispatch) both build inline. Each caller adds its own
// route-specific extensions (stream, render) on the returned object.
//
// One response abstraction — no two paths building the same wrapper twice.

import { sendJson } from './http-response.mjs';

/**
 * Creates an Express-style response facade wrapping a Node.js ServerResponse.
 * All response-ending methods are chainable (return `res`).
 *
 * @param {import('node:http').ServerResponse} nodeRes - The raw Node response.
 * @param {object} [opts]
 * @param {function} [opts.onEnd] - Called after every response-ending method
 *   (json, send, sendStatus, end). serve.mjs uses this to flip its `handled`
 *   flag in the `app.use` intercept.
 * @returns {object} The response facade (extendable by caller).
 */
export function createResponseFacade(nodeRes, { onEnd } = {}) {
  let pendingStatus = 200;
  const res = {
    status(code) {
      pendingStatus = code;
      return res;
    },
    json(value) {
      sendJson(nodeRes, pendingStatus, value);
      if (onEnd) onEnd();
      return res;
    },
    send(value) {
      const payload = typeof value === 'string' ? value : String(value);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(pendingStatus, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
      }
      nodeRes.end(payload);
      if (onEnd) onEnd();
      return res;
    },
    sendStatus(code) {
      nodeRes.writeHead(code);
      nodeRes.end();
      if (onEnd) onEnd();
      return res;
    },
    get headersSent() {
      return nodeRes.headersSent;
    },
    writeHead(...args) {
      return nodeRes.writeHead(...args);
    },
    end(...args) {
      const r = nodeRes.end(...args);
      if (onEnd) onEnd();
      return r;
    },
    setHeader(...args) {
      return nodeRes.setHeader(...args);
    },
    raw: nodeRes,
  };
  // Expose the pending status so callers that add custom methods (stream,
  // render) can read the code that was set via res.status(...).
  Object.defineProperty(res, '_pendingStatus', {
    get() { return pendingStatus; },
    enumerable: false,
  });
  return res;
}
