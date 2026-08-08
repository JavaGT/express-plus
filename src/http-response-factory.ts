// Shared Express-style response facade — wraps a Node ServerResponse with the
// common methods that serve.mjs (app.use intercept) and http-handler-chain.mjs
// (handler-chain dispatch) both build inline. Each caller adds its own
// route-specific extensions (stream, render) on the returned object.
//
// One response abstraction — no two paths building the same wrapper twice.

import type { ServerResponse } from 'node:http';

import { sendJson } from './http-response.ts';
import { canWriteResponse } from './http-response.ts';

export interface ResponseFacadeOptions {
  onEnd?: () => void;
}

export interface ResponseFacade {
  status(code: number): ResponseFacade;
  json(value: unknown): ResponseFacade;
  send(value?: unknown): ResponseFacade;
  sendStatus(code: number): ResponseFacade;
  readonly headersSent: boolean;
  writeHead(...args: Parameters<ServerResponse['writeHead']>): unknown;
  end(...args: Parameters<ServerResponse['end']>): ResponseFacade;
  setHeader(...args: Parameters<ServerResponse['setHeader']>): unknown;
  raw: ServerResponse;
  readonly _pendingStatus: number;
}

/**
 * Creates an Express-style response facade wrapping a Node.js ServerResponse.
 * All response-ending methods are chainable (return `res`).
 *
 * `onEnd` is called after every response-ending method (json, send, sendStatus,
 * end). serve.mjs uses this to flip its `handled` flag in the `app.use`
 * intercept.
 */
export function createResponseFacade(nodeRes: ServerResponse, { onEnd }: ResponseFacadeOptions = {}): ResponseFacade {
  let pendingStatus = 200;
  let facadeEnded = false;

  function markEnded(): void {
    if (facadeEnded) return;
    facadeEnded = true;
    if (onEnd) onEnd();
  }

  const res = {
    status(code: number) {
      pendingStatus = code;
      return res as ResponseFacade;
    },
    json(value: unknown) {
      const wrote = sendJson(nodeRes, pendingStatus, value, {}, { operation: 'res.json' });
      if (wrote) markEnded();
      return res as ResponseFacade;
    },
    send(value?: unknown) {
      if (!canWriteResponse(nodeRes, 'res.send')) return res as ResponseFacade;
      const payload = typeof value === 'string' ? value : String(value);
      nodeRes.writeHead(pendingStatus, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      nodeRes.end(payload);
      markEnded();
      return res as ResponseFacade;
    },
    sendStatus(code: number) {
      if (!canWriteResponse(nodeRes, 'res.sendStatus')) return res as ResponseFacade;
      nodeRes.writeHead(code);
      nodeRes.end();
      markEnded();
      return res as ResponseFacade;
    },
    get headersSent() {
      return nodeRes.headersSent;
    },
    writeHead(...args: Parameters<ServerResponse['writeHead']>) {
      return (nodeRes.writeHead as (...a: unknown[]) => unknown)(...args);
    },
    end(...args: Parameters<ServerResponse['end']>) {
      (nodeRes.end as (...a: unknown[]) => unknown)(...args);
      markEnded();
      return res as ResponseFacade;
    },
    setHeader(...args: Parameters<ServerResponse['setHeader']>) {
      return (nodeRes.setHeader as (...a: unknown[]) => unknown)(...args);
    },
    raw: nodeRes,
  };
  // Expose the pending status so callers that add custom methods (stream,
  // render) can read the code that was set via res.status(...).
  Object.defineProperty(res, '_pendingStatus', {
    get() { return pendingStatus; },
    enumerable: false,
  });
  return res as ResponseFacade;
}
