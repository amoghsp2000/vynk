import { JobRunner } from './lib/jobs.js';
import { purgeExpired } from './modules/status/service.js';
import { cleanupPendingUploads } from './modules/media/service.js';
import { dispatchDue } from './modules/notifications/service.js';

/**
 * Housekeeping jobs. Each claims work atomically, so running them on every
 * instance is safe; set JOBS_ENABLED=false on instances that should skip them.
 */
export function startBackgroundJobs() {
  const jobs = new JobRunner();
  jobs.every('notifications.dispatch', 2_000, dispatchDue);
  jobs.every('status.purge_expired', 5 * 60_000, purgeExpired);
  jobs.every('media.cleanup_pending', 10 * 60_000, () => cleanupPendingUploads(60));
  return jobs;
}
