// errors.mjs — the catch-all handlers, mounted last.
import expressPlus from 'express-plus';
import { config } from './config.mjs';

// 404 for anything that fell through the router stack.
export const notFound = (req, res) => {
  res.status(404).format({
    json: () => res.json({ error: 'not found', path: req.path }),
    html: () => res.render('404', { path: req.path }),
    default: () => res.type('text').send('not found'),
  });
};

// The four-arg error handler from the Express 5 docs. Stack traces only in dev.
export const errorHandler = (err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const body = { error: err.message ?? 'internal error' };
  if (err.code) body.code = err.code;
  if (!config.isProd) body.stack = err.stack;
  res.status(status).json(body);
};

// Process-level guards so a stray unhandled rejection doesn't kill the server.
export function trapProcess(server) {
  const shutdown = (signal) => {
    console.log(`${signal} received, closing...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
    shutdown('uncaughtException');
  });
}
