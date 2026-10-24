import { randomUUID } from 'crypto';
import {
  orders,
  users,
  gigs,
  disputes,
  refunds,
  messages,
  auditLogs,
  workstreamOffers,
  type Order,
  type Gig,
  type User,
  type Dispute,
  type AuditLog,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { financeLedger } from '../../src/server/financeLedger.js';
import { financialTransactionService } from './financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { emitSystemEvent, recordMessage, registerMessage, messageIndex } from './messagingService.js';
import { createNotification, sendOrderEmail } from './notificationService.js';
import { recalculateUserRating } from './reviewService.js';

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

export function getActiveEscrowRemaining(order: Order): number {
  const esc = financeLedger.getEscrow(order.id);
  if (esc) return esc.remaining;
  return (order.status === 'completed' || order.status === 'cancelled') ? 0 : Number(order.amount || 0);
}

export const orderIndex = new Map<string, Order>();
const _origOrderIndexGet = orderIndex.get.bind(orderIndex);
orderIndex.get = function(id: string) {
  let val = _origOrderIndexGet(id);
  if (!val && id) {
    val = orders.find(o => o.id === id);
    if (val) orderIndex.set(id, val);
  }
  return val;
};

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
  orders.unshift(o);
  registerOrder(o);
}

const MAX_AUDIT_LOGS = 2000;
export function registerAuditLog(log: AuditLog) {
  auditLogs.unshift(log);
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.length = MAX_AUDIT_LOGS;
  }
  postgresStore.saveAuditLogs(auditLogs).catch(err => console.error('[PostgresStore] Failed to save audit logs:', err));
}

export function saveOrdersToDisk() {
  postgresStore.saveOrders(orders).catch(err => console.error('[PostgresStore] Failed to save orders:', err));
}

export function saveUsersToPostgres() {
  postgresStore.saveUsers(users).catch(err => console.error('[PostgresStore] Failed to save users:', err));
}

export function saveGigsToPostgres() {
  postgresStore.saveGigs(gigs).catch(err => console.error('[PostgresStore] Failed to save gigs:', err));
}

export function syncUserBalances() {
  for (const u of users) {
    const b = financeLedger.getWalletBalance(u.id);
    if (b !== null) u.walletBalance = b;
  }
}

export function ensureWallet(userId: string) {
  const u = users.find(x => x.id === userId);
  const name = u?.name || `User ${userId}`;
  const email = u?.email || `${userId}@example.com`;
  const isFreelancer = (u && (gigs.some(g => g.freelancerId === u.id) || orders.some(o => o.sellerId === u.id) || u.role === 'freelancer' || u.role === 'seller')) || false;
  const role = isFreelancer ? 'freelancer' : 'buyer';
  financeLedger.ensureWallet({ userId: u?.id || userId, name, email, role });
}

export function syncIndexes() {
  orderIndex.clear();
  messageIndex.clear();
  clearingEarnings.length = 0;
  for (const o of orders) {
    registerOrder(o);
    if (Array.isArray((o as any).clearingEarnings)) {
      for (const ce of (o as any).clearingEarnings) {
        if (!clearingEarnings.some(e => e.orderId === ce.orderId)) {
          clearingEarnings.push(ce);
        }
      }
    }
  }
  for (const m of messages) {
    registerMessage(m);
  }
  for (const u of users) {
    recalculateUserRating(u.id);
  }
}

export function resolveGigOrderPrice(gigId: string, extraIds: unknown): { gig: Gig; gigPrice: number; extrasTitles: string[] } {
  const gig = gigs.find(g => g.id === gigId);
  if (!gig) throw Object.assign(new Error('Gig not found.'), { status: 404 });
  if (gig.status && gig.status !== 'published') throw Object.assign(new Error('This gig is not available for ordering.'), { status: 400 });
  const ids = Array.isArray(extraIds) ? Array.from(new Set(extraIds.map(String))) : [];
  let cents = Math.round(Number(gig.price) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw Object.assign(new Error('This gig has no valid price.'), { status: 400 });
  const extrasTitles: string[] = [];
  for (const id of ids) {
    const extra = (gig.extras || []).find(e => e.id === id);
    if (!extra) throw Object.assign(new Error(`Unknown add-on "${id}" for this gig.`), { status: 400 });
    cents += Math.round(Number(extra.price) * 100);
    extrasTitles.push(extra.title);
  }
  return { gig, gigPrice: cents / 100, extrasTitles };
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
  const order = orderIndex.get(params.orderId) || orders.find(o => o.id === params.orderId);
  if (order) {
    emitSystemEvent(order.id, 'escrow_funded', `🔒 Additional $${params.amount.toLocaleString()} funded into escrow for "${params.orderTitle}".`, { amount: params.amount, isTopUp: true });
  }
  return res;
}

export async function releaseOrderFunds(order: Order, actor: string, reason: string, approvedByBuyer: boolean, requestKey?: string) {
  if (requestKey && requestKeyCache.has(requestKey)) {
    return requestKeyCache.get(requestKey);
  }
  if (order.status === 'completed') {
    const replayed = financeLedger.replay<{ journal: any; freelancerNet: number; platformFee: number }>(requestKey);
    if (replayed) {
      if (requestKey) requestKeyCache.set(requestKey, replayed);
      return replayed;
    }
    throw new Error('Order is already completed; funds were already released.');
  }
  assertOrderOpen(order);
  const result = await financialTransactionService.releaseOrderFunds({ orderId: order.id, actor, reason });
  const resultData = result.result;
  const { freelancerNet, platformFee } = resultData;

  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date().toISOString();
  }
  if (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) {
    order.acceptedVersion = order.deliveryHistory[order.deliveryHistory.length - 1].version;
  }

  const seller = users.find(u => u.id === order.sellerId);
  if (seller && !releaseCompletedOrders.has(order.id)) {
    releaseCompletedOrders.add(order.id);
    seller.earned = (seller.earned || 0) + result.freelancerNet;
    seller.completedJobs = (seller.completedJobs || 0) + 1;
    if (order.orderType === 'gig' || order.gigOrderId) {
      const entry = {
        orderId: order.id,
        sellerId: order.sellerId,
        amount: result.freelancerNet,
        clearsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      };
      clearingEarnings.push(entry);
      (order as any).clearingEarnings = [...((order as any).clearingEarnings || []), entry];
    }
  }
  syncUserBalances();
  postgresStore.saveOrders(orders);

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

  const existingRecord = refunds.find(r => r.orderId === order.id && (r.status === 'pending' || r.amount === result.refunded));
  if (existingRecord) {
    existingRecord.status = 'approved';
    existingRecord.amount = result.refunded;
  } else {
    refunds.push({
      id: 'ref_' + randomUUID().slice(0, 12),
      orderId: order.id,
      buyerId: order.buyerId,
      amount: result.refunded,
      reason,
      status: 'approved',
      createdAt: new Date().toISOString().substring(0, 10)
    });
  }
  syncUserBalances();
  postgresStore.saveOrders(orders);
  postgresStore.saveRefunds(refunds);

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
  const seller = users.find(u => u.id === order.sellerId);
  if (seller && !releaseCompletedOrders.has(order.id)) {
    releaseCompletedOrders.add(order.id);
    seller.earned = (seller.earned || 0) + result.release.freelancerNet;
    seller.completedJobs = (seller.completedJobs || 0) + 1;
  }
  const existingRecord = refunds.find(r => r.orderId === order.id && (r.status === 'pending' || r.amount === refundAmount));
  if (existingRecord) {
    existingRecord.status = 'approved';
    existingRecord.amount = refundAmount;
  } else {
    refunds.push({
      id: 'ref_' + randomUUID().slice(0, 12),
      orderId: order.id,
      buyerId: order.buyerId,
      amount: refundAmount,
      reason,
      status: 'approved',
      createdAt: new Date().toISOString().substring(0, 10)
    });
  }
  syncUserBalances();
  postgresStore.saveOrders(orders);
  postgresStore.saveRefunds(refunds);

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
    return { status: 400, error: 'Order is already completed and payment has already been released.' };
  }
  if (order.status === 'cancelled') {
    return { status: 400, error: 'Order is cancelled; funds have been returned to the buyer.' };
  }
  if (!isAdmin && (order.status as string) === 'disputed') {
    return { status: 400, error: 'Cannot release payment while an active dispute is open. The dispute must be resolved first.' };
  }
  if (!isAdmin && !isInvoiceApproval && order.status !== 'delivered') {
    return { status: 400, error: 'Payment can only be released after the freelancer has submitted deliverables.' };
  }
  if (!isAdmin && !isInvoiceApproval && Array.isArray(order.revisions)) {
    const activeRev = order.revisions.some(r => r.status === 'requested');
    if (activeRev) {
      return { status: 400, error: 'Cannot release payment while a revision is in progress. The freelancer must deliver the revised work first.' };
    }
  }
  return null;
}

export function enrichOrderWithServiceInfo(o: Order, isAdmin: boolean = false) {
  const seller = users.find(u => u.id === o.sellerId);
  const buyer = users.find(u => u.id === o.buyerId);
  const base = {
    ...o,
    sellerName: seller?.name || 'Seller',
    sellerAvatar: seller?.avatar,
    buyerName: buyer?.name || 'Buyer',
    buyerAvatar: buyer?.avatar
  };
  if (!isAdmin) {
    const { adminInternalNotes, adminHistory, ...sanitized } = base as any;
    return sanitized;
  }
  return base;
}

export async function processCancellationTimeouts() {
  const now = Date.now();
  for (const order of orders) {
    if (!order.cancellationRequest || order.cancellationRequest.status !== 'pending') continue;
    if (order.orderType !== 'gig' && !order.gigOrderId) continue;
    const respondByTime = new Date(order.cancellationRequest.respondBy).getTime();

    // Reminder about 12 hours before the 48h deadline (sent once)
    const requestedAtMs = new Date(order.cancellationRequest.requestedAt).getTime();
    if (!order.cancellationRequest.reminderSentAt && now - requestedAtMs >= 36 * 60 * 60 * 1000 && now <= respondByTime) {
      order.cancellationRequest.reminderSentAt = new Date().toISOString();
      postgresStore.saveOrders(orders);
      const responderId = order.cancellationRequest.requesterId === order.buyerId ? order.sellerId : order.buyerId;
      createNotification({
        userId: responderId,
        title: 'Cancellation request expires soon',
        message: `Order #${order.id}: about 12 hours left to respond before it is cancelled automatically.`,
        type: 'order',
        link: `/messages/${order.id}`,
        dedupKey: `cancel_reminder_${order.id}_${order.cancellationRequest.requestedAt}`
      });
      sendOrderEmail(
        responderId,
        'Reminder: cancellation request expires in about 12 hours',
        `A cancellation request on order #${order.id} is still waiting for your answer. If you do not accept or decline within about 12 hours, the order is cancelled automatically and the payment is refunded.`,
        `/messages/${order.id}`
      );
    }

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
        postgresStore.saveOrders(orders);

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

        sendOrderEmail(
          otherId,
          'Order cancelled automatically',
          `Order #${order.id} was cancelled because the cancellation request was not answered within 48 hours. The payment was refunded to the buyer.`,
          `/messages/${order.id}`
        );

        registerAuditLog({
          id: 'log_' + Date.now(),
          actor: 'System Auto-Cancel',
          role: 'super_admin',
          action: 'GIG_CANCELLATION_AUTO_CANCELLED',
          target: `Order #${order.id}`,
          details: `48h response deadline elapsed. Auto-cancelled order and refunded $${refundRes.refunded}.`,
          timestamp: new Date().toLocaleString()
        });
      } catch (err) {
        console.error(`[CancellationTimeout] Failed to auto-cancel order ${order.id}:`, err);
      } finally {
        releaseOrderLock(order.id);
      }
    }
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

  for (const order of orders) {
    const days = order.orderType === 'project' ? 7 : getReviewWindowDays();
    const windowMs = days * 24 * 60 * 60 * 1000;

    if (order.status !== 'delivered') continue;
    if (order.cancellationRequest?.status === 'pending') continue;

    if (!Array.isArray(order.deliveryHistory) || order.deliveryHistory.length === 0) continue;

    const latestDelivery = order.deliveryHistory[order.deliveryHistory.length - 1];
    if (!latestDelivery || !latestDelivery.deliveredAt) continue;

    const deliveredAt = getReviewWindowStart(order, latestDelivery);
    if (isNaN(deliveredAt)) continue;

    if (order.orderType === 'project' && !order.deadlineApproachingNotified) {
      const remainingTime = (deliveredAt + windowMs) - now;
      if (remainingTime > 0 && remainingTime <= 24 * 60 * 60 * 1000) {
        order.deadlineApproachingNotified = true;
        postgresStore.saveOrders(orders).catch(err => console.error(err));
        createNotification({
          userId: order.buyerId,
          type: 'deadline_approaching',
          title: 'Review Window Closing Soon',
          message: `You have less than 24 hours to review deliverable for project "${order.title}". It will be automatically approved thereafter.`,
          link: `/workstream/${order.id}`,
          dedupKey: `proj_deliv_warn_${order.id}_v${latestDelivery.version}`
        });
      }
    }

    if (now - deliveredAt < windowMs) continue;

    if (Array.isArray(order.revisions)) {
      const hasActiveRequestedRevision = order.revisions.some(
        r => r.status === 'requested'
      );
      if (hasActiveRequestedRevision) continue;
    }

    if ((order.status as string) === 'disputed' || order.isTimerPaused) continue;
    const hasDispute = disputes.some(
      d => d.orderId === order.id && (d.status === 'open' || d.status === 'under_investigation')
    );
    if (hasDispute) continue;

    const esc = financeLedger.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      continue;
    }

    if (orderStateLocks.has(order.id)) {
      continue;
    }

    try {
      acquireOrderLock(order.id);
    } catch {
      continue;
    }

    const requestKey = `auto_accept_${order.id}_v${latestDelivery.version}`;

    try {
      console.log(`[ReviewWindow] Auto-accepting order ${order.id} (delivery v${latestDelivery.version}) after ${days} days.`);
      const result = await releaseOrderFunds(order, 'System Auto-Accept', `Auto-accept after buyer review window (${days} days) elapsed`, false, requestKey);

      order.acceptedVersion = latestDelivery.version;
      postgresStore.saveOrders(orders);

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
      postgresStore.saveMessages(messages);
      broadcastMessage(sysMsg, order.id);

      createNotification({
        userId: order.buyerId,
        type: 'order_auto_processed',
        title: 'Project Automatically Completed',
        message: `Project "${order.title}" was automatically completed after the ${days}-day review window.`,
        link: `/workstream/${order.id}`,
        dedupKey: `auto_accept_buyer_${order.id}_v${latestDelivery.version}`
      });

      createNotification({
        userId: order.sellerId,
        type: 'order_auto_processed',
        title: 'Project Auto-Completed & Escrow Released',
        message: `Project "${order.title}" was automatically approved and escrow funds released.`,
        link: `/workstream/${order.id}`,
        dedupKey: `auto_accept_seller_${order.id}_v${latestDelivery.version}`
      });

      registerAuditLog({
        id: 'log_' + now + '_' + Math.random().toString(36).slice(2, 6),
        actor: 'System Auto-Accept',
        role: 'super_admin',
        action: 'ORDER_AUTO_ACCEPTED',
        target: `Order #${order.id}`,
        details: `Order auto-accepted after ${days} days in delivered status without revision or dispute. Deliverable v${latestDelivery.version} approved. Escrow of $${order.amount} released (net payout $${result.freelancerNet}).`,
        timestamp: new Date(now).toLocaleString()
      });

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

  // Pending Project invoices past responseDeadline
  for (const offer of workstreamOffers) {
    if (offer.kind !== 'invoice' || offer.status !== 'pending') continue;
    const order = orders.find(o => o.id === offer.orderId);
    if (!order || order.orderType !== 'project') continue;
    if ((order.status as string) === 'disputed' || order.isTimerPaused) continue;

    const deadlineMs = offer.responseDeadline
      ? new Date(offer.responseDeadline).getTime()
      : (offer.createdAt ? new Date(offer.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000 : NaN);

    if (isNaN(deadlineMs)) continue;
    const timeLeftMs = deadlineMs - now;

    if (timeLeftMs > 0 && timeLeftMs <= 24 * 60 * 60 * 1000 && !offer.deadlineApproachingNotified) {
      offer.deadlineApproachingNotified = true;
      postgresStore.saveOffers(workstreamOffers).catch(err => console.error(err));
      createNotification({
        userId: order.buyerId,
        type: 'deadline_approaching',
        title: 'Invoice Response Window Closing Soon',
        message: `You have less than 24 hours to review invoice ${offer.number} for project "${order.title}". It will be automatically approved thereafter.`,
        link: `/workstream/${order.id}`,
        dedupKey: `deadline_warn_${offer.id}`
      });
    }

    if (now >= deadlineMs) {
      const esc = financeLedger.getEscrow(order.id);
      if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
        continue;
      }
      if (orderStateLocks.has(order.id)) {
        continue;
      }

      try {
        acquireOrderLock(order.id);
      } catch {
        continue;
      }

      const requestKey = `auto_process_invoice_${offer.id}`;
      try {
        if (offer.status !== 'pending') {
          releaseOrderLock(order.id);
          continue;
        }

        console.log(`[ReviewWindow] Auto-processing project invoice ${offer.number} on order ${order.id} after 7-day window elapsed.`);
        const result = await releaseOrderFunds(order, 'System Auto-Accept', `Auto-processed project invoice ${offer.number} after 7-day buyer review window`, false, requestKey);

        offer.status = 'paid';
        offer.resolvedAt = new Date(now).toISOString();
        offer.resolvedBy = 'system';
        offer.autoProcessedAt = new Date(now).toISOString();
        postgresStore.saveOffers(workstreamOffers);

        order.status = 'completed';
        if (!order.completedAt) order.completedAt = new Date(now).toISOString();
        postgresStore.saveOrders(orders);

        const sysMsg: Message = {
          id: 'msg_' + now + '_' + Math.random().toString(36).slice(2, 6),
          orderId: order.id,
          senderId: 'system',
          senderName: 'WorkPerHour System',
          text: `🎉 Invoice ${offer.number} automatically approved: 7-day buyer review window closed. Escrow funds ($${order.amount.toLocaleString()}) released to seller.`,
          timestamp: new Date(now).toISOString(),
          type: 'system',
          metadata: {
            action: 'offer_paid',
            offerId: offer.id,
            autoProcessed: true,
            reviewWindowDays: 7
          }
        };
        recordMessage(sysMsg);
        postgresStore.saveMessages(messages);
        broadcastMessage(sysMsg, order.id);

        createNotification({
          userId: order.buyerId,
          type: 'invoice_auto_processed',
          title: 'Invoice Auto-Processed',
          message: `Invoice ${offer.number} for project "${order.title}" was automatically approved after the 7-day review window.`,
          link: `/workstream/${order.id}`,
          dedupKey: `auto_proc_buyer_${offer.id}`
        });

        createNotification({
          userId: order.sellerId,
          type: 'invoice_auto_processed',
          title: 'Invoice Auto-Processed & Paid',
          message: `Invoice ${offer.number} for project "${order.title}" was automatically approved and escrow funds released.`,
          link: `/workstream/${order.id}`,
          dedupKey: `auto_proc_seller_${offer.id}`
        });

        registerAuditLog({
          id: 'log_' + now + '_' + Math.random().toString(36).slice(2, 6),
          actor: 'System Auto-Accept',
          role: 'super_admin',
          action: 'PROJECT_INVOICE_AUTO_PROCESSED',
          target: `Order #${order.id}`,
          details: `Project invoice ${offer.number} auto-processed after 7-day review window. Escrow of $${order.amount} released (net payout $${result.freelancerNet}).`,
          timestamp: new Date(now).toLocaleString()
        });

        processed.push({
          orderId: order.id,
          acceptedVersion: order.acceptedVersion || 1,
          amount: order.amount,
          freelancerNet: result.freelancerNet
        });
      } catch (err: any) {
        console.error(`[ReviewWindow] Failed to auto-process invoice ${offer.id}:`, err);
      } finally {
        releaseOrderLock(order.id);
      }
    }
  }

  return processed;
}
