import { type Dispute } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { emitSystemEvent } from './messagingService.js';

export async function closeActiveDispute(orderId: string, status: Dispute['status'], notes: string): Promise<void> {
  const pool = postgresStore.getPool();
  try {
    const res = await pool.query(
      "SELECT id FROM disputes WHERE order_id = $1 AND (status = 'open' OR status = 'under_investigation')",
      [orderId]
    );
    if (res.rows.length > 0) {
      for (const row of res.rows) {
        await pool.query(
          "UPDATE disputes SET status = $1, resolution_notes = $2 WHERE id = $3",
          [status, notes, row.id]
        );
      }
      emitSystemEvent(orderId, 'dispute_resolved', `✅ Dispute resolved: ${status.replace('_', ' ')}. Note: ${notes}`);
    }
  } catch (err) {
    console.error(`[disputeService] Error closing dispute for order ${orderId}:`, err);
  }
}
