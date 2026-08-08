// @ts-nocheck
import { resolve } from 'node:path';

import { config } from './config.mjs';
import { getLog } from './log.mjs';
import { renderError } from './middleware.mjs';
import { authorizeRow } from './http-crud-dispatch.mjs';
import { resolveTemplate } from './views.mjs';
import { createResponseFacade } from './http-response-factory.mjs';

export async function runChain(handlers, nodeReq, nodeRes, { principal, params, body, query, autoLoad, app }, { env }) {
  const req = {
    body,
    params,
    query: Object.fromEntries(query),
    principal,
    raw: nodeReq,
    headers: nodeReq.headers,
    method: nodeReq.method,
    url: nodeReq.url,
  };

  if (autoLoad) {
    const auth = await authorizeRow(app, autoLoad.entity, 'read', params[autoLoad.param], principal);
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    const dispatchRef = app?.kernel
      ? (args) => app.writeQueue.run(() => app.kernel.dispatch(args))
      : null;
    req[autoLoad.key] = autoLoad.entity.hydrate(auth.row, principal, dispatchRef);
  }

  const res = createResponseFacade(nodeRes, {});

  // chain-specific: template rendering via the views engine.
  res.render = function (name, data = {}) {
    try {
      const html = resolveTemplate(app?.config?.viewsDir ?? config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(this._pendingStatus, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
        });
      }
      nodeRes.end(html);
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      renderError(nodeRes, { status, message: err.code === 'ENOENT' ? `template not found: ${name}` : err.message }, { env });
    }
    return this;
  };

  // chain-specific: streaming with SSE defaults, buffering toggle, destroyed
  // guard, and cancellation on error.
  res.stream = async function (webResponse, { buffering = true } = {}) {
    const isResponse = typeof webResponse?.body?.getReader === 'function'
      || (webResponse && typeof webResponse.body === 'object');
    const body = webResponse?.body ?? webResponse;
    const headers = isResponse && webResponse.headers
      ? Object.fromEntries(webResponse.headers.entries())
      : {};
    if (!('content-type' in headers) && !isResponse) {
      headers['content-type'] = 'text/event-stream; charset=utf-8';
    }
    if (buffering) headers['x-accel-buffering'] = 'no';
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(
        isResponse && Number.isFinite(webResponse.status) ? webResponse.status : this._pendingStatus,
        headers,
      );
    }
    if (!body || typeof body.getReader !== 'function') {
      nodeRes.end();
      return this;
    }
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (nodeRes.destroyed) break;
        nodeRes.write(Buffer.isBuffer(value) ? value : Buffer.from(value));
      }
      if (!nodeRes.writableEnded) nodeRes.end();
    } catch (err) {
      getLog().warn('system', 'res.stream pump failed', { err });
      if (!nodeRes.destroyed) nodeRes.destroy(err);
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return this;
  };

  for (const handler of handlers) {
    let advance = false;
    let errored = false;
    const next = (err) => {
      if (err) {
        errored = true;
        renderError(nodeRes, err, { env });
      } else {
        advance = true;
      }
    };
    await handler(req, res, next);
    if (errored) return;
    if (!advance) return;
  }
}
