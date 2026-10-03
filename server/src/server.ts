import type { AddressInfo } from 'node:net';
import { buildApp } from './app.js';
import { startRealtime } from './websocket/index.js';
import { startBackgroundJobs } from './jobs.js';
import { env } from './config/env.js';
import { registerNotificationTriggers } from './modules/notifications/service.js';

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Composes the HTTP API, the realtime gateway and background jobs onto one
 * listening server. Used by index.ts and the tests.
 */
export async function startServer(opts: { host: string; port: number }): Promise<RunningServer> {
  const app = await buildApp();
  registerNotificationTriggers();
  const realtime = await startRealtime(app.server);
  await app.listen({ host: opts.host, port: opts.port });
  const port = (app.server.address() as AddressInfo).port;
  const jobs = env.JOBS_ENABLED ? startBackgroundJobs() : undefined;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await jobs?.stop();
      await realtime.close();
      await app.close();
    },
  };
}
