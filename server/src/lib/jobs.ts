import { logger } from './logger.js';

/**
 * Tiny interval scheduler. A tick never overlaps the previous one, and errors
 * are logged rather than crashing the process. Jobs must be safe to run on
 * every instance at once (they claim work atomically in Redis/Postgres).
 */
export class JobRunner {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<Promise<unknown>>();

  every(name: string, ms: number, fn: () => Promise<unknown>) {
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      const p = fn()
        .catch((err) => logger.error({ err, job: name }, 'job failed'))
        .finally(() => {
          busy = false;
          this.running.delete(p);
        });
      this.running.add(p);
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.running]);
  }
}
