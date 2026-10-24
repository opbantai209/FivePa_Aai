import { disputes, type Dispute } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { emitSystemEvent } from './messagingService.js';

export function closeActiveDispute(orderId: string, status: Dispute['status'], notes: string) {
  const d = disputes.find(x => x.orderId === orderId && (x.status === 'open' || x.status === 'under_investigation'));
  if (d) {
    d.status = status;
    d.resolutionNotes = notes;
    postgresStore.saveDisputes(disputes);
    emitSystemEvent(orderId, 'dispute_resolved', `✅ Dispute resolved: ${status.replace('_', ' ')}. Note: ${notes}`);
  }
}
