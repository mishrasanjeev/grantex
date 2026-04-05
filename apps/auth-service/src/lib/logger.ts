import pino from 'pino';

/**
 * Minimal logger interface compatible with both pino.Logger and
 * Fastify's FastifyBaseLogger, so the same type can be used in
 * workers, startup code, and route-handler-adjacent code.
 */
export interface AppLogger {
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  debug(obj: unknown, msg?: string, ...args: unknown[]): void;
  fatal(obj: unknown, msg?: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): AppLogger;
}

/**
 * Standalone pino logger for use outside of Fastify route handlers.
 *
 * Route handlers should use `request.log` (Fastify attaches a child logger
 * with the request-id already set). This logger is for startup code, background
 * workers, and other non-request-scoped contexts.
 *
 * In production the output is newline-delimited JSON.
 * In development, if `pino-pretty` is installed, human-readable output is used.
 */
export const logger: AppLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
});
