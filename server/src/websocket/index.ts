import type { Server } from 'node:http';
import { env } from '../config/env.js';
import { domainEvents } from '../lib/domainEvents.js';
import { logger } from '../lib/logger.js';
import { JobRunner } from '../lib/jobs.js';
import { attachGateway } from './gateway.js';
import { publish } from './bus.js';
import * as presence from '../modules/presence/service.js';
import { sweep as sweepCalls } from '../modules/calls/service.js';

// Each module registers its own event handlers on import.
import '../modules/messages/realtime.js';
import '../modules/presence/realtime.js';
import '../modules/calls/realtime.js';

/** Starts the realtime layer on an existing HTTP server. */
export async function startRealtime(server: Server) {
  const gateway = attachGateway(server);
  await gateway.ready;

  // A revoked session (logout, token theft) loses its sockets on every instance.
  domainEvents.on('session.revoked', async ({ sessionId }) => {
    await publish({ kind: 'close-session', sessionId });
  });
  domainEvents.onError((err) => logger.error({ err }, 'domain event handler failed'));

  // Presence maintenance is part of the realtime layer, so it always runs.
  const jobs = new JobRunner();
  await presence.reapDeadInstances(); // also registers this instance
  await presence.reconcileStaleOnline();
  jobs.every('presence.offline_due', Math.min(1000, Math.max(100, env.PRESENCE_GRACE_MS / 4)), presence.processOfflineDue);
  jobs.every('presence.instances', 5_000, presence.reapDeadInstances);
  // Call timeouts (ring, setup, lost signaling); deadlines live in Postgres.
  jobs.every('calls.sweep', 1_000, sweepCalls);

  return {
    async close() {
      await gateway.close();
      // Let disconnect hooks schedule grace periods before we stop processing.
      await new Promise((r) => setTimeout(r, 50));
      await jobs.stop();
      await presence.unregisterInstance();
    },
  };
}
