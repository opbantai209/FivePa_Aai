import { Router, Request, Response } from 'express';
import express from 'express';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import {
  store,
  cleanAllStoreData,
  type Message,
  type Payout,
  type Dispute,
  type Refund,
  type Order,
  type CustomInvoice
} from '../store.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import { financialTransactionService, financialRepository } from '../services/financialService.js';
import { diagnosticService } from '../services/diagnosticService.js';

import {
  requireAuth,
  requireActiveStatus,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  resolveAuthenticatedUserId,
  IS_PRODUCTION
} from '../middleware/auth.js';
import {
  orderIndex,
  orderStateLocks,
  tryAcquireOrderLock,
  releaseOrderLock,
  resolveGigOrderPrice,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  refundOrderFunds,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  registerAuditLog,
  validateOrderReleasePreconditions,
  releaseCompletedOrders,
  refundCompletedOrders,
  requestKeyCache
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import { recordMessage, messageIndex } from '../services/messagingService.js';
import { closeActiveDispute } from '../services/disputeService.js';
import {
  handlePayoutRequest,
  approvePayout,
  processPayout,
  rejectPayout,
  failPayout,
  retryPayout
} from '../services/payoutService.js';
import { DEFAULT_FEE_CONFIG, calculateOrderFees } from '../../src/shared/fees.js';

interface PaymentMethodRecord {
  id: string;
  userId: string;
  type: 'card' | 'bank' | 'paypal' | 'upi';
  name: string;
  details: {
    last4?: string;
    brand?: string;
    expiry?: string;
    bankName?: string;
    accountNumberMasked?: string;
    routingNumber?: string;
    email?: string;
    upiId?: string;
  };
  isDefault: boolean;
  createdAt: string;
}

function areSimulatedDepositsAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}

function formatOrderRow(r: any): Order {
  const resolvedType = r.order_type || (r.project_id ? 'project' : 'gig');
  return {
    id: r.id,
    title: r.title,
    orderTitle: r.title,
    buyerId: r.buyer_id,
    sellerId: r.seller_id,
    amount: Number(r.amount),
    status: r.status,
    createdAt: r.created_at,
    dueDate: r.due_date,
    completedAt: r.completed_at || undefined,
    requirements: r.requirements || undefined,
    deliverables: r.deliverables || undefined,
    deliverableFiles: typeof r.deliverable_files === 'string' ? JSON.parse(r.deliverable_files) : (r.deliverable_files || undefined),
    revisions: typeof r.revisions === 'string' ? JSON.parse(r.revisions) : (r.revisions || undefined),
    adminNotes: r.admin_notes || undefined,
    isMuted: Boolean(r.is_muted),
    escrowProtectionStartDate: r.escrow_protection_start_date || undefined,
    escrowProtectionEndDate: r.escrow_protection_end_date || undefined,
    gigId: r.gig_id || undefined,
    projectId: r.project_id || undefined,
    serviceUrl: r.service_url || undefined,
    gigSlug: r.gig_slug || undefined,
    sellerUsername: r.seller_username || undefined,
    buyerUsername: r.buyer_username || undefined,
    serviceTitle: r.service_title || undefined,
    serviceThumbnail: r.service_thumbnail || undefined,
    isTimerPaused: Boolean(r.is_timer_paused),
    feeBreakdown: typeof r.fee_breakdown === 'string' ? JSON.parse(r.fee_breakdown) : (r.fee_breakdown || undefined),
    deliveryHistory: typeof r.delivery_history === 'string' ? JSON.parse(r.delivery_history) : (r.delivery_history || undefined),
    deliveryNotes: r.delivery_notes || undefined,
    deliveryReference: r.delivery_reference || undefined,
    acceptedVersion: r.accepted_version ? Number(r.accepted_version) : undefined,
    reviewWindowDays: r.review_window_days ? Number(r.review_window_days) : undefined,
    reviewWindowExpiresAt: r.review_window_expires_at || undefined,
    review: typeof r.review === 'string' ? JSON.parse(r.review) : (r.review || undefined),
    workspaceId: r.workspace_id || undefined,
    sellerReview: typeof r.seller_review === 'string' ? JSON.parse(r.seller_review) : (r.seller_review || undefined),
    previousStatus: r.previous_status || undefined,
    orderType: resolvedType,
    type: resolvedType,
    gigOrderId: r.gig_order_id || (resolvedType === 'gig' ? r.id : undefined),
    projectOrderId: r.project_order_id || (resolvedType === 'project' ? r.id : undefined),
    proposalId: r.proposal_id || undefined,
    extensionRequests: typeof r.extension_requests === 'string' ? JSON.parse(r.extension_requests) : (r.extension_requests || []),
    freeExtensionUsed: Boolean(r.free_extension_used),
    cancellationRequest: typeof r.cancellation_request === 'string' ? JSON.parse(r.cancellation_request) : (r.cancellation_request || undefined),
    cancellationHistory: typeof r.cancellation_history === 'string' ? JSON.parse(r.cancellation_history) : (r.cancellation_history || []),
    cancellationType: r.cancellation_type || undefined,
    reviewWindowRestartedAt: r.review_window_restarted_at || undefined,
    responseDeadline: r.response_deadline || undefined
  } as unknown as Order;
}

function formatDisputeRow(r: any): Dispute {
  return {
    id: r.id,
    orderId: r.order_id,
    buyerId: r.buyer_id || undefined,
    sellerId: r.seller_id || undefined,
    raisedBy: r.raised_by,
    reason: r.reason,
    evidence: r.evidence || '',
    status: r.status,
    createdAt: r.created_at,
    resolutionNotes: r.resolution_notes || undefined,
    resolutionType: r.resolution_type || undefined,
    notes: r.notes || undefined,
    assignedTo: r.assigned_to || undefined
  };
}

function formatRefundRow(r: any): Refund {
  return {
    id: r.id,
    orderId: r.order_id,
    buyerId: r.buyer_id,
    amount: Number(r.amount),
    reason: r.reason || '',
    status: r.status,
    createdAt: r.created_at
  };
}

function formatPayoutRow(r: any): Payout {
  return {
    id: r.id,
    freelancerId: r.freelancer_id,
    amount: Number(r.amount),
    method: r.method,
    status: r.status,
    createdAt: r.created_at,
    accountDetails: r.account_details || ''
  };
}

function formatPaymentMethodRow(r: any): PaymentMethodRecord {
  const details = typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || {});
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    name: r.name,
    details,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at
  };
}

const router = Router();

// ==========================================
// PUBLIC FEES & INQUIRIES
// ==========================================

router.get('/fees/quote', async (req: Request, res: Response) => {
  try {
    let gigPrice: number;
    if (typeof req.query.gigId === 'string' && req.query.gigId) {
      const extraIds = typeof req.query.extraIds === 'string' && req.query.extraIds ? req.query.extraIds.split(',') : [];
      const resolved = await resolveGigOrderPrice(req.query.gigId, extraIds);
      gigPrice = resolved.gigPrice;
    } else {
      gigPrice = Number(req.query.amount);
    }
    if (!Number.isFinite(gigPrice) || gigPrice < 0) return res.status(400).json({ error: 'A valid gigId or amount is required.' });
    
    // Authoritative fee calculation
    const q = calculateOrderFees(gigPrice, DEFAULT_FEE_CONFIG);
    res.json({ ...q, config: DEFAULT_FEE_CONFIG });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/disputes', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM disputes ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT d.* FROM disputes d
         LEFT JOIN orders o ON d.order_id = o.id
         WHERE d.raised_by = $1 OR d.buyer_id = $1 OR d.seller_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY d.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(formatDisputeRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/refunds', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM refunds ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT r.* FROM refunds r
         LEFT JOIN orders o ON r.order_id = o.id
         WHERE r.buyer_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY r.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(formatRefundRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payouts', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM payouts ORDER BY created_at DESC');
    } else {
      result = await pool.query('SELECT * FROM payouts WHERE freelancer_id = $1 ORDER BY created_at DESC', [authUserId]);
    }
    res.json(result.rows.map(formatPayoutRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payouts', requireAuth, requireActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

// ==========================================
// USER PAYMENTS SNAPSHOT & ESCROW APIS
// ==========================================

router.get('/payments/user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user financial snapshot is not allowed.' });
    }

    const userId = targetUserId;
    const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const u = targetRes.rows[0];
    
    if (u) {
      await financialTransactionService.ensureWallet(u.id);
    }

    const wallet = await financialRepository.getWallet(userId);
    const availableBalance = wallet?.availableBalance ?? Number(u?.wallet_balance || 0);
    
    const activeEscrowStatuses = ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'disputed', 'draft_review', 'work_in_progress'];
    const ordersRes = await pool.query('SELECT * FROM orders WHERE buyer_id = $1 OR seller_id = $1', [userId]);
    const userOrders = ordersRes.rows.map(formatOrderRow);

    const buyerEscrowOrders = userOrders.filter(o => o.buyerId === userId && activeEscrowStatuses.includes(o.status));
    const buyerEscrowAmount = await financialRepository.getBuyerHeldEscrowTotal(userId);

    const freelancerEscrowOrders = userOrders.filter(o => o.sellerId === userId && activeEscrowStatuses.includes(o.status));
    const freelancerEscrowAmount = await financialRepository.getFreelancerHeldEscrowTotal(userId);

    const currentYearMonth = new Date().toISOString().slice(0, 7);
    const userPaidOrders = userOrders.filter(o => o.buyerId === userId && ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'disputed', 'completed'].includes(o.status));
    const paidToDate = userPaidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
    const paidThisMonth = userPaidOrders.filter(o => (o.createdAt || '').startsWith(currentYearMonth)).reduce((sum, o) => sum + (o.amount || 0), 0);

    const userEarnedOrders = userOrders.filter(o => o.sellerId === userId && o.status === 'completed');
    const earnedToDate = Number(u?.earned || 0) || userEarnedOrders.reduce((sum, o) => sum + (o.feeBreakdown?.freelancerNet ?? o.amount), 0);
    const earnedThisMonth = userEarnedOrders.filter(o => (o.createdAt || '').startsWith(currentYearMonth)).reduce((sum, o) => sum + (o.feeBreakdown?.freelancerNet ?? o.amount), 0);

    const twoMonthsAgoDate = new Date();
    twoMonthsAgoDate.setDate(twoMonthsAgoDate.getDate() - 60);
    const earnedPastTwoMonths = userEarnedOrders
      .filter(o => o.createdAt && new Date(o.createdAt).getTime() >= twoMonthsAgoDate.getTime())
      .reduce((sum, o) => sum + (o.feeBreakdown?.freelancerNet ?? o.amount), 0);

    let userMethods: PaymentMethodRecord[] = [];
    try {
      const pmRes = await pool.query('SELECT * FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [userId]);
      userMethods = pmRes.rows.map(formatPaymentMethodRow);
    } catch {}

    res.json({
      userId,
      availableBalance,
      buyerEscrowAmount,
      freelancerEscrowAmount,
      buyerEscrowOrders,
      freelancerEscrowOrders,
      paidToDate,
      paidThisMonth,
      earnedToDate,
      earnedThisMonth,
      earnedPastTwoMonths,
      clearingPeriodDays: 14,
      paymentMethods: userMethods,
      walletStatus: wallet?.status || 'active'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments/withdraw', requireAuth, requireActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

router.post('/payments/deposit', requireAuth, requireActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
    if (requestedUserId && requestedUserId !== authUserId) {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
    }
    const targetUserId = (isAdmin && requestedUserId) ? requestedUserId : authUserId;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || req.body?.providerReference || randomUUID());
    await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      actor: `${caller.name} (Simulated)`,
      idempotencyKey: `SIM-${targetUserId}-${key}`
    });
    syncUserBalances();
    const newBalance = await financialRepository.getWalletBalance(targetUserId);
    const transaction = { id: `SIM-TXN-${key}` };

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'FUNDS_DEPOSITED',
      target: `User ${caller.name}`,
      details: `Deposited $${amount.toFixed(2)} (simulated). New Balance: $${newBalance.toFixed(2)}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, newBalance, transaction });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/gateway/checkout', requireAuth, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'USD', gateway = 'stripe' } = req.body || {};
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT id, name FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });

    await ensureWallet(authUserId);
    const checkoutId = 'chk_' + randomUUID();
    await pool.query(
      `INSERT INTO payment_intents (id, user_id, amount, currency, gateway, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())`,
      [checkoutId, authUserId, amt, currency, gateway]
    );
    res.json({
      success: true,
      checkoutId,
      gateway,
      amount: amt,
      currency,
      redirectUrl: `/checkout/success?session_id=${checkoutId}&amount=${amt}`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const secret = process.env.WEBHOOK_SECRET;
  
  if (!secret || !signature) {
    return res.status(403).json({ error: 'Unauthorized: Missing signature' });
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(req.body);
  const calculatedSignature = hmac.digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(calculatedSignature);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return res.status(403).json({ error: 'Unauthorized: Invalid signature' });
  }

  const payload = JSON.parse(req.body.toString());
  const { event, userId, amount, reference, transactionId, checkoutId, currency } = payload || {};
  
  if (event === 'payment.succeeded') {
    const providerId = transactionId || reference;
    if (!providerId) {
      return res.status(400).json({ error: 'Missing immutable transaction identifier' });
    }

    const payloadCurrency = (currency || 'USD').toUpperCase();
    if (payloadCurrency !== 'USD') {
      return res.status(400).json({ error: 'Unsupported currency: FivePA operates strictly in USD.' });
    }

    const pool = postgresStore.getPool();
    const intentId = checkoutId;
    if (!intentId) {
      return res.status(400).json({ error: 'Missing checkoutId/payment intent binding. Webhook must bind to a server-created payment record.' });
    }

    const intentRes = await pool.query('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId]);
    if (intentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Referenced server payment intent not found' });
    }
    const intent = intentRes.rows[0];

    // Idempotency: duplicate webhooks for an already-settled intent return safely
    if (intent.status === 'succeeded') {
      return res.json({ received: true, deduplicated: true });
    }

    // Verify USD currency
    if (intent.currency && intent.currency.toUpperCase() !== 'USD') {
      return res.status(400).json({ error: 'Authoritative payment intent currency must be USD' });
    }

    // Authoritative amount and user derived strictly from the server-created record
    const authoritativeAmount = Number(intent.amount);
    const authoritativeUserId = intent.user_id;

    if (amount !== undefined && Number(amount) !== authoritativeAmount) {
      return res.status(400).json({ error: 'Payload amount does not match authoritative server payment record' });
    }

    await pool.query(
      "UPDATE payment_intents SET status = 'succeeded', provider_reference = $1, updated_at = NOW() WHERE id = $2 AND status <> 'succeeded'",
      [providerId, intentId]
    );

    await financialTransactionService.ensureWallet(authoritativeUserId);
    try {
      await financialTransactionService.creditDeposit({
        userId: authoritativeUserId,
        amount: authoritativeAmount,
        reference: providerId,
        idempotencyKey: `WH-${authoritativeUserId}-${providerId}`,
        actor: 'Gateway Webhook',
        source: 'webhook'
      });
      syncUserBalances();
      return res.json({ received: true });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  }
  res.json({ received: true });
});

router.post('/payments/escrow/release', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    const isBuyer = userId === order.buyerId;
    if (!isAdmin && !isBuyer) {
      return res.status(403).json({ error: 'Forbidden: Only the order buyer or administrator can release escrow.' });
    }

    const validationError = validateOrderReleasePreconditions(order, isAdmin);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    let revisionsResolved = false;
    if (Array.isArray(order.revisions)) {
      for (const rev of order.revisions) {
        if (rev.status === 'requested') {
          rev.status = 'resolved';
          revisionsResolved = true;
        }
      }
    }
    if (revisionsResolved) {
      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'WorkSphere Review Desk',
        text: `📝 Revision resolved by buyer.`,
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'revision_resolved' }
      };
      recordMessage(sysMsg);
      await store.addMessage(sysMsg);
      broadcastMessage(sysMsg, order.id);
    }

    const esc = await financialRepository.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      return res.status(400).json({ error: 'No refundable or releasable escrow funds remain for this order.' });
    }

    const pendingOffersRes = await pool.query(
      "SELECT * FROM workstream_offers WHERE order_id = $1 AND kind = 'invoice' AND status = 'pending'",
      [order.id]
    );
    const pendingInvoices = pendingOffersRes.rows;

    const pendingHigherInvoice = pendingInvoices.find(o => Number(o.amount) > esc.remaining);
    if (pendingHigherInvoice) {
      return res.status(400).json({
        error: `Cannot release escrow directly: A final invoice (${pendingHigherInvoice.number} for $${pendingHigherInvoice.amount}) is awaiting payment. Please pay or decline the invoice in the workstream.`
      });
    }

    const pendingMatchingInvoice = pendingInvoices[0];
    if (pendingMatchingInvoice) {
      await pool.query(
        "UPDATE workstream_offers SET status = 'paid', resolved_at = $1, resolved_by = $2 WHERE id = $3",
        [new Date().toISOString(), caller?.id || userId, pendingMatchingInvoice.id]
      );
    }

    const seller = await store.getUser(order.sellerId);
    const buyer = await store.getUser(order.buyerId);

    if (seller) await ensureWallet(seller.id);
    if (buyer) await ensureWallet(buyer.id);

    const actorName = isAdmin ? adminActor(req) : (buyer?.name || 'Authorized Buyer');
    const requestKey = req.body?.requestKey || req.body?.idempotencyKey;
    const result = await releaseOrderFunds(order, actorName, 'Buyer approved work', true, requestKey);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: actorName,
      role: caller?.role || 'buyer',
      action: 'ESCROW_RELEASED_BY_BUYER',
      target: `Order #${order.id}`,
      details: `Escrow release authorized of $${order.amount}. $${result.freelancerNet} credited to ${seller?.name || 'freelancer'}, $${result.platformFee} platform fee.`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(order), freelancerNet: result.freelancerNet, platformFee: result.platformFee });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/payments/escrow/refund', requireAuth, async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const { reason } = req.body;
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const disputeRes = await pool.query(
      "SELECT id FROM disputes WHERE order_id = $1 AND (status = 'open' OR status = 'under_investigation')",
      [order.id]
    );
    if (disputeRes.rows.length > 0 || order.status === 'disputed') {
      return res.status(400).json({ error: 'Cannot refund escrow: Order is under active dispute.' });
    }
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot refund: Order has already been completed.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot refund: Order has already been cancelled/refunded.' });
    }

    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    const isSeller = userId === order.sellerId;
    const isBuyer = userId === order.buyerId;

    if (isBuyer && !isAdmin && ['delivered', 'draft_review'].includes(order.status)) {
      return res.status(403).json({ error: 'Work has been delivered. Accept it, request a revision, or open a dispute.' });
    }

    const isGigOrder = order.orderType === 'gig' || Boolean(order.gigOrderId);
    if (isGigOrder && isSeller && !isAdmin) return res.status(403).json({ error: 'Sellers must use the cancellation request.' });
    const overdueThresholdHours = isGigOrder ? 24 : 76;
    const isOverdueByThreshold = order.dueDate ? (Date.now() > new Date(order.dueDate).getTime() + overdueThresholdHours * 60 * 60 * 1000) : false;

    if (!isAdmin && !isSeller) {
      if (isBuyer && isOverdueByThreshold) {
        if (isGigOrder && (!reason || !String(reason).trim())) {
          return res.status(400).json({ error: 'Cancellation reason is required for very-late cancellation.' });
        }
        order.cancellationType = 'very_late';
      } else if (isBuyer) {
        return res.status(403).json({ error: `Forbidden: Buyer cannot cancel this order until ${overdueThresholdHours} hours have passed past the agreed due date.` });
      } else {
        return res.status(403).json({ error: 'Forbidden: Not authorized to refund this escrow.' });
      }
    }

    const buyer = await store.getUser(order.buyerId);
    if (buyer) await ensureWallet(buyer.id);

    const actorName = isAdmin ? adminActor(req) : (caller?.name || (isSeller ? 'Seller' : 'Buyer'));
    const requestKey = req.body?.requestKey || req.body?.idempotencyKey;
    const result = await refundOrderFunds(order, undefined, actorName, reason || (isSeller ? 'Seller cancelled order' : 'Escrow cancellation'), requestKey);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: actorName,
      role: caller?.role || (isSeller ? 'seller' : 'buyer'),
      action: isSeller ? 'ESCROW_REFUNDED_BY_SELLER' : (isAdmin ? 'ESCROW_REFUNDED_BY_ADMIN' : 'ESCROW_REFUNDED_BY_BUYER'),
      target: `Order #${order.id}`,
      details: `Escrow refund executed of $${result.refunded} to buyer wallet. Reason: ${reason || 'Escrow cancellation'}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order, refunded: result.refunded });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/payments/transactions/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user transactions is not allowed.' });
    }
    const userId = targetUserId;
    const userTxns = await financialRepository.getTransactions(userId);
    
    if (userTxns.length === 0) {
      const ordersRes = await pool.query('SELECT * FROM orders WHERE buyer_id = $1 OR seller_id = $1', [userId]);
      const userOrders = ordersRes.rows.map(formatOrderRow);
      const syn: any[] = [];
      for (const ord of userOrders) {
        if (ord.buyerId === userId) {
          syn.push({
            id: `txn_ord_${ord.id}`,
            type: 'escrow_fund',
            amount: ord.amount,
            currency: 'USD',
            timestamp: `${ord.createdAt} 12:00:00`,
            status: 'completed',
            userId: userId,
            userName: ord.buyerUsername || 'Buyer',
            userRole: 'buyer',
            description: `Escrow hold for Order: ${ord.title}`,
            relatedOrderId: ord.id
          });
        }
        if (ord.sellerId === userId && ord.status === 'completed') {
          // Fix 5: Use persisted historical snapshot exclusively
          const storedNet = ord.feeBreakdown?.freelancerNet ?? ord.amount;
          const commissionPercent = ord.feeBreakdown?.commissionPercent ?? (ord.amount > 0 ? Math.round((1 - storedNet / ord.amount) * 100) : 20);
          syn.push({
            id: `txn_rel_${ord.id}`,
            type: 'escrow_release',
            amount: storedNet,
            currency: 'USD',
            timestamp: `${ord.dueDate} 15:30:00`,
            status: 'completed',
            userId: userId,
            userName: ord.sellerUsername || 'Freelancer',
            userRole: 'freelancer',
            description: `Escrow earnings (${100 - commissionPercent}% net) from: ${ord.title}`,
            relatedOrderId: ord.id
          });
        }
      }
      return res.json(syn);
    }

    res.json(userTxns);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments/invoices/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user invoices is not allowed.' });
    }
    const userId = targetUserId;
    const ordersRes = await pool.query('SELECT * FROM orders WHERE buyer_id = $1 OR seller_id = $1', [userId]);
    const userOrders = ordersRes.rows.map(formatOrderRow);

    const orderInvoices = await Promise.all(userOrders.map(async o => {
      const isBuyer = o.buyerId === userId;
      const otherUser = await store.getUser(isBuyer ? o.sellerId : o.buyerId);
      const currentUser = await store.getUser(userId);
      return {
        id: `inv_ord_${o.id}`,
        invoiceNumber: `INV-${o.id.replace('ord_', '').toUpperCase()}`,
        userId: userId,
        type: isBuyer ? 'received' : 'sent',
        recipientName: isBuyer ? (currentUser?.name || 'Buyer') : (otherUser?.name || 'Client'),
        recipientEmail: isBuyer ? (currentUser?.email || 'buyer@example.com') : (otherUser?.email || 'client@example.com'),
        issuerName: isBuyer ? (otherUser?.name || 'Freelancer') : (currentUser?.name || 'Freelancer'),
        issuerEmail: isBuyer ? (otherUser?.email || 'seller@example.com') : (currentUser?.email || 'seller@example.com'),
        title: o.title,
        issueDate: o.createdAt,
        dueDate: o.dueDate,
        status: o.status === 'completed' ? 'paid' : o.status === 'cancelled' ? 'refunded' : 'in_escrow',
        items: [
          { description: o.title, quantity: 1, unitPrice: o.amount, amount: o.amount }
        ],
        subtotal: o.amount,
        serviceFee: o.feeBreakdown?.serviceFee ?? 0,
        smallOrderFee: o.feeBreakdown?.smallOrderFee ?? 0,
        platformFee: o.feeBreakdown?.platformCommission ?? 0,
        tax: 0,
        total: o.feeBreakdown?.clientTotal ?? o.amount,
        notes: `WorkPerHour 14-Day Escrow Protection Order #${o.id}. 100% Protected.`,
        relatedOrderId: o.id
      };
    }));

    let userCustom: any[] = [];
    try {
      const ciRes = await pool.query('SELECT * FROM custom_invoices WHERE buyer_id = $1 OR seller_id = $1', [userId]);
      userCustom = ciRes.rows.map(r => ({
        id: r.id,
        invoiceNumber: r.invoice_number,
        userId: r.buyer_id,
        recipientName: 'Client',
        recipientEmail: 'client@example.com',
        title: r.description || `Invoice ${r.invoice_number}`,
        issueDate: r.created_at ? r.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
        dueDate: r.paid_at || new Date().toISOString().slice(0, 10),
        status: r.status,
        items: [{ description: r.description || 'Service', quantity: 1, unitPrice: Number(r.amount), amount: Number(r.amount) }],
        subtotal: Number(r.amount),
        platformFee: 0,
        tax: 0,
        total: Number(r.amount),
        relatedOrderId: r.related_order_id || undefined
      }));
    } catch {}

    res.json([...orderInvoices, ...userCustom]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments/invoices', requireAuth, async (req: Request, res: Response) => {
  try {
    const authenticatedUserId = (req as any).authenticatedUserId;
    const { recipientName, recipientEmail, title, dueDate, items, notes } = req.body;
    if (!title || !recipientName) {
      return res.status(400).json({ error: 'Title and recipient name are required' });
    }
    const cleanItems = (items && items.length > 0) ? items : [{ description: title, quantity: 1, unitPrice: 100, amount: 100 }];
    const subtotal = cleanItems.reduce((s: number, it: any) => s + (Number(it.amount) || (Number(it.quantity || 1) * Number(it.unitPrice || 0))), 0);
    const platformFee = 0;
    const total = subtotal;

    const newInvoice: CustomInvoice = {
      id: 'inv_' + Date.now() + '_' + randomUUID().slice(0, 8),
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
      userId: authenticatedUserId,
      recipientName,
      recipientEmail: recipientEmail || 'client@example.com',
      title,
      issueDate: new Date().toISOString().substring(0, 10),
      dueDate: dueDate || new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
      status: 'unpaid',
      items: cleanItems,
      subtotal,
      platformFee,
      tax: 0,
      total,
      notes: notes || 'Standard WorkPerHour Invoice'
    };

    const pool = postgresStore.getPool();
    await pool.query(
      `INSERT INTO custom_invoices (id, invoice_number, buyer_id, seller_id, amount, status, description, created_at, paid_at, related_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         invoice_number = EXCLUDED.invoice_number,
         buyer_id = EXCLUDED.buyer_id,
         seller_id = EXCLUDED.seller_id,
         amount = EXCLUDED.amount,
         status = EXCLUDED.status,
         description = EXCLUDED.description,
         created_at = EXCLUDED.created_at`,
      [newInvoice.id, newInvoice.invoiceNumber, authenticatedUserId, authenticatedUserId, newInvoice.total, newInvoice.status, newInvoice.title, newInvoice.issueDate, null, null]
    );

    res.status(201).json(newInvoice);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/payments/methods/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';
    
    if (!isAdmin && authUserId !== req.params.userId) {
      return res.status(403).json({ error: 'Unauthorized: Cannot view another user payment methods.' });
    }

    const pmRes = await pool.query('SELECT * FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.params.userId]);
    const methods = pmRes.rows.map(formatPaymentMethodRow);
    const sanitized = methods.map(m => ({
      ...m,
      details: {
        ...m.details,
        routingNumber: undefined
      }
    }));
    res.json(sanitized);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments/methods', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const { type, name, details, isDefault } = req.body;
    const userId = authUserId;
    
    if (!userId || !type || !name) {
      return res.status(400).json({ error: 'Method type and name are required' });
    }

    const pool = postgresStore.getPool();
    if (isDefault) {
      await pool.query('UPDATE payment_methods SET is_default = false WHERE user_id = $1', [userId]);
    }

    const existingCountRes = await pool.query('SELECT COUNT(*) as count FROM payment_methods WHERE user_id = $1', [userId]);
    const existingCount = Number(existingCountRes.rows[0]?.count || 0);

    const newMethod: PaymentMethodRecord = {
      id: 'pm_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId,
      type,
      name,
      details: details || {},
      isDefault: Boolean(isDefault) || existingCount === 0,
      createdAt: new Date().toISOString().substring(0, 10)
    };

    await pool.query(
      `INSERT INTO payment_methods (id, user_id, type, name, details, is_default, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newMethod.id, newMethod.userId, newMethod.type, newMethod.name, JSON.stringify(newMethod.details), newMethod.isDefault, newMethod.createdAt]
    );

    res.json(newMethod);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/payments/methods/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const methodRes = await pool.query('SELECT * FROM payment_methods WHERE id = $1', [req.params.id]);
    if (methodRes.rows.length === 0) return res.status(404).json({ error: 'Payment method not found' });
    const method = formatPaymentMethodRow(methodRes.rows[0]);

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot delete another user payment method.' });
    }

    await pool.query('DELETE FROM payment_methods WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/payments/methods/:id/default', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const methodRes = await pool.query('SELECT * FROM payment_methods WHERE id = $1', [req.params.id]);
    if (methodRes.rows.length === 0) return res.status(404).json({ error: 'Payment method not found' });
    const method = formatPaymentMethodRow(methodRes.rows[0]);

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify another user payment method.' });
    }

    await pool.query('UPDATE payment_methods SET is_default = false WHERE user_id = $1', [method.userId]);
    await pool.query('UPDATE payment_methods SET is_default = true WHERE id = $1', [method.id]);
    method.isDefault = true;
    res.json(method);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/wallet/deposit', requireAuth, requireActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    let targetUserId = authUserId;
    if (requestedUserId && requestedUserId !== authUserId) {
      const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
      const targetUser = await store.getUser(requestedUserId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Target user not found' });
      }
      targetUserId = requestedUserId;
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await financialTransactionService.ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || randomUUID());
    const { replayed } = await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      reference: `SIM-${key}`,
      idempotencyKey: `SIM-${targetUserId}-${key}`,
      actor: `${caller.name} (Simulated)`,
      source: 'simulated'
    });
    syncUserBalances();
    const newBal = await financialRepository.getWalletBalance(targetUserId);
    res.json({ success: true, replayed, balance: newBal });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// ADMIN FINANCE REST APIS
// ==========================================

router.post('/admin/finance/reset-clean', requireRole(['super_admin']), async (req: Request, res: Response) => {
  if (IS_PRODUCTION && process.env.ALLOW_DATA_RESET !== 'true') {
    return res.status(403).json({ error: 'Data reset is disabled in production.' });
  }
  try {
    await cleanAllStoreData();
    orderIndex.clear();
    messageIndex.clear();
    orderStateLocks.clear();
    releaseCompletedOrders.clear();
    refundCompletedOrders.clear();
    requestKeyCache.clear();
    res.json({ success: true, message: 'All demo and runtime data reset to pristine clean state.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/overview', requireRole(['admin', 'super_admin']), async (req: Request, res: Response) => {
  try {
    const overview = await financialRepository.getFinancialOverview();
    res.json(overview);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/wallets', requireAdmin, async (req: Request, res: Response) => {
  try {
    const wallets = await financialRepository.getWallets();
    res.json(wallets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/wallets/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const data = await financialRepository.getWalletById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Wallet not found' });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/freeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to freeze a wallet' });
    const wallet = await financialTransactionService.freezeWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/unfreeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const wallet = await financialTransactionService.unfreezeWallet(req.params.id, reason || 'Administrative review completed', adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/restrict', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to restrict a wallet' });
    const wallet = await financialTransactionService.restrictWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/transactions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txns = await financialRepository.getTransactions();
    res.json(txns);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/transactions/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txn = await financialRepository.getTransactionById(req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const journal = txn.journalId ? await financialRepository.getJournalById(txn.journalId) : null;
    res.json({ transaction: txn, journal });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/ledger', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journals = await financialRepository.getJournals();
    res.json(journals);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/ledger/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journal = await financialRepository.getJournalById(req.params.id);
    if (!journal) return res.status(404).json({ error: 'Journal not found' });
    res.json(journal);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/ledger/:id/reverse', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory accounting reversal reason required' });
    const reversal = await financialTransactionService.reverseJournal(req.params.id, reason, adminActor(req));
    res.json(reversal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/escrow', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    const allOrders = ordersRes.rows.map(formatOrderRow);

    const disputesRes = await pool.query("SELECT * FROM disputes WHERE status IN ('open', 'under_investigation')");
    const activeDisputes = new Set(disputesRes.rows.map(r => r.order_id));

    const refundsRes = await pool.query("SELECT * FROM refunds WHERE status = 'approved'");
    const activeRefunds = new Set(refundsRes.rows.map(r => r.order_id));

    const escrowOrders = await Promise.all(allOrders.map(async o => {
      const enriched = enrichOrderWithServiceInfo(o);
      const isDisputed = activeDisputes.has(o.id);
      const isRefunded = activeRefunds.has(o.id);
      const buyer = await store.getUser(o.buyerId);
      const seller = await store.getUser(o.sellerId);

      let escrowState = 'in_progress';
      if (isDisputed) escrowState = 'disputed';
      else if (isRefunded) escrowState = 'refunded';
      else if (o.status === 'completed') escrowState = 'released';
      else if (o.status === 'delivered') escrowState = 'release_pending';
      else if (o.status === 'funded_in_escrow') escrowState = 'funded';

      const esc = await financialRepository.getEscrow(o.id);
      const commissionPercent = esc?.commissionPercent ?? (o.feeBreakdown?.commissionPercent ?? (o.amount > 0 && o.feeBreakdown?.freelancerNet ? Math.round((1 - o.feeBreakdown.freelancerNet / o.amount) * 100) : 20));
      const platformFeeAmount = esc ? esc.commissionTotal : (o.feeBreakdown?.platformCommission ?? (o.feeBreakdown?.freelancerCommission ?? Math.round((o.amount * commissionPercent / 100 + Number.EPSILON) * 100) / 100));
      const freelancerNetAmount = esc ? (esc.amount - esc.commissionTotal) : (o.feeBreakdown?.freelancerNet ?? (o.amount - platformFeeAmount));

      return {
        ...enriched,
        buyerName: buyer?.name || 'Buyer #' + o.buyerId,
        buyerEmail: buyer?.email || '',
        sellerName: seller?.name || 'Freelancer #' + o.sellerId,
        sellerEmail: seller?.email || '',
        platformFeeRate: `${commissionPercent}%`,
        platformFeeAmount,
        freelancerNetAmount,
        ledgerEscrowStatus: esc?.status || 'not_funded',
        ledgerEscrowHeld: esc?.remaining ?? 0,
        escrowState,
        isDisputed
      };
    }));
    res.json(escrowOrders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/escrow/:orderId/release', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Order escrow has already been released and completed.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot release escrow: Order has already been cancelled/refunded.' });
    }
    const pool = postgresStore.getPool();
    const disputeRes = await pool.query(
      "SELECT id FROM disputes WHERE order_id = $1 AND (status = 'open' OR status = 'under_investigation')",
      [order.id]
    );
    if (disputeRes.rows.length > 0 || order.status === 'disputed') {
      return res.status(400).json({ error: `Cannot release escrow: Order #${order.id} is under active dispute. Resolve the dispute first.` });
    }
    const esc = await financialRepository.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      return res.status(400).json({ error: 'No refundable or releasable escrow funds remain for this order.' });
    }
    const result = await releaseOrderFunds(order, adminActor(req), String(req.body.reason || 'Administrative escrow release'), false, req.body.requestKey);
    res.json({ success: true, order, journal: result.journal, freelancerNet: result.freelancerNet, platformFee: result.platformFee });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/admin/finance/escrow/:orderId/refund', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot refund order: Escrow funds have already been released to seller.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order is already cancelled/refunded.' });
    }
    const esc = await financialRepository.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      return res.status(400).json({ error: 'No refundable escrow funds remaining for this order.' });
    }
    const rawAmount = req.body.amount === undefined || req.body.amount === '' ? undefined : Number(req.body.amount);
    if (rawAmount !== undefined) {
      if (typeof rawAmount !== 'number' || Number.isNaN(rawAmount) || !Number.isFinite(rawAmount) || rawAmount < 0) {
        return res.status(400).json({ error: 'Refund amount must be a valid non-negative number.' });
      }
    }
    const amount = rawAmount;
    const result = await refundOrderFunds(order, amount, adminActor(req), String(req.body.reason || 'Administrative escrow refund approval'), req.body.requestKey);
    await closeActiveDispute(order.id, 'resolved_refund', String(req.body.reason || 'Administrative escrow refund'));
    res.json({ success: true, order, journal: result.journal });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/admin/finance/payouts', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts ORDER BY created_at DESC');
    const payoutsList = result.rows.map(formatPayoutRow);

    const enrichedPayouts = await Promise.all(payoutsList.map(async p => {
      const freelancer = await store.getUser(p.freelancerId);
      const wallet = await financialRepository.getWallet(p.freelancerId);
      return {
        ...p,
        freelancerName: freelancer?.name || 'Freelancer #' + p.freelancerId,
        freelancerEmail: freelancer?.email || '',
        walletAvailableBalance: wallet?.availableBalance || 0,
        currency: 'USD'
      };
    }));
    res.json(enrichedPayouts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/payouts/:id/approve', requireAdmin, approvePayout);
router.post('/admin/finance/payouts/:id/process', requireAdmin, processPayout);
router.post('/admin/finance/payouts/:id/reject', requireAdmin, rejectPayout);
router.post('/admin/finance/payouts/:id/fail', requireAdmin, failPayout);
router.post('/admin/finance/payouts/:id/retry', requireAdmin, retryPayout);

router.patch('/api/admin/payouts/:id/approve', requireAdmin, approvePayout);
router.patch('/api/admin/payouts/:id/process', requireAdmin, processPayout);
router.patch('/api/admin/payouts/:id/fail', requireAdmin, failPayout);

router.get('/admin/finance/reconciliation', requireAdmin, async (req: Request, res: Response) => {
  try {
    const recon = await financialRepository.getReconciliationSummary();
    res.json(recon);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/reconciliation/resolve/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;
    if (!notes) return res.status(400).json({ error: 'Investigation notes required to mark exception resolved' });
    const actor = adminActor(req);
    const actorName = typeof actor === 'string' ? actor : ((actor as any).name || (actor as any).email || 'admin');
    if (isPostgresEnabled()) {
      const logId = 'log_' + randomUUID().slice(0, 12);
      await postgresStore.getPool().query(
        `INSERT INTO audit_logs (id, actor, role, action, target, details, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [logId, actorName, 'admin', 'RESOLVE_RECONCILIATION_EXCEPTION', req.params.id, JSON.stringify({ notes }), new Date().toISOString()]
      );
      return res.json({ success: true, id: req.params.id, status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: actorName });
    }
    res.json({ success: true, id: req.params.id, status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: actorName });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/audit', requireAdmin, async (req: Request, res: Response) => {
  try {
    const logs = await postgresStore.listAuditLogs();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/finance/adjustments/preview', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason } = req.body;
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 0) {
      return res.status(400).json({ error: 'Adjustment amount must be a valid non-negative number.' });
    }
    const preview = await financialRepository.previewAdjustment({ userId, amount: numAmount, direction, category, reason });
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/adjustments', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason, evidenceReference, requestKey } = req.body;
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 0) {
      return res.status(400).json({ error: 'Adjustment amount must be a valid non-negative number.' });
    }
    const result = await financialTransactionService.executeAdjustment({
      userId,
      amount: numAmount,
      direction,
      category,
      reason,
      evidenceReference,
      actor: adminActor(req),
      requestKey
    });
    syncUserBalances();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/diagnostics', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { severity, service, operation, requestId, legacyOnly } = req.query;
    if (!isPostgresEnabled()) {
      return res.json(diagnosticService.getInMemoryLogs(req.query));
    }
    let sql = 'SELECT * FROM runtime_diagnostic_logs WHERE 1=1';
    const params: any[] = [];
    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (service) { params.push(service); sql += ` AND service = $${params.length}`; }
    if (operation) { params.push(operation); sql += ` AND operation = $${params.length}`; }
    if (requestId) { params.push(requestId); sql += ` AND request_id = $${params.length}`; }
    if (legacyOnly === 'true') { params.push('financeLedger'); sql += ` AND implementation = $${params.length}`; }
    sql += ' ORDER BY timestamp DESC LIMIT 100';
    
    const logs = await postgresStore.getPool().query(sql, params);
    res.json(logs.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/finance/export/:type', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { type } = req.params;
    const { filename, content } = await financialRepository.generateCsvExport(type, req.query as any);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(content);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
