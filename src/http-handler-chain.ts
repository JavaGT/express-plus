import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config.ts';
import { getLog } from './log.ts';
import { renderError } from './middleware.ts';
import { authorizeRow, type CrudAppLike, type CrudEntity } from './http-crud-dispatch.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { resolveTemplate } from './views.ts';
import { createResponseFacade, type ResponseFacade } from './http-response-factory.ts';
import type { Principal } from './principal.ts';
import type { AutoLoad, RouteHandler } from './router.ts';

interface ChainApp extends CrudAppLike {
  config?: { viewsDir?: string | null };
  _authorization?: AuthorizationAdapter | null;
}

interface ChainRequest {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  principal: Principal;
  raw: IncomingMessage;
  headers: IncomingMessage['headers'];
  method: string | undefined;
  url: string | undefined;
  [key: string]: unknown;
}

interface StreamSource {
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
  headers?: { entries(): Iterable<[string, string]> };
  status?: number;
}

interface ChainResponse extends ResponseFacade {
  render(name: string, data?: Record<string, unknown>): ChainResponse;
  stream(webResponse: unknown, options?: { buffering?: boolean }): Promise<ChainResponse>;
}

export interface RunChainOptions {
  principal: Principal;
  params: Record<string, string>;
  body: unknown;
  query: URLSearchParams;
  autoLoad?: AutoLoad;
  app?: CrudAppLike | null;
  authorization?: AuthorizationAdapter | null;
}

export interface RunChainEnv {
  env: string;
}

export async function runChain(
  handlers: readonly RouteHandler[],
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  { principal, params, body, query, autoLoad, app, authorization }: RunChainOptions,
  { env }: RunChainEnv,
): Promise<void> {
  const req: ChainRequest = {
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
    const auth = await authorizeRow(app as CrudAppLike, autoLoad.entity as unknown as CrudEntity, 'read', params[autoLoad.param], principal, null, { authorization: authorization ?? (app as ChainApp | null | undefined)?._authorization ?? undefined });
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    const dispatchRef = app?.kernel
      ? (args: unknown) => app!.writeQueue!.run(() => app!.kernel!.dispatch(args))
      : null;
    req[autoLoad.key] = (autoLoad.entity as unknown as { hydrate(row: unknown, principal: Principal, dispatch: unknown): unknown })
      .hydrate(auth.row, principal, dispatchRef);
  }

  const res: ChainResponse = createResponseFacade(nodeRes, {}) as ChainResponse;

  // chain-specific: template rendering via the views engine.
  res.render = function (this: ChainResponse, name: string, data: Record<string, unknown> = {}) {
    try {
      const html = resolveTemplate((app as ChainApp | null | undefined)?.config?.viewsDir ?? config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(this._pendingStatus, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
        });
      }
      nodeRes.end(html);
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      const status = e.code === 'ENOENT' ? 404 : 500;
      renderError(nodeRes, { status, message: e.code === 'ENOENT' ? `template not found: ${name}` : e.message }, { env });
    }
    return this;
  };

  // chain-specific: streaming with SSE defaults, buffering toggle, destroyed
  // guard, and cancellation on error.
  res.stream = async function (this: ChainResponse, webResponse: unknown, { buffering = true }: { buffering?: boolean } = {}) {
    const source = webResponse as StreamSource | null | undefined;
    const isResponse = typeof source?.body?.getReader === 'function'
      || (webResponse && typeof source?.body === 'object');
    const body = source?.body ?? webResponse;
    const headers: Record<string, string> = isResponse && source?.headers
      ? Object.fromEntries(source.headers.entries())
      : {};
    if (!('content-type' in headers) && !isResponse) {
      headers['content-type'] = 'text/event-stream; charset=utf-8';
    }
    if (buffering) headers['x-accel-buffering'] = 'no';
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(
        isResponse && Number.isFinite(source?.status as number) ? (source?.status as number) : this._pendingStatus,
        headers,
      );
    }
    const streamBody = body as StreamSource['body'] | null | undefined;
    if (!streamBody || typeof streamBody.getReader !== 'function') {
      nodeRes.end();
      return this;
    }
    const reader = streamBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (nodeRes.destroyed) break;
        nodeRes.write(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
      }
      if (!nodeRes.writableEnded) nodeRes.end();
    } catch (err) {
      getLog().warn('system', 'res.stream pump failed', { err });
      if (!nodeRes.destroyed) nodeRes.destroy(err as Error);
    } finally {
      try { await reader.cancel(); } catch { /* reader already released */ }
    }
    return this;
  };

  for (const handler of handlers) {
    let advance = false;
    let errored = false;
    const next = (err?: unknown) => {
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
