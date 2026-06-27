// config.mjs — environment-driven defaults. Override via env vars or edit here.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',

  session: {
    scheme: 'cookie',
    ttl: process.env.SESSION_TTL ?? '30d',
    secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me', // required in prod
    secure: process.env.NODE_ENV === 'production', // HTTPS-only cookies in prod
    httpOnly: true,
    sameSite: 'lax',
  },

  static: { directory: 'public', maxAge: process.env.STATIC_MAX_AGE ?? '1h' },
  views: { directory: 'views', engine: 'html' }, // html = plain static passthrough by default

  rateLimit: { window: '1m', max: Number(process.env.RATE_LIMIT_MAX ?? 120), key: 'req.ip' },
  body: { json: { limit: '1mb' }, urlencoded: { extended: true, limit: '1mb' } },

  trustProxy: process.env.TRUST_PROXY === 'true', // set true behind a reverse proxy
  cors: { origin: process.env.CORS_ORIGIN ?? false }, // false = same-origin default
  compression: true,
  requestLogging: true,
};
