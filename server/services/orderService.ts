import { randomUUID } from 'crypto';
import {
  store,
  type Order,
  type Gig,
  type User,
  type Dispute,
  type AuditLog,
  type Message
} from '../store.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import { financialTransactionService, financialRepository } from './financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { emitSystemEvent, recordMessage, registerMessage, messageIndex } from './messagingService.js';
import { createNotification, sendOrderEmail } from './notificationService.js';
import { recalculateUserRating } from './reviewService.js';
import { broadcastMessage } from '../websocket.js';
import { diagnosticService } from './diagnosticService.js';

export interface ClearingEarning {
  orderId: string;
  sellerId: string;
  amount: number;
  clearsAt: string;
}
export const clearingEarnings: ClearingEarning[] = [];

export function getUnclearedEarnings(userId: string): number {
  const now = Date.now();
  return clearingEarnings
    .filter(e => e.sellerId === userId && new Date(e.clearsAt).getTime() > now)
    .reduce((sum, e) => sum + e.amount, 0);
}

export async function getActiveEscrowRemaining(order: Order): Promise<number> {
  const esc = await financialRepository.getEscrow(order.id);
  if (esc) return esc.remaining;
  return (order.status === 'completed' || order.status === 'cancelled') ? 0 : Number(order.amount || 0);
}

export async function hasCommittedFinancialState(orderId: string, client?: any): Promise<boolean> {
  const pool = client || postgresStore.getPool();
  try {
    const escRes = await pool.query(
      "SELECT order_id FROM escrows WHERE order_id = $1 AND (status IN ('held', 'released', 'refunded', 'disputed', 'split') OR remaining > 0 OR released_gross > 0 OR refunded_total > 0)",
      [orderId]
    );
    if (escRes.rows.length > 0) return true;

    const ledRes = await pool.query(
      "SELECT id FROM ledger_entries WHERE order_id = $1 LIMIT 1",
      [orderId]
    );
    if (ledRes.rows.length > 0) return true;

    const ordRes = await pool.query(
      "SELECT id FROM orders WHERE id = $1 AND status IN ('funded_in_escrow', 'in_progress', 'delivered', 'completed', 'disputed', 'cancelled')",
      [orderId]
    );
    if (ordRes.rows.length > 0) return true;
  } catch (e) {
    console.warn('[hasCommittedFinancialState] Error checking financial state:', e);
  }
  return false;
}

export const orderIndex = new Map<string, Order>();

export const orderStateLocks = new Set<string>();

export function acquireOrderLock(orderId: string) {
  if (orderStateLocks.has(orderId)) {
    throw new Error('Action rejected: This order is currently being processed by another operation. Please retry in a moment.');
  }
  orderStateLocks.add(orderId);
}

export function tryAcquireOrderLock(orderId: string, res: any): boolean {
  try {
    acquireOrderLock(orderId);
    return true;
  } catch (err: any) {
    diagnosticService.log('security', 'orderService', 'tryAcquireOrderLock', 'server/services/orderService.ts', 'concurrency_lock', 'INTERCEPTED', { orderId }, err.message);
    res.status(409).json({ error: err.message });
    return false;
  }
}

export function releaseOrderLock(orderId: string) {
  orderStateLocks.delete(orderId);
}

export function registerOrder(o: Order) {
  if (!o.id) return;
  orderIndex.set(o.id, o);
}

export function recordOrder(o: Order) {
  workspaceService.ensureWorkspaceForOrder(o);
  registerOrder(o);
  store.saveOrder(o).catch(err => console.error('[orderService] Error saving order:', err));
}

export function registerAuditLog(log: AuditLog) {
  postgresStore.getPool().query(
    `INSERT INTO audit_logs (id, actor, role, action, target, details, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       actor = EXCLUDED.actor,
       role = EXCLUDED.role,
       action = EXCLUDED.action,
       target = EXCLUDED.target,
       details = EXCLUDED.details,
       timestamp = EXCLUDED.timestamp`,
    [log.id, log.actor, log.role, log.action, log.target, log.details || null, log.timestamp]
  ).catch(err => console.error('[PostgresStore] Failed to save audit log:', err));
}

export function saveOrdersToDisk() { return Promise.resolve(); }
export function saveUsersToPostgres() { return Promise.resolve(); }
export function saveGigsToPostgres() { return Promise.resolve(); }

export async function syncUserBalances() {
  try {
    await postgresStore.getPool().query(`
      UPDATE users u
      SET wallet_balance = w.available_balance
      FROM wallets w
      WHERE u.id = w.user_id
    `);
  } catch (err) {
    console.error('[syncUserBalances] Error syncing balances:', err);
  }
}

export async function ensureWallet(userId: string) {
  try {
    await financialTransactionService.ensureWallet(userId);
  } catch (err) {
    console.error(`[ensureWallet] Failed for user ${userId}:`, err);
  }
}

export function syncIndexes() {
  orderIndex.clear();
  messageIndex.clear();
  clearingEarnings.length = 0;
}

export async function resolveGigOrderPrice(gigId: string, extraIds: unknown): Promise<{ gig: any; gigPrice: number; extrasTitles: string[] }> {
  const res = await postgresStore.getPool().query('SELECT * FROM gigs WHERE id = $1', [gigId]);
  if (res.rows.length === 0) {
    const err: any = new Error('Gig not found.');
    err.status = 404;
    throw err;
  }
  const r = res.rows[0];
  const basePrice = Number(r.price || 0);
  const extras = Array.isArray(r.extras) ? r.extras : [];
  const requestedIds = Array.isArray(extraIds) ? extraIds.map(String) : [];
  let extrasTotal = 0;
  const extrasTitles: string[] = [];
  for (const ex of extras) {
    if (ex && requestedIds.includes(String(ex.id))) {
      extrasTotal += Number(ex.price || 0);
      if (ex.title) extrasTitles.push(String(ex.title));
    }
  }
  const gigPrice = Math.round((basePrice + extrasTotal) * 100) / 100;
  return {
    gig: {
      id: r.id,
      title: r.title,
      price: basePrice,
      freelancerId: r.freelancer_id,
      deliveryDays: Number(r.delivery_days || 7),
      extras
    },
    gigPrice,
    extrasTitles
  };
}

export function getReviewWindowStart(order: any, delivery: any): number {
  const deliveredAt = new Date(delivery?.deliveredAt).getTime();
  const restartedAt = order?.reviewWindowRestartedAt ? new Date(order.reviewWindowRestartedAt).getTime() : NaN;
  if (!isNaN(restartedAt) && (isNaN(deliveredAt) || restartedAt > deliveredAt)) return restartedAt;
  return deliveredAt;
}

export function getReviewWindowDays(): number {
  if (process.env.REVIEW_WINDOW_DAYS !== undefined) {
    const parsed = Number(process.env.REVIEW_WINDOW_DAYS);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  const settings = siteSettings.getSettings();
  if (typeof settings.marketplace?.autoCompleteDeliveredDays === 'number') {
    return settings.marketplace.autoCompleteDeliveredDays;
  }
  return 3;
}

export function isAutoAcceptEnabled(): boolean {
  if (process.env.AUTO_ACCEPT_ENABLED !== undefined) {
    const v = process.env.AUTO_ACCEPT_ENABLED.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  }
  const settings = siteSettings.getSettings();
  if (settings.marketplace?.autoCompleteDeliveredEnabled === false) return false;
  return getReviewWindowDays() > 0;
}

export const releaseCompletedOrders = new Set<string>();
export const refundCompletedOrders = new Set<string>();
export const requestKeyCache = new Map<string, any>();

export function assertOrderOpen(order: Order) {
  if (order.status === 'completed') throw new Error('Order is already completed; funds were already released.');
  if (order.status === 'cancelled') throw new Error('Order is already cancelled; funds were already handled.');
}

export async function fundOrderEscrowWithEvent(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; skipMinimum?: boolean }) {
  return await financialTransactionService.fundEscrow(params);
}

export async function topUpOrderEscrowWithEvent(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; skipMinimum?: boolean }) {
  const res = await financialTransactionService.topUpEscrow(params);
  emitSystemEvent(params.orderId, 'escrow_funded', `🔒 Additional $${params.amount.toLocaleString()} funded into escrow for "${params.orderTitle}".`, { amount: params.amount, isTopUp: true });
  return res;
}

export async function releaseOrderFunds(order: Order, actor: string, reason: string, approvedByBuyer: boolean, requestKey?: string) {
  if (requestKey && requestKeyCache.has(requestKey)) {
    return requestKeyCache.get(requestKey);
  }
  const idempotencyKey = requestKey || `IDEMP-REL-${order.id}`;
  if (order.status === 'completed') {
    if (isPostgresEnabled()) {
      const pool = postgresStore.getPool();
      const idempRes = await pool.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempotencyKey]);
      if (idempRes.rows.length > 0 && idempRes.rows[0].result) {
        const replayed = idempRes.rows[0].result;
        if (requestKey) requestKeyCache.set(requestKey, replayed);
        return replayed;
      }
    }
    throw new Error('Order is already completed; funds were already released.');
  }
  assertOrderOpen(order);
  await store.saveOrder(order);
  const result = await financialTransactionService.releaseOrderFunds({ orderId: order.id, actor, reason, idempotencyKey: requestKey });

  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date().toISOString();
  }
  if (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) {
    order.acceptedVersion = order.deliveryHistory[order.deliveryHistory.length - 1].version;
  }

  const pool = postgresStore.getPool();
  const updateRes = await pool.query(
    "UPDATE orders SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1 AND status <> 'completed' RETURNING *",
    [order.id]
  );
  if (updateRes.rows.length > 0) {
    await pool.query(
      'UPDATE users SET earned = COALESCE(earned, 0) + $1, completed_jobs = COALESCE(completed_jobs, 0) + 1 WHERE id = $2',
      [result.freelancerNet, order.sellerId]
    );
  }
  releaseCompletedOrders.add(order.id);
  await syncUserBalances();
  await store.saveOrder(order);

  if (approvedByBuyer) {
    emitSystemEvent(order.id, 'deliverable_approved', `✅ Deliverables approved by buyer.`, {
      freelancerNet: result.freelancerNet,
      acceptedVersion: order.acceptedVersion
    });
  }

  emitSystemEvent(order.id, 'escrow_released', `🎉 Escrow funds ($${order.amount.toLocaleString()}) released to seller! Workstream marked as completed.`, {
    amount: order.amount,
    freelancerNet: result.freelancerNet,
    platformFee: result.platformFee,
    orderCompleted: true
  });

  emitSystemEvent(order.id, 'order_completed', `✅ Order completed.`);

  if (requestKey) requestKeyCache.set(requestKey, result);
  return result;
}

export async function refundOrderFunds(order: Order, amount: number | undefined, actor: string, reason: string, requestKey?: string) {
  if (requestKey && requestKeyCache.has(requestKey)) {
    return requestKeyCache.get(requestKey);
  }

  const result = await financialTransactionService.refundOrderFunds({
    orderId: order.id,
    amount,
    reason,
    actor,
    idempotencyKey: requestKey
  });

  if (result.remaining === 0) {
    order.status = 'cancelled';
    refundCompletedOrders.add(order.id);
  }

  const refId = 'ref_' + randomUUID().slice(0, 12);
  const pool = postgresStore.getPool();
  await pool.query(
    `INSERT INTO refunds (id, order_id, buyer_id, amount, reason, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6)
     ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, status = EXCLUDED.status`,
    [refId, order.id, order.buyerId, result.refunded, reason, new Date().toISOString().substring(0, 10)]
  );

  await syncUserBalances();
  await store.saveOrder(order);

  emitSystemEvent(order.id, 'escrow_refunded', `💸 Escrow refunded ($${result.refunded.toLocaleString()}) to buyer wallet. Reason: ${reason}`, {
    refunded: result.refunded,
    orderCancelled: order.status === 'cancelled'
  });

  if (requestKey) requestKeyCache.set(requestKey, result);
  return result;
}

export async function splitOrderFunds(order: Order, refundAmount: number, actor: string, reason: string, requestKey?: string) {
  if (requestKey && requestKeyCache.has(requestKey)) {
    return requestKeyCache.get(requestKey);
  }
  assertOrderOpen(order);
  const result = await financialTransactionService.resolveEscrowSplit({ orderId: order.id, refundAmount, reason, actor });
  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date().toISOString();
  }

  const pool = postgresStore.getPool();
  const updateRes = await pool.query(
    "UPDATE orders SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1 AND status <> 'completed' RETURNING *",
    [order.id]
  );
  if (updateRes.rows.length > 0) {
    await pool.query(
      'UPDATE users SET earned = COALESCE(earned, 0) + $1, completed_jobs = COALESCE(completed_jobs, 0) + 1 WHERE id = $2',
      [result.release.freelancerNet, order.sellerId]
    );
  }
  releaseCompletedOrders.add(order.id);

  const refId = 'ref_' + randomUUID().slice(0, 12);
  const pool = postgresStore.getPool();
  await pool.query(
    `INSERT INTO refunds (id, order_id, buyer_id, amount, reason, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6)
     ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, status = EXCLUDED.status`,
    [refId, order.id, order.buyerId, refundAmount, reason, new Date().toISOString().substring(0, 10)]
  );

  await syncUserBalances();
  await store.saveOrder(order);

  emitSystemEvent(order.id, 'escrow_refunded', `💸 Partial refund of $${refundAmount.toLocaleString()} returned to buyer wallet. Reason: ${reason}`, {
    refunded: refundAmount,
    splitResolution: true
  });
  emitSystemEvent(order.id, 'escrow_released', `🎉 Remaining escrow funds ($${result.release.freelancerNet.toLocaleString()}) released to seller. Workstream marked as completed.`, {
    freelancerNet: result.release.freelancerNet,
    platformFee: result.release.platformFee,
    orderCompleted: true,
    splitResolution: true
  });
  emitSystemEvent(order.id, 'order_completed', `✅ Order completed via dispute resolution.`);

  if (requestKey) requestKeyCache.set(requestKey, result);
  return result;
}

export function validateOrderReleasePreconditions(order: Order, isAdmin = false, isInvoiceApproval = false): { status: number; error: string } | null {
  if (order.status === 'completed') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Order is already completed');
    return { status: 400, error: 'Order is already completed and payment has already been released.' };
  }
  if (order.status === 'cancelled') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Order is cancelled; funds already refunded');
    return { status: 400, error: 'Order is cancelled; funds have been returned to the buyer.' };
  }
  if (!isAdmin && (order.status as string) === 'disputed') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Cannot release payment while dispute is open');
    return { status: 400, error: 'Cannot release payment while an active dispute is open. The dispute must be resolved first.' };
  }
  if (!isAdmin && !isInvoiceApproval && order.status !== 'delivered') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Payment release attempted before work was delivered');
    return { status: 400, error: 'Payment can only be released after the freelancer has submitted deliverables.' };
  }
  if (!isAdmin && !isInvoiceApproval && Array.isArray(order.revisions)) {
    const activeRev = order.revisions.some(r => r.status === 'requested');
    if (activeRev) {
      diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, revisions: order.revisions }, 'Payment release attempted while revision is pending');
      return { status: 400, error: 'Cannot release payment while a revision is in progress. The freelancer must deliver the revised work first.' };
    }
  }
  return null;
}

export function enrichOrderWithServiceInfo(o: Order, isAdmin: boolean = false) {
  const resolvedType = o.orderType || (o as any).type || (o.projectId ? 'project' : 'gig');
  const base = {
    ...o,
    orderType: resolvedType,
    type: resolvedType,
    gigOrderId: o.gigOrderId || (resolvedType === 'gig' ? o.id : undefined),
    projectOrderId: o.projectOrderId || (resolvedType === 'project' ? o.id : undefined),
    sellerName: (o as any).sellerName || o.sellerUsername || 'Seller',
    sellerAvatar: (o as any).sellerAvatar || '',
    buyerName: (o as any).buyerName || o.buyerUsername || 'Buyer',
    buyerAvatar: (o as any).buyerAvatar || ''
  };
  if (!isAdmin) {
    const { adminInternalNotes, adminHistory, ...sanitized } = base as any;
    return sanitized;
  }
  return base;
}

export async function processCancellationTimeouts() {
  const now = Date.now();
  const pool = postgresStore.getPool();
  try {
    const res = await pool.query(
      "SELECT id FROM orders WHERE status NOT IN ('completed', 'cancelled') AND cancellation_request IS NOT NULL"
    );
    for (const r of res.rows) {
      const order = await store.getOrder(r.id);
      if (!order || !order.cancellationRequest || order.cancellationRequest.status !== 'pending') continue;
      const respondByTime = new Date(order.cancellationRequest.respondBy).getTime();

      if (now > respondByTime) {
        if (orderStateLocks.has(order.id)) continue;
        try {
          acquireOrderLock(order.id);
        } catch {
          continue;
        }
        try {
          const requestKey = `cancel_timeout_${order.id}_${order.cancellationRequest.requestedAt}`;
          const refundRes = await refundOrderFunds(order, undefined, 'System Auto-Cancel', 'Cancellation request auto-cancelled after 48h timeout', requestKey);
          order.cancellationRequest.status = 'auto_cancelled';
          await store.saveOrder(order);

          const requesterId = order.cancellationRequest.requesterId;
          const otherId = requesterId === order.buyerId ? order.sellerId : order.buyerId;
          createNotification({
            userId: requesterId,
            title: 'Cancellation Auto-Cancelled',
            message: `Order #${order.id} cancellation request timed out after 48h. Order cancelled & full refund issued ($${refundRes.refunded}).`,
            type: 'order',
            link: `/messages/${order.id}`
          });
          createNotification({
            userId: otherId,
            title: 'Cancellation Auto-Cancelled',
            message: `Order #${order.id} cancellation request timed out after 48h. Order cancelled & full refund issued ($${refundRes.refunded}).`,
            type: 'order',
            link: `/messages/${order.id}`
          });
        } catch (err) {
          console.error(`[CancellationTimeout] Failed to auto-cancel order ${order.id}:`, err);
        } finally {
          releaseOrderLock(order.id);
        }
      }
    }
  } catch (err) {
    console.error('[processCancellationTimeouts] Query error:', err);
  }
}

export async function processAutoAcceptOrders(customNow?: number): Promise<Array<{
  orderId: string;
  acceptedVersion: number;
  amount: number;
  freelancerNet: number;
}>> {
  if (!isAutoAcceptEnabled()) {
    return [];
  }

  const now = typeof customNow === 'number' ? customNow : Date.now();
  const processed: Array<{ orderId: string; acceptedVersion: number; amount: number; freelancerNet: number }> = [];
  const pool = postgresStore.getPool();

  try {
    const ordersRes = await pool.query("SELECT id FROM orders WHERE status = 'delivered'");
    const deliveredIds = new Set<string>(ordersRes.rows.map(r => r.id));
    for (const [id, o] of orderIndex.entries()) {
      if (o.status === 'delivered') deliveredIds.add(id);
    }
    const { orders: legacyOrders } = await import('../../server.ts').catch(() => ({ orders: [] }));
    if (Array.isArray(legacyOrders)) {
      for (const o of legacyOrders) {
        if (o?.id && o.status === 'delivered') deliveredIds.add(o.id);
      }
    }

    for (const orderId of deliveredIds) {
      let order = await store.getOrder(orderId);
      if (!order) {
        throw new Error(`Data Integrity Error: Order ${orderId} not found in PostgreSQL`);
      }
      if (!order) continue;

      const days = order.orderType === 'project' ? 7 : getReviewWindowDays();
      const windowMs = days * 24 * 60 * 60 * 1000;

      if (!Array.isArray(order.deliveryHistory) || order.deliveryHistory.length === 0) continue;
      const latestDelivery = order.deliveryHistory[order.deliveryHistory.length - 1];
      if (!latestDelivery || !latestDelivery.deliveredAt) continue;

      const deliveredAt = getReviewWindowStart(order, latestDelivery);
      if (isNaN(deliveredAt)) continue;
      if (now - deliveredAt < windowMs) continue;

      if (Array.isArray(order.revisions)) {
        const hasActiveRequestedRevision = order.revisions.some(rev => rev.status === 'requested');
        if (hasActiveRequestedRevision) continue;
      }

      const disputeRes = await pool.query(
        "SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('open', 'under_investigation') LIMIT 1",
        [order.id]
      );
      if (disputeRes.rows.length > 0) continue;

      const esc = await financialRepository.getEscrow(order.id);
      if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
        continue;
      }

      if (orderStateLocks.has(order.id)) continue;
      try {
        acquireOrderLock(order.id);
      } catch {
        continue;
      }

      const requestKey = `auto_accept_${order.id}_v${latestDelivery.version}`;
      try {
        const result = await releaseOrderFunds(order, 'System Auto-Accept', `Auto-accept after buyer review window (${days} days) elapsed`, false, requestKey);
        order.acceptedVersion = latestDelivery.version;
        await store.saveOrder(order);

        const sysMsg: Message = {
          id: 'msg_' + now + '_' + Math.random().toString(36).slice(2, 6),
          orderId: order.id,
          senderId: 'system',
          senderName: 'WorkPerHour System',
          text: `🎉 Deliverables automatically accepted: Buyer review window (${days} days) closed without revisions or dispute. Escrow funds released to seller.`,
          timestamp: new Date(now).toISOString(),
          type: 'system',
          metadata: {
            action: 'order_auto_accepted',
            acceptedVersion: latestDelivery.version,
            reviewWindowDays: days
          }
        };
        recordMessage(sysMsg);
        await store.addMessage(sysMsg);
        broadcastMessage(sysMsg, order.id);

        processed.push({
          orderId: order.id,
          acceptedVersion: latestDelivery.version,
          amount: order.amount,
          freelancerNet: result.freelancerNet
        });
      } catch (err: any) {
        console.error(`[ReviewWindow] Failed to auto-accept order ${order.id}:`, err);
      } finally {
        releaseOrderLock(order.id);
      }
    }
  } catch (err) {
    console.error('[processAutoAcceptOrders] Query error:', err);
  }

  return processed;
}

export async function atomicUpdateOrder(orderId: string, updates: Record<string, any>, allowedStatuses: string[]): Promise<boolean> {
  const pool = postgresStore.getPool();
  const keys = Object.keys(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map(k => updates[k]);
  
  const query = `
    UPDATE orders 
    SET ${setClause}
    WHERE id = $1 AND status = ANY($${keys.length + 2})
  `;
  const res = await pool.query(query, [orderId, ...values, allowedStatuses]);
  return res.rowCount !== null && res.rowCount > 0;
}
