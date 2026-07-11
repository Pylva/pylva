// Structured logging via Pino — Decision D12.
// Replaces console.* in backend code. SDK packages continue to use
// console.warn('[pylva]', ...) — no Pino in SDK bundle (bundle-size budget).
//
// Usage:
//   import { logger } from './logger.js';
//   const log = logger.child({ module: 'ingest' });
//   log.info({ builder_id, accepted, rejected }, 'ingest completed');
//
// Banned log payload keys (ESLint-enforced): apiKey, api_key, authorization,
// messages, content, prompt, completion, tool_arguments.
// Pino's redact config also scrubs known-sensitive paths at runtime.

import pino from 'pino';
import { env } from './config.js';

const isDev = env.NODE_ENV === 'development';
const usePrettyTransport = isDev && process.env['PINO_PRETTY'] === '1';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'pylva',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'apiKey',
      'api_key',
      'authorization',
      'Authorization',
      'headers.authorization',
      'headers.Authorization',
      'headers["x-pylva-key"]',
      'headers["X-Pylva-Key"]',
      'body.apiKey',
      'body.api_key',
    ],
    censor: '[REDACTED]',
  },
  // Pino's pretty transport runs in a worker thread. In the Next.js server
  // bundle that worker can be resolved under .next/vendor-chunks and crash
  // request handlers after logging. Keep it opt-in for local CLI debugging.
  transport: usePrettyTransport
    ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
    : undefined,
});

export type Logger = typeof logger;
