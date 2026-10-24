import { financialTransactionService } from '../services/financialService.js';
import { processCancellationTimeouts, processAutoAcceptOrders } from '../services/orderService.js';
import { cleanupAbandonedWorkstreamUploads } from '../services/workstreamService.js';

export async function runBackgroundJobs() {
  console.log('[BackgroundJobs] Starting financial and marketplace background jobs...');

  // 1. Earnings Clearing Job (Every 5 minutes)
  setInterval(async () => {
    try {
      const clearableIds = await financialTransactionService.getClearableEarnings();
      if (clearableIds.length > 0) {
        console.log(`[BackgroundJobs] Found ${clearableIds.length} earnings to clear.`);
        for (const id of clearableIds) {
          await financialTransactionService.processEarningsClearing({ clearingId: id, actor: 'system:background_job' });
        }
      }
    } catch (err) {
      console.error('[BackgroundJobs] Error in earnings clearing job:', err);
    }
  }, 5 * 60 * 1000);

  // 2. Cancellation Timeouts Job (Every 60 seconds)
  setInterval(async () => {
    try {
      await processCancellationTimeouts();
    } catch (err) {
      console.error('[BackgroundJobs] Error in cancellation timeouts job:', err);
    }
  }, 60 * 1000);

  // 3. Buyer Review Window & Auto-Accept Job (Every 60 seconds)
  setInterval(async () => {
    try {
      await processAutoAcceptOrders();
    } catch (err) {
      console.error('[BackgroundJobs] Error in auto-accept job:', err);
    }
  }, 60 * 1000);

  // 4. Cleanup Abandoned Workstream Uploads Job (Every hour)
  setInterval(() => {
    try {
      cleanupAbandonedWorkstreamUploads();
    } catch (err) {
      console.error('[BackgroundJobs] Error in abandoned uploads cleanup job:', err);
    }
  }, 3600_000).unref?.();
}
