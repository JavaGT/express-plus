import { resolve } from 'node:path';

import { config } from './config.mjs';
import { getLog } from './log.mjs';
import { renderError } from './middleware.mjs';
import { sendJson } from './http-response.mjs';
import { resolveTemplate } from './views.mjs';

export async function runChain(handlers, nodeReq, nodeRes, { principal, params, body, query, autoLoad, app, authorizeRead }, { env }) {
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
    const auth = await authorizeRead(app, autoLoad.entity, params[autoLoad.param], principal);
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    const dispatchRef = app?.kernel
      ? (args) => app.writeQueue.run(() => app.kernel.dispatch(args))
      : null;
    req[autoLoad.key] = autoLoad.entity.hydrate(auth.row, principal, dispatchRef);
  }

  let pendingStatus = 200;
  const res = {
    status(code) {
      pendingStatus = code;
      return res;
    },
    json(value) {
      sendJson(nodeRes, pendingStatus, value);
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
      return res;
    },
    sendStatus(code) {
      nodeRes.writeHead(code);
      nodeRes.end();
      return res;
    },
    render(name, data = {}) {
      try {
        const html = resolveTemplate(config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(pendingStatus, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(html),
          });
        }
        nodeRes.end(html);
      } catch (err) {
        const status = err.code === 'ENOENT' ? 404 : 500;
        renderError(nodeRes, { status, message: err.code === 'ENOENT' ? `template not found: ${name}` : err.message }, { env });
      }
      return res;
    },
    async stream(webResponse, { buffering = true } = {}) {
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
        nodeRes.writeHead(isResponse && Number.isFinite(webResponse.status) ? webResponse.status : pendingStatus, headers);
      }
      if (!body || typeof body.getReader !== 'function') {
        nodeRes.end();
        return res;
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
      return res;
    },
    raw: nodeRes,
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
