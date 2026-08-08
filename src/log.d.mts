export function getLog(): {
  warn(channel: string, msg: string, ctx?: Record<string, unknown>): void;
  info(channel: string, msg: string, ctx?: Record<string, unknown>): void;
  error(channel: string, msg: string, ctx?: Record<string, unknown>): void;
  debug(channel: string, msg: string, ctx?: Record<string, unknown>): void;
};
export function setLog(...args: unknown[]): void;
