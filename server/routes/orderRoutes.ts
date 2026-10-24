import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  orders,
  users,
  messages,
  disputes,
  gigs,
  projects,
  DEFAULT_SITE_SETTINGS,
  financeLedger,
  type ExtensionRequest,
  type Message,
  type Dispute,
  type Order,
  type WorkstreamOffer,
  workstreamOffers
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  requireAuth,
  requireActiveStatus,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  resolveAuthenticatedUserId,
  safeUser,
  orderParticipantSafeUser
} from '../middleware/auth.js';
import {
  orderIndex,
  tryAcquireOrderLock,
  releaseOrderLock,
  recordOrder,
  resolveGigOrderPrice,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  refundOrderFunds,
  splitOrderFunds,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  registerAuditLog,
  getActiveEscrowRemaining
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import {
  createNotification,
  sendOrderEmail,
  notifyOrderParties
} from '../services/notificationService.js';
import {
  recordMessage,
  emitSystemEvent,
  pushSystemMessage,
  messageIndex
} from '../services/messagingService.js';
import { closeActiveDispute } from '../services/disputeService.js';
import {
  orderHasEscrow,
  viewOffer,
  postOfferMessage,
  validateStoredWorkstreamFiles
} from '../services/workstreamService.js';
import { workspaceService } from '../../src/server/workspaceService.js';

function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const router = Router();

// Orders List
router.get('/orders', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req)!;
  const caller = users.find(u => u.id === authUserId);
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';
  const userOrders = orders.filter(o => (isAdmin || o.buyerId === authUserId || o.sellerId === authUserId));
  res.json(userOrders.map(o => enrichOrderWithServiceInfo(o, isAdmin)));
});

// Single Order Workspace Detail
router.get('/orders/:id', requireAuth, (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const authUserId = resolveAuthenticatedUserId(req)!;
  const caller = users.find(u => u.id === authUserId);
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
  if (!isAdmin && order.buyerId !== authUserId && order.sellerId !== authUserId) {
    return res.status(403).json({ error: 'Forbidden: Access to this order is restricted to participants.' });
  }
  const enriched = enrichOrderWithServiceInfo(order, isAdmin);
  const buyer = users.find(u => u.id === order.buyerId);
  const seller = users.find(u => u.id === order.sellerId);
  const orderMessages = messageIndex.get(order.id) || [];
  const dispute = disputes.find(d => d.orderId === order.id);

  res.json({
    ...enriched,
    buyer: buyer ? (isAdmin ? safeUser(buyer) : orderParticipantSafeUser(buyer)) : null,
    seller: seller ? (isAdmin ? safeUser(seller) : orderParticipantSafeUser(seller)) : null,
    messages: orderMessages,
    dispute
  });
});

// Create Order / Inquiry
router.post('/orders', requireAuth, requireActiveStatus, rateLimit(30, 60_000), async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot purchase new services while your account is restricted.' });
  try {
    const authUserId = (req as any).authenticatedUserId;
    const userCaller = (req as any).authenticatedUser || users.find(u => u.id === authUserId);
    if (!userCaller || (userCaller.status !== 'active' && userCaller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (title.length < 3) return res.status(400).json({ error: 'A valid order title is required.' });
    const buyerId = userCaller.id;
    const sellerId = String(req.body?.sellerId || '');
    const buyer = userCaller;
    const seller = users.find(u => u.id === sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found.' });
    if (buyerId === sellerId) return res.status(400).json({ error: 'You cannot order from yourself.' });
    ensureWallet(buyerId); ensureWallet(sellerId);
    if (buyer.status !== 'active' || seller.status !== 'active') return res.status(403).json({ error: 'Both accounts must be active to place an order.' });
    const id = 'ord_' + randomUUID().slice(0, 12);
    const today = new Date().toISOString().split('T')[0];
    let rawAmount = Number(req.body?.amount);
    const isInquiry = rawAmount === 0 && /^inquiry:/i.test(title);

    if (!isInquiry && req.body?.gigId) {
      const priced = resolveGigOrderPrice(String(req.body.gigId), req.body?.extraIds);
      if (priced.gig.freelancerId !== sellerId) return res.status(400).json({ error: 'This gig does not belong to the selected seller.' });
      rawAmount = priced.gigPrice;
    }

    const requirements = typeof req.body?.requirements === 'string' ? escapeHtml(req.body.requirements.trim()).slice(0, 2000) : '';

    let deliveryDays = 10;
    if (req.body?.gigId) {
      const gig = gigs.find(g => g.id === req.body.gigId);
      if (gig && Number(gig.deliveryDays) > 0) {
        deliveryDays = Math.max(1, Math.min(365, Number(gig.deliveryDays)));
      }
    } else if (req.body?.projectId) {
      const proj = projects.find(p => p.id === req.body.projectId);
      if (proj && Number(proj.deadlineDays) > 0) {
        deliveryDays = Math.max(1, Math.min(365, Number(proj.deadlineDays)));
      }
    }
    const serverDerivedDueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString().split('T')[0];

    const isGig = Boolean(req.body?.gigId);
    const isProject = Boolean(req.body?.projectId);
    const orderType: 'gig' | 'project' | undefined = isGig ? 'gig' : (isProject ? 'project' : undefined);
    const gigOrderId = isGig ? id : undefined;
    const projectOrderId = isProject ? id : undefined;

    let workspaceId = req.body?.workspaceId;
    if (workspaceId) {
      const ws = workspaceService.getWorkspace(workspaceId);
      if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
      if (ws.buyerId !== buyerId || ws.sellerId !== sellerId) {
        return res.status(400).json({ error: 'The provided workspace does not match the buyer and seller of this order.' });
      }
    } else {
      const ws = workspaceService.createWorkspace({
        buyerId,
        sellerId,
        originType: isGig ? 'gig' : 'project',
        originId: req.body?.gigId || req.body?.projectId || id,
        activeOrderId: id
      });
      workspaceId = ws.workspaceId;
    }

    let newOrd: Order;
    if (isInquiry) {
      newOrd = {
        id,
        workspaceId,
        ...(orderType ? { orderType } : {}),
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title,
        buyerId,
        sellerId,
        amount: 0,
        status: 'in_progress',
        createdAt: today,
        dueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
        gigId: req.body.gigId,
        projectId: req.body.projectId,
        ...(requirements ? { requirements } : {})
      };
    } else {
      newOrd = {
        id,
        workspaceId,
        ...(orderType ? { orderType } : {}),
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title,
        buyerId,
        sellerId,
        amount: rawAmount,
        status: 'payment_pending',
        createdAt: today,
        dueDate: serverDerivedDueDate,
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: new Date(Date.now() + DEFAULT_SITE_SETTINGS.commission.escrowProtectionDays * 86400000).toISOString().split('T')[0],
        gigId: req.body.gigId,
        projectId: req.body.projectId,
        feeBreakdown: financeLedger.quoteOrder(rawAmount),
        ...(requirements ? { requirements } : {})
      };
    }
    const enriched = enrichOrderWithServiceInfo(newOrd);
    recordOrder(enriched);
    await postgresStore.saveOrders(orders);

    if (!isInquiry) {
      try {
        fundOrderEscrowWithEvent({ orderId: id, orderTitle: title, amount: rawAmount, buyerId, sellerId, actor: `user:${buyerId}` });
        
        enriched.status = 'funded_in_escrow';
        await postgresStore.saveOrders(orders);
        
        syncUserBalances();
      } catch (fundingErr: any) {
        const orderIdx = orders.findIndex(o => o.id === id);
        if (orderIdx !== -1) orders.splice(orderIdx, 1);
        orderIndex.delete(id);

        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].orderId === id) {
            messages.splice(i, 1);
          }
        }

        await postgresStore.saveOrders(orders);
        await postgresStore.saveMessages(messages);

        const wsId = (enriched as any).workspaceId;
        if (wsId) {
          const otherOrdersInWs = orders.filter(o => o.workspaceId === wsId);
          if (otherOrdersInWs.length === 0) {
            workspaceService.deleteWorkspace(wsId);
          }
        }

        return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow. Order creation rolled back.' });
      }
    }
    if (isInquiry) {
      emitSystemEvent(newOrd.id, 'order_created', `Inquiry thread opened: ${title}.`);
    } else {
      emitSystemEvent(newOrd.id, 'order_created', `Order placed: ${title}. Payment is held in escrow until the work is approved.`);
      if (requirements) {
        recordMessage({
          id: 'msg_' + Date.now() + '_req_' + Math.random().toString(36).slice(2, 6),
          orderId: id,
          senderId: buyer.id,
          senderName: buyer.name,
          type: 'message',
          text: `Project requirements: ${requirements}`,
          timestamp: new Date(Date.now() + 1).toISOString(),
          metadata: { action: 'requirements_logged' }
        } as Message);
        await postgresStore.saveMessages(messages);
      }
    }
    res.status(201).json(enriched);
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Extend Order Deadline (Admin)
router.patch('/orders/:id/extend-time', requireAdmin, async (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { days, newDueDate, reason } = req.body;
  const oldDate = order.dueDate;
  let targetDate = newDueDate;

  if (days && Number(days) > 0) {
    const current = new Date(order.dueDate || Date.now());
    current.setDate(current.getDate() + Number(days));
    targetDate = current.toISOString().split('T')[0];
  } else if (!targetDate) {
    targetDate = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
  }

  order.dueDate = targetDate;

  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'System / Admin Notice',
    text: `⏱️ Deadline extended from ${oldDate} to ${order.dueDate}. ${reason ? 'Reason: ' + reason : 'Admin approved time extension.'}`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { action: 'order_deadline_extended', oldDate, newDueDate: order.dueDate, reason } as any
  };
  recordMessage(sysMsg);
  await postgresStore.saveMessages(messages);
  await postgresStore.saveOrders(orders);
  broadcastMessage(sysMsg, order.id);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'ORDER_DEADLINE_EXTENDED',
    target: `Order #${order.id}`,
    details: `Extended deadline to ${order.dueDate} (${days || 'custom'} days). ${reason || ''}`,
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, order: enrichOrderWithServiceInfo(order), message: sysMsg });
});

// Request Delivery Extension (Seller)
router.post('/orders/:id/extension-request', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  const order = orderIndex.get(orderId) || orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!tryAcquireOrderLock(order.id, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    if (userId !== order.sellerId) return res.status(403).json({ error: 'Only the seller can request more time.' });
    if (['completed', 'cancelled', 'disputed', 'payment_pending'].includes(order.status)) {
      return res.status(409).json({ error: 'Cannot request an extension for this order.' });
    }
    const pending = order.extensionRequests?.find(r => r.status === 'pending');
    if (pending) return res.json({ request: pending });
    if (order.freeExtensionUsed) return res.status(409).json({ error: 'Free extension already used.' });

    const { days, reason } = req.body;
    const numDays = Number(days);
    if (!Number.isInteger(numDays) || numDays < 1 || numDays > 14) return res.status(400).json({ error: 'Days must be 1-14.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required.' });

    const newRequest: ExtensionRequest = {
      id: 'ext_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      requestedBy: 'seller',
      days: numDays,
      reason: reason.trim(),
      originalDueDate: order.dueDate,
      requestedDueDate: new Date(new Date(order.dueDate).getTime() + numDays * 86400000).toISOString().split('T')[0],
      requestedAt: new Date().toISOString(),
      responseDeadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      status: 'pending'
    };
    if (!order.extensionRequests) order.extensionRequests = [];
    order.extensionRequests.push(newRequest);
    order.freeExtensionUsed = true;
    await postgresStore.saveOrders(orders);

    const sysMsg: Message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      orderId: order.id,
      senderId: 'system',
      senderName: 'System',
      text: 'System: The seller requested additional delivery time. Please review the extension request.',
      timestamp: new Date().toISOString(),
      type: 'system',
      metadata: { action: 'time_extension_requested' } as any
    };
    recordMessage(sysMsg);
    await postgresStore.saveMessages(messages);
    broadcastMessage(sysMsg, order.id);

    createNotification({
      userId: order.buyerId,
      type: 'order',
      title: 'Time Extension Requested',
      message: `The seller requested ${numDays} more days.`,
      link: `/workstream/${order.id}`
    });
    res.json({ request: newRequest });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Respond to Extension Request (Buyer)
router.post('/orders/:id/extension-request/respond', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  const order = orderIndex.get(orderId) || orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!tryAcquireOrderLock(order.id, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    if (userId !== order.buyerId) return res.status(403).json({ error: 'Only the buyer can respond.' });
    const request = order.extensionRequests?.find(r => r.status === 'pending');
    if (!request) return res.status(404).json({ error: 'No pending request.' });

    if (request.responseDeadline && new Date() > new Date(request.responseDeadline)) {
      request.status = 'expired';
      await postgresStore.saveOrders(orders);
      
      const expireMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension request has expired without a response.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_expired' } as any
      };
      recordMessage(expireMsg);
      await postgresStore.saveMessages(messages);
      broadcastMessage(expireMsg, order.id);
      
      return res.status(410).json({ error: 'This extension request has expired.' });
    }

    const { action, reason } = req.body;
    if (action === 'approve') {
      request.status = 'approved';
      request.respondedBy = userId;
      request.respondedAt = new Date().toISOString();
      request.resultingDueDate = request.requestedDueDate;
      order.dueDate = request.requestedDueDate;
      await postgresStore.saveOrders(orders);
      
      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension was approved. The deadline has been updated.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_approved' } as any
      };
      recordMessage(sysMsg);
      await postgresStore.saveMessages(messages);
      broadcastMessage(sysMsg, order.id);
      createNotification({ userId: order.sellerId, type: 'order', title: 'Extension Approved', message: 'The buyer approved the extension.', link: `/workstream/${order.id}` });
    } else if (action === 'reject') {
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required.' });
      request.status = 'rejected';
      request.rejectionReason = reason.trim();
      request.respondedBy = userId;
      request.respondedAt = new Date().toISOString();
      await postgresStore.saveOrders(orders);

      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension was rejected. The original deadline remains unchanged.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_rejected' } as any
      };
      recordMessage(sysMsg);
      await postgresStore.saveMessages(messages);
      broadcastMessage(sysMsg, order.id);
      createNotification({ userId: order.sellerId, type: 'order', title: 'Extension Rejected', message: 'The buyer rejected the extension.', link: `/workstream/${order.id}` });
    } else {
      return res.status(400).json({ error: 'Invalid action.' });
    }
    res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Admin Private Notes
router.post('/orders/:id/admin-notes', requireAdmin, async (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.adminNotes = req.body.notes || '';
  await postgresStore.saveOrders(orders);
  res.json({ success: true, adminNotes: order.adminNotes });
});

// Upload Deliverable
router.post('/orders/:id/deliverable', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = orderIndex.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    const caller = users.find(u => u.id === authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && order.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only the seller or an administrator can submit deliverables.' });
    }

    const allowedStatuses = ['funded_in_escrow', 'in_progress', 'revision', 'draft_review', 'delivered', 'work_in_progress', 'completed'];
    if (!allowedStatuses.includes(order.status)) {
      return res.status(409).json({ error: `Cannot submit a deliverable for an order in "${order.status}" status.` });
    }
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot submit a deliverable for a completed order.' });
    }

    if (!order.deliverableFiles) order.deliverableFiles = [];
    if (!order.deliveryHistory) order.deliveryHistory = [];

    const rawFiles = Array.isArray(req.body.files) && req.body.files.length > 0 
      ? req.body.files 
      : (req.body.name ? [{ name: req.body.name, size: req.body.size, url: req.body.url }] : []);

    const rawNotes = typeof req.body.notes === 'string' ? req.body.notes
      : (typeof req.body.message === 'string' ? req.body.message : '');
    const rawReference = typeof req.body.reference === 'string' ? req.body.reference
      : (typeof req.body.referenceUrl === 'string' ? req.body.referenceUrl
      : (!req.body.name && typeof req.body.url === 'string' ? req.body.url : ''));
    const trimmedNotes = rawNotes.trim();
    const trimmedReference = rawReference.trim();

    if (rawFiles.length === 0 && !trimmedNotes && !trimmedReference) {
      return res.status(400).json({ error: 'Add a file, a URL/reference, or a written completion message to submit a delivery.' });
    }

    let validatedFiles: Array<{ name: string; size: string; url: string }> = [];
    if (rawFiles.length > 0) {
      const validation = validateStoredWorkstreamFiles(rawFiles, caller);
      if (!validation.ok) {
        return res.status(400).json({ error: (validation as any).error });
      }
      validatedFiles = validation.files;
    }

    const isDraft = Boolean(req.body.isDraft);
    const uploadedFiles = validatedFiles.map((f: any, idx: number) => ({
      id: 'deliv_' + Date.now() + '_' + idx,
      name: f.name,
      size: f.size,
      url: f.url,
      uploadedAt: new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
      type: isDraft ? 'draft' : 'deliverable'
    }));

    order.deliverableFiles.push(...uploadedFiles);
    order.status = isDraft ? 'draft_review' : 'delivered';
    const sanitizedNotes = trimmedNotes ? escapeHtml(trimmedNotes) : '';
    const storedReference = trimmedReference.slice(0, 2000);
    order.deliveryNotes = sanitizedNotes;
    order.deliveryReference = storedReference;

    const version = order.deliveryHistory.length + 1;
    const deliveredAt = new Date().toISOString();
    const projectResponseDeadline = order.orderType === 'project'
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    order.deliveryHistory.push({
      version,
      notes: sanitizedNotes,
      reference: storedReference || undefined,
      files: uploadedFiles,
      deliveredAt,
      ...(projectResponseDeadline ? { responseDeadline: projectResponseDeadline } : {})
    });
    if (projectResponseDeadline) {
      order.responseDeadline = projectResponseDeadline;
    }

    let resolvedRevisionCount = 0;
    if (order.revisions && order.revisions.length > 0) {
      for (const rev of order.revisions) {
        if (rev.status === 'requested') {
          rev.status = 'resolved';
          resolvedRevisionCount++;
        }
      }
    }

    if (resolvedRevisionCount > 0) {
      emitSystemEvent(order.id, 'revision_resolved', `📝 Revision resolved via Delivery #v${version}.`, {
        deliveryVersion: version
      });
    }

    const summaryParts: string[] = [];
    if (uploadedFiles.length > 0) summaryParts.push(uploadedFiles.map((f: any) => `"${f.name}" (${f.size})`).join(', '));
    if (storedReference) summaryParts.push(`Reference: ${storedReference}`);
    const fileSummary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'written completion update';
    
    emitSystemEvent(
      order.id,
      'deliverable_submitted',
      isDraft
        ? `📦 Draft Delivery #v${version} submitted (${fileSummary}).`
        : `📦 Delivery / Final Invoice #v${version} submitted (${fileSummary}).`,
      {
        version,
        isDraft,
        notes: sanitizedNotes,
        reference: storedReference || undefined,
        files: uploadedFiles
      }
    );

    let createdInvoiceOffer: any = undefined;
    if (!isDraft && req.body.createInvoiceOffer && orderHasEscrow(order.id)) {
      const activeEsc = getActiveEscrowRemaining(order);
      const requestedAmt = Math.round(Number(req.body.invoiceAmount || activeEsc || order.amount || 0) * 100) / 100;
      const invAmt = requestedAmt >= activeEsc && requestedAmt > 0 ? requestedAmt : (activeEsc || Number(order.amount || 0));
      const invTitle = (typeof req.body.invoiceTitle === 'string' && req.body.invoiceTitle.trim().length >= 3)
        ? req.body.invoiceTitle.trim().slice(0, 120)
        : `Final Invoice: ${order.title}`.slice(0, 120);
      const existingPendingInv = workstreamOffers.find(o => o.orderId === order.id && o.kind === 'invoice' && o.status === 'pending');
      if (existingPendingInv) {
        existingPendingInv.title = invTitle;
        existingPendingInv.amount = invAmt;
        existingPendingInv.note = trimmedNotes || existingPendingInv.note;
        existingPendingInv.files = uploadedFiles.length > 0 ? uploadedFiles : existingPendingInv.files;
        existingPendingInv.reference = storedReference || existingPendingInv.reference;
        await postgresStore.saveOffers(workstreamOffers);
        createdInvoiceOffer = viewOffer(existingPendingInv);
      } else if (invAmt > 0) {
        const newInv: WorkstreamOffer = {
          id: 'off_' + randomUUID().slice(0, 12),
          number: `INV-${String(workstreamOffers.filter(o => o.kind === 'invoice').length + 1001)}`,
          orderId: order.id,
          kind: 'invoice',
          title: invTitle,
          amount: invAmt,
          note: trimmedNotes || undefined,
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
          reference: storedReference || undefined,
          status: 'pending',
          createdBy: caller?.id || order.sellerId,
          createdAt: new Date().toISOString()
        };
        workstreamOffers.push(newInv);
        await postgresStore.saveOffers(workstreamOffers);
        postOfferMessage(order, newInv, { id: caller?.id || order.sellerId, name: caller?.name || 'Seller' }, `New invoice ${newInv.number}: ${invTitle}`, 'offer_created');
        createdInvoiceOffer = viewOffer(newInv);
      }
    }

    await postgresStore.saveOrders(orders);

    res.json({ success: true, files: uploadedFiles, file: uploadedFiles[0], offer: createdInvoiceOffer, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Request Revision on Deliverable
router.post('/orders/:id/revision', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = orderIndex.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    const caller = users.find(u => u.id === authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && order.buyerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only the order buyer or an administrator can request revisions.' });
    }

    const allowedRevisionStatuses = ['delivered', 'in_progress', 'funded_in_escrow', 'revision', 'draft_review', 'work_in_progress'];
    if (!allowedRevisionStatuses.includes(order.status)) {
      return res.status(409).json({ error: `Cannot request revisions for an order in "${order.status}" status.` });
    }

    const hasDelivery = (Array.isArray(order.deliverableFiles) && order.deliverableFiles.length > 0) || (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) || ['delivered', 'revision', 'draft_review', 'work_in_progress'].includes(order.status);
    if (!hasDelivery) {
      return res.status(409).json({ error: 'Cannot request revisions before work or a draft has been delivered by the freelancer.' });
    }

    const rawReason = (req.body.reason || '').trim();
    if (!rawReason) {
      return res.status(400).json({ error: 'A revision reason is required.' });
    }
    const reason = escapeHtml(rawReason);
    if (!order.revisions) order.revisions = [];
    const revisionEntry = {
      id: 'rev_' + Date.now() + '_' + randomUUID().slice(0, 8),
      requestedAt: new Date().toISOString(),
      reason,
      status: 'requested',
      deliveryVersion: order.deliveryHistory?.length || 1
    };
    order.revisions.push(revisionEntry);
    order.status = 'revision';

    await postgresStore.saveOrders(orders);

    emitSystemEvent(order.id, 'revision_requested', `Revision requested: "${reason}"`, {
      revisionId: revisionEntry.id,
      deliveryVersion: revisionEntry.deliveryVersion
    });

    res.json({ success: true, revision: revisionEntry, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Participant (Buyer or Seller) Dispute Creation Flow
router.post('/orders/:id/dispute', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = orderIndex.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    if (order.buyerId !== authUserId && order.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only order participants can open a dispute.' });
    }
    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(409).json({ error: `Cannot open a dispute: this order is already ${order.status}.` });
    }
    if (order.status === 'disputed') {
      return res.status(409).json({ error: 'This order is already under dispute.' });
    }
    const disputeEscrow = financeLedger.getEscrow(order.id);
    if (!disputeEscrow || disputeEscrow.status !== 'held' || disputeEscrow.remaining <= 0) {
      return res.status(409).json({ error: 'Cannot open a dispute: there is no active escrow held for this order.' });
    }
    const rawReason = (req.body.reason || '').trim().slice(0, 2000);
    if (!rawReason) {
      return res.status(400).json({ error: 'A dispute reason is required.' });
    }
    const reason = escapeHtml(rawReason);
    const existingDispute = disputes.find(d => d.orderId === order.id && (d.status === 'open' || d.status === 'under_investigation'));
    if (existingDispute) {
      return res.status(400).json({ error: 'An active dispute already exists for this order.' });
    }

    const newDispute: Dispute = {
      id: 'disp_' + Date.now() + '_' + randomUUID().slice(0, 8),
      orderId: order.id,
      raisedBy: authUserId === order.buyerId ? 'buyer' : 'seller',
      reason,
      evidence: escapeHtml((req.body.evidence || '').slice(0, 5000)),
      status: 'open',
      createdAt: new Date().toISOString()
    };
    disputes.push(newDispute);
    order.status = 'disputed';

    const sysMsg: Message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      orderId: order.id,
      senderId: 'system',
      senderName: 'WorkSphere Dispute Resolution Desk',
      text: `🚨 Dispute opened by ${newDispute.raisedBy}: "${reason}". Order placed under review.`,
      timestamp: new Date().toISOString(),
      type: 'system',
      metadata: {
        action: 'dispute_opened',
        disputeId: newDispute.id,
        raisedBy: newDispute.raisedBy
      }
    };
    recordMessage(sysMsg);
    postgresStore.saveMessages(messages);
    postgresStore.saveOrders(orders);
    postgresStore.saveDisputes(disputes);
    broadcastMessage(sysMsg, order.id);
    notifyOrderParties(order.id, 'dispute_opened', sysMsg.text, sysMsg.id);

    res.json({ success: true, dispute: newDispute, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Toggle Chat Mute (Admin / Support)
router.patch('/orders/:id/mute', requireRole(['admin', 'super_admin', 'support']), async (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.isMuted = !order.isMuted;
  await postgresStore.saveOrders(orders);
  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'Administration Alert',
    text: order.isMuted 
      ? `🔒 Chat paused by Administrator during case review. Neither party may send messages.`
      : `🔓 Chat unlocked by Administrator. Standard messaging resumed.`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { action: order.isMuted ? 'chat_muted' : 'chat_unmuted' }
  };
  recordMessage(sysMsg);
  await postgresStore.saveMessages(messages);
  broadcastMessage(sysMsg, order.id);

  res.json({ success: true, isMuted: order.isMuted });
});

// Toggle Pause Order Timer (Admin / Support)
router.patch('/orders/:id/pause-timer', requireRole(['admin', 'super_admin', 'support']), async (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.isTimerPaused = !order.isTimerPaused;
  await postgresStore.saveOrders(orders);
  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'Administration Alert',
    text: order.isTimerPaused 
      ? `⏸️ Delivery countdown paused by Administrator pending dispute/clarification.`
      : `▶️ Delivery countdown resumed by Administrator. Normal timer active.`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { action: order.isTimerPaused ? 'timer_paused' : 'timer_resumed' }
  };
  recordMessage(sysMsg);
  postgresStore.saveMessages(messages);
  broadcastMessage(sysMsg, order.id);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: order.isTimerPaused ? 'ORDER_TIMER_PAUSED' : 'ORDER_TIMER_RESUMED',
    target: `Order #${order.id}`,
    details: order.isTimerPaused ? 'Timer paused by Admin' : 'Timer resumed by Admin',
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, isTimerPaused: order.isTimerPaused, order: enrichOrderWithServiceInfo(order) });
});

// Force Complete & Release Funds (admin only)
router.post('/orders/:id/force-complete', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = orderIndex.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Order is already completed; funds were already released.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot force-complete a cancelled/refunded order.' });
    }
    const reason = String(req.body.reason || 'Admin administrative force-release in seller favor.');
    const result = await releaseOrderFunds(order, adminActor(req), reason, false, req.body.requestKey);
    closeActiveDispute(order.id, 'resolved_release', reason);
    res.json({ success: true, order: enrichOrderWithServiceInfo(order), result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Force Cancel & Refund Buyer (admin only)
router.post('/orders/:id/force-cancel', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    console.log('force-cancel ID:', req.params.id, 'Order found:', !!orderIndex.get(req.params.id));
    const order = orderIndex.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot force-cancel an already completed order.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order is already cancelled/refunded.' });
    }
    const reason = String(req.body.reason || 'Admin cancelled order and refunded buyer wallet');
    const isPartial = req.body.refundType === 'partial';
    let result: any;
    let refundAmount: number;
    if (isPartial) {
      refundAmount = Number(req.body.customAmount);
      result = splitOrderFunds(order, refundAmount, adminActor(req), reason);
      closeActiveDispute(order.id, 'resolved_partial', reason);
      pushSystemMessage(order.id, `⚖️ Order resolved by Administration. $${refundAmount} refunded to buyer; the remainder was released to the freelancer. Reason: ${reason}`, 'dispute_resolved');
    } else {
      result = await refundOrderFunds(order, undefined, adminActor(req), reason, req.body.requestKey);
      refundAmount = result.refunded;
      closeActiveDispute(order.id, 'resolved_refund', reason);
    }
    res.json({ success: true, order: enrichOrderWithServiceInfo(order), result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Gig Cancellation Request
router.post('/orders/:id/cancel-request', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const caller = users.find(u => u.id === userId);
    const order = orderIndex.get(orderId) || orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.orderType !== 'gig' && !order.gigOrderId) {
      return res.status(400).json({ error: 'Cancellation request flow is for gigs only.' });
    }
    if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'disputed') {
      return res.status(400).json({ error: `Cannot request cancellation for order in status "${order.status}".` });
    }
    const isBuyer = userId === order.buyerId;
    const isSeller = userId === order.sellerId;
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Forbidden: Only buyer or seller can request cancellation.' });
    }
    if (order.cancellationRequest && order.cancellationRequest.status === 'pending') {
      return res.status(409).json({ error: 'A cancellation request is already pending for this order.' });
    }

    const { reason, details } = req.body;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'Cancellation reason is required.' });
    }

    const now = new Date().toISOString();
    const respondBy = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const requestedBy = isBuyer ? 'buyer' : 'seller';

    order.cancellationRequest = {
      requestedBy,
      requesterId: userId,
      reason: reason.trim(),
      details: details ? String(details).trim() : undefined,
      requestedAt: now,
      respondBy,
      status: 'pending'
    };
    if (!order.cancellationHistory) order.cancellationHistory = [];
    order.cancellationHistory.push(order.cancellationRequest);

    postgresStore.saveOrders(orders);

    const recipientId = isBuyer ? order.sellerId : order.buyerId;
    createNotification({
      userId: recipientId,
      title: 'Cancellation Requested',
      message: `${requestedBy === 'buyer' ? 'Buyer' : 'Seller'} requested cancellation of order #${order.id}. Reason: ${reason}. You have 48 hours to respond.`,
      type: 'order',
      link: `/messages/${order.id}`
    });

    const requestsLast24h = (order.cancellationHistory || []).filter(h => Date.now() - new Date(h.requestedAt).getTime() < 24 * 3600 * 1000).length;
    if (requestsLast24h <= 2) {
      sendOrderEmail(
        recipientId,
        'Action needed: cancellation requested on your order',
        `${requestedBy === 'buyer' ? 'The buyer' : 'The seller'} asked to cancel order #${order.id}.\n\nReason: ${String(reason).trim().slice(0, 300)}\n\nYou have 48 hours to accept or decline. If you do not respond, the order is cancelled automatically and the payment is refunded.`,
        `/messages/${order.id}`
      );
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller?.name || requestedBy,
      role: caller?.role || requestedBy,
      action: 'GIG_CANCELLATION_REQUESTED',
      target: `Order #${order.id}`,
      details: `${requestedBy} requested cancellation. Reason: ${reason}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Respond to Gig Cancellation Request
router.post('/orders/:id/cancel-request/respond', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const caller = users.find(u => u.id === userId);
    const order = orderIndex.get(orderId) || orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.cancellationRequest || order.cancellationRequest.status !== 'pending') {
      return res.status(400).json({ error: 'No pending cancellation request found for this order.' });
    }

    const isBuyer = userId === order.buyerId;
    const isSeller = userId === order.sellerId;
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (userId === order.cancellationRequest.requesterId) {
      return res.status(403).json({ error: 'You cannot respond to your own cancellation request.' });
    }

    const { action, reason } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be "accept" or "reject".' });
    }
    if (action === 'reject' && (!reason || !String(reason).trim())) {
      return res.status(400).json({ error: 'Rejection reason is required when rejecting a cancellation request.' });
    }

    const now = new Date().toISOString();
    order.cancellationRequest.respondedBy = userId;
    order.cancellationRequest.respondedAt = now;

    if (action === 'accept') {
      const actorName = caller?.name || (isBuyer ? 'Buyer' : 'Seller');
      const requestKey = `cancel_accept_${order.id}_${order.cancellationRequest.requestedAt}`;
      const refundRes = await refundOrderFunds(order, undefined, actorName, `Mutual cancellation accepted: ${order.cancellationRequest.reason}`, requestKey);
      order.cancellationRequest.status = 'accepted';
      
      createNotification({
        userId: order.cancellationRequest.requesterId,
        title: 'Cancellation Accepted',
        message: `Your cancellation request for order #${order.id} was accepted. Full refund issued ($${refundRes.refunded}).`,
        type: 'order',
        link: `/messages/${order.id}`
      });

      registerAuditLog({
        id: 'log_' + Date.now(),
        actor: actorName,
        role: caller?.role || 'user',
        action: 'GIG_CANCELLATION_ACCEPTED',
        target: `Order #${order.id}`,
        details: `Cancellation accepted. Full refund of $${refundRes.refunded} issued.`,
        timestamp: new Date().toLocaleString()
      });

      return res.json({ success: true, order: enrichOrderWithServiceInfo(order), refunded: refundRes.refunded });
    } else {
      order.cancellationRequest.status = 'rejected';
      order.cancellationRequest.rejectionReason = String(reason).trim();
      if (order.status === 'delivered') {
        order.reviewWindowRestartedAt = now;
      }
      postgresStore.saveOrders(orders);

      const actorName = caller?.name || (isBuyer ? 'Buyer' : 'Seller');
      createNotification({
        userId: order.cancellationRequest.requesterId,
        title: 'Cancellation Rejected',
        message: `Your cancellation request for order #${order.id} was rejected. Reason: ${reason}. Order continues normally.`,
        type: 'order',
        link: `/messages/${order.id}`
      });

      registerAuditLog({
        id: 'log_' + Date.now(),
        actor: actorName,
        role: caller?.role || 'user',
        action: 'GIG_CANCELLATION_REJECTED',
        target: `Order #${order.id}`,
        details: `Cancellation rejected. Reason: ${reason}`,
        timestamp: new Date().toLocaleString()
      });

      return res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

export default router;
