import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config.js');
    const runtime = await import('./instrumentation.node.js');
    await runtime.bootstrapNodeRuntime();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config.js');
  }
}

export const onRequestError = Sentry.captureRequestError;
