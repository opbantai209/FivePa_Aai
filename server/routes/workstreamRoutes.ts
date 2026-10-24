import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  orders,
  users,
  messages,
  proposals,
  workstreamOffers,
  workstreamUploadIndex,
  saveWorkstreamUploadIndex,
  type Order,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { financeLedger, FinanceLedgerEngine } from '../../src/server/financeLedger.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import {
  requireAuth,
  requireActiveStatus,
  rateLimit,
  isStaffUser,
  canAccessOrderWorkstream
} from '../middleware/auth.js';
import {
  orderIndex,
  tryAcquireOrderLock,
  releaseOrderLock,
  recordOrder,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  fundOrderEscrowWithEvent,
  topUpOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  validateOrderReleasePreconditions,
  getActiveEscrowRemaining
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from '../services/notificationService.js';
import {
  recordMessage,
  messageIndex,
  sanitizeAndCreateMessage,
  emitSystemEvent
} from '../services/messagingService.js';
import { uploadFileToCloudStorage, openCloudFileStream } from '../cloudStorage.js';
import {
  WORKSTREAM_UPLOADS_DIR,
  WORKSTREAM_FILE_URL_PREFIX,
  workstreamFileExists,
  WORKSTREAM_MAX_UPLOAD_BYTES,
  WORKSTREAM_INLINE_EXTENSIONS,
  OFFER_LABEL,
  OFFER_PREFIX,
  orderHasEscrow,
  hasPaidInvoiceOrReleasedEscrow,
  findLinkedProposalForOffer,
  viewOffer,
  postOfferMessage,
  offerCaller,
  canAccessWorkstreamFile,
  validateMessageFileInfo,
  validateStoredWorkstreamFiles
} from '../services/workstreamService.js';

function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const router = Router();

// ==========================================
// FILE UPLOAD AND SERVING
// ==========================================

router.post(
  '/workstream/upload',
  requireAuth,
  rateLimit(5, 60_000),
  express.raw({ type: '*/*', limit: WORKSTREAM_MAX_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    try {
      const caller = (req as any).authenticatedUser;
      const rawName = (req.query.name as string) || 'attachment';
      let decodedName: string;
      try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
      const safeBase = path.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const ext = path.extname(safeBase).toLowerCase();
      const nameWithoutExt = path.basename(safeBase, path.extname(safeBase));
      const storedFilename = `${Date.now()}_${randomUUID().slice(0, 8)}_${nameWithoutExt}${ext}`;

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'No file data received' });
      }
      if (buffer.length > WORKSTREAM_MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: 'File is too large (25 MB maximum).' });
      }

      const mimeType = (req.headers['content-type'] as string) || 'application/octet-stream';
      await uploadFileToCloudStorage(storedFilename, buffer, mimeType);
      const fileUrl = `${WORKSTREAM_FILE_URL_PREFIX}${storedFilename}`;

      workstreamUploadIndex[storedFilename] = {
        ownerId: caller.id,
        originalName: safeBase,
        mime: mimeType,
        size: buffer.length,
        createdAt: new Date().toISOString()
      };
      saveWorkstreamUploadIndex();

      const bytes = buffer.length;
      const sizeStr = bytes > 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;

      res.json({
        name: safeBase,
        size: sizeStr,
        url: fileUrl,
        type: mimeType
      });
    } catch (err: any) {
      console.error('Workstream file upload error:', err);
      res.status(500).json({ error: 'Failed to save uploaded file' });
    }
  }
);

router.get('/workstream/files/:filename', requireAuth, (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WORKSTREAM_UPLOADS_DIR, filename);
  const localExists = fs.existsSync(filePath);
  if (!localExists && !workstreamUploadIndex[filename]) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!canAccessWorkstreamFile((req as any).authenticatedUser, filename)) {
    return res.status(403).json({ error: 'Forbidden: You do not have access to this file.' });
  }

  const parts = filename.split('_');
  const originalName = parts.length > 2 ? parts.slice(2).join('_') : filename;
  const ext = path.extname(filename).toLowerCase();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Frame-Options', 'DENY');

  const isPotentiallyActive = ['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs'].includes(ext);
  if (isPotentiallyActive) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  }

  const forceDownload = req.query.download === '1' || !WORKSTREAM_INLINE_EXTENSIONS.has(ext) || ext === '.html' || ext === '.htm';
  if (!localExists) {
    if (forceDownload) res.attachment(originalName); else res.type(ext);
    const stream = openCloudFileStream(filename, (req as any).authenticatedUser, canAccessWorkstreamFile);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File not found' }); else res.end(); });
    return void stream.pipe(res);
  }

  if (forceDownload) {
    return res.download(filePath, originalName);
  }

  res.sendFile(filePath);
});

// ==========================================
// MESSAGES
// ==========================================

router.get('/messages/:orderId', requireAuth, (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrderWorkstream((req as any).authenticatedUser, order)) {
    return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
  }
  const filtered = messageIndex.get(req.params.orderId) || [];
  res.json(filtered);
});

router.post('/messages', requireAuth, rateLimit(120, 60_000), (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
  if (!caller) return res.status(401).json({ error: 'User not found' });
  const orderId = req.body.orderId;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

  let order = orderIndex.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  if (caller.status === 'suspended' && !orderId.startsWith('support_admin_')) {
    return res.status(403).json({ error: 'Action forbidden: Your account is suspended. You can only message Support.' });
  }

  if (!canAccessOrderWorkstream(caller, order)) {
    return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
  }
  const fileCheck = validateMessageFileInfo(req.body.fileInfo, caller);
  if (!fileCheck.ok) return res.status(400).json({ error: (fileCheck as any).error });

  const clientMessageId = typeof req.body.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
  if (clientMessageId) {
    const existing = messages.find(m => m.orderId === orderId && m.metadata?.clientMessageId === clientMessageId);
    if (existing) return res.json({ success: true, message: existing, deduplicated: true });
  }

  try {
    const newMsg = sanitizeAndCreateMessage(caller, order, req.body, fileCheck);

    recordMessage(newMsg);
    postgresStore.saveMessages(messages);
    broadcastMessage(newMsg, order.id);

    const otherUserId = order.buyerId === caller.id ? order.sellerId : order.buyerId;
    createNotification({
      userId: otherUserId,
      type: 'message',
      title: 'New Message',
      message: `${caller.name} sent a message regarding order "${order.title}".`,
      link: `/messages/${order.id}`,
      dedupKey: `msg_${newMsg.id}`,
      actorId: caller.id
    });

    res.json(newMsg);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send message' });
  }
});

router.post('/orders/:id/message', requireAuth, rateLimit(120, 60_000), async (req: Request, res: Response) => {
  const order = orderIndex.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const userId = (req as any).authenticatedUserId;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!canAccessOrderWorkstream(user, order)) {
    return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
  }
  if (order.isMuted && !isStaffUser(user)) {
    return res.status(403).json({ error: 'Chat is currently paused.' });
  }
  const fileCheck = validateMessageFileInfo(req.body.fileInfo, user);
  if (!fileCheck.ok) return res.status(400).json({ error: (fileCheck as any).error });

  const clientMessageId = typeof req.body.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
  if (clientMessageId) {
    const existing = messages.find(m => m.orderId === order.id && m.metadata?.clientMessageId === clientMessageId);
    if (existing) return res.json({ success: true, message: existing, deduplicated: true });
  }

  try {
    const newMsg = sanitizeAndCreateMessage(user, order, req.body, fileCheck);

    recordMessage(newMsg);
    await postgresStore.saveMessages(messages);
    broadcastMessage(newMsg, order.id);

    res.json({ success: true, message: newMsg });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send message' });
  }
});

// ==========================================
// WORKSTREAM OFFERS (PROPOSALS, INVOICES, DEPOSITS)
// ==========================================

router.get('/offers', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const userOrders = orders.filter(o => o.buyerId === authUserId || o.sellerId === authUserId);
  const userOrderIds = new Set(userOrders.map(o => o.id));
  const userOffers = workstreamOffers.filter(of => userOrderIds.has(of.orderId));
  res.json(userOffers.map(viewOffer));
});

router.get('/orders/:id/offers', requireAuth, (req: Request, res: Response) => {
  const caller = offerCaller(req);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });
  const offers = workstreamOffers
    .filter(o => o.orderId === order.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(viewOffer);
  const esc = financeLedger.getEscrow(order.id);
  res.json({
    offers,
    currencySymbol: siteSettings.getFlattenedSettings().currencySymbol || '$',
    escrowFunded: orderHasEscrow(order.id),
    escrowRemaining: getActiveEscrowRemaining(order),
    totalReleased: esc ? esc.releasedGross : (order.status === 'completed' ? Number(order.amount || 0) : 0),
    hasPaidInvoice: hasPaidInvoiceOrReleasedEscrow(order)
  });
});

router.post('/orders/:id/offers', requireAuth, requireActiveStatus, rateLimit(20, 60_000), (req: Request, res: Response) => {
  try {
    const caller = offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    const order = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (caller.id !== order.sellerId) return res.status(403).json({ error: 'Only the seller of this workstream can send this.' });
    if (order.status === 'cancelled' && order.orderType !== 'gig' && !order.gigOrderId) return res.status(409).json({ error: 'Cannot send offers on a cancelled order.' });

    const kind = req.body?.kind as WorkstreamOfferKind;
    if (!['proposal', 'invoice', 'deposit'].includes(kind)) return res.status(400).json({ error: 'Invalid type.' });

    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const minAmount = Number(siteSettings.getFlattenedSettings().minOrderAmount) || 0;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
    if (amount > 100000) return res.status(400).json({ error: 'Amount is too large.' });
    if (amount < minAmount) return res.status(400).json({ error: `Minimum amount is ${siteSettings.getFlattenedSettings().currencySymbol || '$'}${minAmount}.` });

    const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = kind === 'deposit' ? (rawTitle || 'Escrow deposit') : rawTitle;
    if (title.length < 3 || title.length > 120) return res.status(400).json({ error: 'Title must be 3-120 characters.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
    const rawRef = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 2000) : '';
    let deliveryDays: number | undefined;
    if (kind === 'proposal') {
      deliveryDays = Math.round(Number(req.body?.deliveryDays));
      if (!Number.isFinite(deliveryDays) || deliveryDays < 1 || deliveryDays > 365) return res.status(400).json({ error: 'Delivery time must be 1-365 days.' });
    }

    const funded = orderHasEscrow(order.id);
    const activeEscrow = getActiveEscrowRemaining(order);
    const hasPaidFirstInvoice = hasPaidInvoiceOrReleasedEscrow(order);

    if (kind === 'invoice') {
      if (!funded || activeEscrow <= 0) return res.status(400).json({ error: 'Final invoices are for completed work on a funded workstream.' });
      if (activeEscrow > 0 && amount < activeEscrow) {
        return res.status(400).json({ error: `Final invoice amount cannot be less than the funded escrow price ($${activeEscrow}).` });
      }
      if (workstreamOffers.filter(o => o.orderId === order.id && o.kind === 'invoice' && o.status === 'pending').length >= 1) {
        return res.status(409).json({ error: 'A final invoice is already pending for this workstream.' });
      }
    } else if (kind === 'proposal' || kind === 'deposit') {
      if (workstreamOffers.some(o => o.orderId === order.id && o.kind === 'invoice' && o.status === 'pending')) {
        return res.status(409).json({ error: 'A seller must not raise a new proposal when a previous proposal/order has a pending invoice.' });
      }
      if ((order.orderType === 'gig' || (order.gigId && !order.projectId)) && activeEscrow > 0 && !hasPaidFirstInvoice) {
        return res.status(409).json({ error: 'This Gig is already funded in escrow. Please raise and get your first invoice paid before sending a follow-on proposal.' });
      }
    }

    let uploadedFiles: Array<{ id: string; name: string; size: string; url: string; uploadedAt: string; type: string }> = [];
    if (kind === 'invoice' && Array.isArray(req.body?.files) && req.body.files.length > 0) {
      const validation = validateStoredWorkstreamFiles(req.body.files, caller);
      if (!validation.ok) {
        return res.status(400).json({ error: (validation as any).error });
      }
      uploadedFiles = validation.files.map((f: any, idx: number) => ({
        id: 'deliv_' + Date.now() + '_' + idx,
        name: f.name,
        size: f.size,
        url: f.url,
        uploadedAt: new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
        type: 'deliverable'
      }));
    }

    const responseDeadline = (order.orderType === 'project' && kind === 'invoice')
      ? new Date(Date.now() + 7 * 86400000).toISOString()
      : undefined;

    const offer: WorkstreamOffer = {
      id: 'off_' + randomUUID().slice(0, 12),
      number: `${OFFER_PREFIX[kind]}-${String(workstreamOffers.filter(o => o.kind === kind).length + 1001)}`,
      orderId: order.id,
      kind,
      title,
      amount,
      deliveryDays,
      note: note || undefined,
      files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
      reference: rawRef || undefined,
      responseDeadline,
      status: 'pending',
      createdBy: caller.id,
      createdAt: new Date().toISOString()
    };
    workstreamOffers.push(offer);
    postgresStore.saveOffers(workstreamOffers);

    if (order.orderType === 'project' && kind === 'invoice') {
      createNotification({
        userId: order.buyerId,
        type: 'invoice_received',
        title: 'Invoice received',
        message: `You received an invoice of $${offer.amount} for "${order.title}". Please review within 7 days.`,
        link: `/workstream/${order.id}`,
        metadata: { orderId: order.id, offerId: offer.id }
      });
    } else if (order.orderType === 'project' && kind === 'proposal') {
      createNotification({
        userId: order.buyerId,
        type: 'proposal_received',
        title: 'Proposal received',
        message: `You received a proposal of $${offer.amount} for "${order.title}".`,
        link: `/workstream/${order.id}`,
        metadata: { orderId: order.id, offerId: offer.id }
      });
    }

    if (kind === 'invoice' && (req.body?.deliverWork || note || uploadedFiles.length > 0 || rawRef)) {
      if (!order.deliverableFiles) order.deliverableFiles = [];
      if (!order.deliveryHistory) order.deliveryHistory = [];
      if (uploadedFiles.length > 0) order.deliverableFiles.push(...uploadedFiles);
      const version = order.deliveryHistory.length + 1;
      const sanitizedNotes = note ? escapeHtml(note) : escapeHtml(title);
      order.deliveryNotes = sanitizedNotes;
      if (rawRef) order.deliveryReference = rawRef;
      order.deliveryHistory.push({
        version,
        notes: sanitizedNotes,
        reference: rawRef || undefined,
        files: uploadedFiles,
        deliveredAt: new Date().toISOString()
      });
      order.status = 'delivered';
      if (Array.isArray(order.revisions)) {
        for (const rev of order.revisions) {
          if (rev.status === 'requested') rev.status = 'resolved';
        }
      }
      postgresStore.saveOrders(orders);
    }

    postOfferMessage(order, offer, { id: caller.id, name: caller.name }, `New ${OFFER_LABEL[kind]} ${offer.number}: ${title}`, 'offer_created');
    res.status(201).json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/offers/:id/:action(accept|decline|cancel)', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const offer = workstreamOffers.find(o => o.id === req.params.id);
  const order = offer ? orders.find(o => o.id === offer.orderId) : undefined;
  if (!offer || !order) return res.status(404).json({ error: 'Not found' });

  if (!tryAcquireOrderLock(order.id, res)) return;
  try {
    const caller = offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });
    if (offer.status !== 'pending') {
      if (offer.status === 'accepted' || offer.status === 'paid') {
        const associatedOrder = offer.orderId ? orders.find(o => o.id === offer.orderId) : order;
        if (associatedOrder) {
          return res.json({ 
            offer: viewOffer(offer), 
            order: enrichOrderWithServiceInfo(associatedOrder) 
          });
        }
      }
      return res.status(409).json({ error: `This ${OFFER_LABEL[offer.kind]} is already ${offer.status}.` });
    }

    const action = req.params.action;
    const now = new Date().toISOString();

    if (action === 'cancel') {
      if (caller.id !== order.sellerId) return res.status(403).json({ error: 'Only the seller can cancel this.' });
      offer.status = 'cancelled'; offer.resolvedAt = now; offer.resolvedBy = caller.id;
      if (offer.kind === 'proposal') {
        const linkedProp = findLinkedProposalForOffer(offer, order);
        if (linkedProp && linkedProp.status === 'pending') {
          linkedProp.status = 'rejected';
          await postgresStore.saveProposals(proposals);
        }
      }
      if (offer.kind === 'invoice' && (order.status === 'delivered' || order.status === 'draft_review')) {
        const otherPendingInvoice = workstreamOffers.some(o => o.orderId === order.id && o.id !== offer.id && o.kind === 'invoice' && o.status === 'pending');
        if (!otherPendingInvoice && orderHasEscrow(order.id)) {
          order.status = 'in_progress';
          await postgresStore.saveOrders(orders);
        }
      }
      await postgresStore.saveOffers(workstreamOffers);
      postOfferMessage(order, offer, null, `${offer.number} was cancelled by the seller.`, 'offer_cancelled');
      if (order.orderType === 'project') {
        createNotification({
          userId: order.buyerId,
          type: offer.kind === 'invoice' ? 'invoice_cancelled' : 'proposal_cancelled',
          title: `${OFFER_LABEL[offer.kind]} cancelled`,
          message: `The ${offer.kind} for "${order.title}" was cancelled by the seller.`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id }
        });
      }
      return res.json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
    }

    if (caller.id !== order.buyerId) return res.status(403).json({ error: 'Only the buyer can respond to this.' });

    if (order.orderType === 'project' && (order.status === 'completed' || order.status === 'cancelled') && offer.kind !== 'proposal') {
      return res.status(400).json({ error: `Cannot accept ${offer.kind} on a ${order.status} project order.` });
    }
    if (order.status === 'cancelled' && order.orderType !== 'gig' && !order.gigOrderId && offer.kind !== 'proposal') {
      return res.status(400).json({ error: 'Cannot accept offers on a cancelled order (escrow has already been refunded).' });
    }
    if (order.status === 'completed' && offer.kind === 'invoice') {
      return res.status(400).json({ error: 'Cannot accept an invoice on a completed order (escrow has already been released).' });
    }

    if (action === 'decline') {
      if (order.orderType === 'project' && offer.kind === 'invoice') {
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
        if (!reason) {
          return res.status(400).json({ error: 'A reason is required when rejecting a project invoice.' });
        }
        offer.rejectionReason = reason;
        offer.rejectedBy = caller.id;
        offer.rejectedAt = now;
        order.status = 'in_progress';
        await postgresStore.saveOrders(orders);
        createNotification({
          userId: order.sellerId,
          type: 'invoice_rejected',
          title: 'Invoice rejected',
          message: `Your invoice for "${order.title}" was rejected. Reason: ${reason}`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id, reason }
        });
      }

      offer.status = 'declined'; offer.resolvedAt = now; offer.resolvedBy = caller.id;
      if (offer.kind === 'proposal') {
        const linkedProp = findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          linkedProp.status = 'rejected';
          await postgresStore.saveProposals(proposals);
        }
        if (order.orderType === 'project') {
          createNotification({
            userId: order.sellerId,
            type: 'proposal_declined',
            title: 'Proposal declined',
            message: `Your proposal "${offer.title}" was declined by the buyer.`,
            link: `/workstream/${order.id}`,
            metadata: { orderId: order.id, offerId: offer.id }
          });
        }
      } else if (offer.kind === 'invoice' && order.orderType !== 'project' && (order.status === 'delivered' || order.status === 'draft_review')) {
        const otherPendingInvoice = workstreamOffers.some(o => o.orderId === order.id && o.id !== offer.id && o.kind === 'invoice' && o.status === 'pending');
        if (!otherPendingInvoice && orderHasEscrow(order.id)) {
          order.status = 'revision';
          postgresStore.saveOrders(orders);
        }
      }
      await postgresStore.saveOffers(workstreamOffers);
      postOfferMessage(order, offer, null, `${offer.number} was declined by the buyer.${offer.rejectionReason ? ` Reason: ${offer.rejectionReason}` : ''}`, 'offer_declined');
      return res.json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
    }

    // accept: real money movement through the ledger
    ensureWallet(order.buyerId); ensureWallet(order.sellerId);
    const today = now.split('T')[0];
    const protectionEnd = new Date(Date.now() + siteSettings.getSettings().commission.escrowProtectionDays * 86400000).toISOString().split('T')[0];
    const isInitialFunding = !orderHasEscrow(order.id);
    const isFollowOnAfterCompletion = orderHasEscrow(order.id) && (order.status === 'completed' || getActiveEscrowRemaining(order) === 0);
    const isCancelledGigFollowOn = order.status === 'cancelled' && (order.orderType === 'gig' || order.gigOrderId);

    if (offer.kind === 'invoice') {
      const validationError = validateOrderReleasePreconditions(order, false, true);
      if (validationError) {
        return res.status(validationError.status).json({ error: validationError.error });
      }

      const esc = financeLedger.getEscrow(order.id);
      const currentEscrow = esc ? esc.remaining : Number(order.amount || 0);
      const invoiceAmount = Number(offer.amount);
      const additionalAmount = FinanceLedgerEngine.round(invoiceAmount - currentEscrow);

      if (additionalAmount < 0) {
        return res.status(400).json({ error: `Final invoice amount ($${invoiceAmount}) cannot be less than the current order escrow ($${currentEscrow}).` });
      }

      if (additionalAmount > 0) {
        topUpOrderEscrowWithEvent({
          orderId: order.id,
          orderTitle: `Invoice Top-up: ${offer.title}`,
          amount: additionalAmount,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          actor: `user:${order.buyerId}`
        });
        order.amount = invoiceAmount;
        order.feeBreakdown = financeLedger.quoteOrder(order.amount);
      }

      let invoiceRevisionsResolved = false;
      if (Array.isArray(order.revisions)) {
        for (const rev of order.revisions) {
          if (rev.status === 'requested') {
            rev.status = 'resolved';
            invoiceRevisionsResolved = true;
          }
        }
      }
      if (invoiceRevisionsResolved) {
        emitSystemEvent(order.id, 'revision_resolved', `📝 Revision resolved via accepted invoice ${offer.number}.`);
      }

      await releaseOrderFunds(order, caller.name, `Final invoice ${offer.number} accepted by buyer and escrow released`, false);

      offer.status = 'paid';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (order.orderType === 'project') {
        createNotification({
          userId: order.sellerId,
          type: 'invoice_paid',
          title: 'Invoice paid',
          message: `Invoice ${offer.number} for "${order.title}" ($${invoiceAmount}) was approved and paid.`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id, amount: invoiceAmount }
        });
      }

      syncUserBalances();
      await postgresStore.saveOffers(workstreamOffers);
      await postgresStore.saveOrders(orders);
      await postgresStore.saveMessages(messages);
      const completionNote = additionalAmount > 0
        ? `${offer.number} ($${invoiceAmount.toLocaleString()}) was paid (+$${additionalAmount.toLocaleString()} funded from wallet) and full escrow ($${invoiceAmount.toLocaleString()}) was released to the seller. Order completed!`
        : `${offer.number} was accepted and escrow funds ($${invoiceAmount.toLocaleString()}) were released to the seller. Order completed!`;
      postOfferMessage(order, offer, null, completionNote, 'offer_paid');
      return res.json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(order) });

    } else if (isInitialFunding) {
      if (order.status === 'funded_in_escrow' || orderHasEscrow(order.id)) {
        return res.status(409).json({ error: 'Order escrow is already funded.' });
      }
      if (order.status !== 'in_progress' && order.status !== 'payment_pending') {
        return res.status(409).json({ error: 'Cannot fund escrow for order in current status.' });
      }
      const newTitle = offer.kind === 'proposal' && (/^inquiry:/i.test(order.title) || !order.amount) ? offer.title : order.title;
      const prevStatus = order.status;
      order.previousStatus = prevStatus;
      order.status = 'payment_pending';
      await postgresStore.saveOrders(orders);

      try {
        await fundOrderEscrowWithEvent({ orderId: order.id, orderTitle: newTitle, amount: offer.amount, buyerId: order.buyerId, sellerId: order.sellerId, actor: `user:${order.buyerId}` });
        order.title = newTitle;
        order.amount = offer.amount;
        order.status = 'funded_in_escrow';
        order.escrowProtectionStartDate = today;
        order.escrowProtectionEndDate = protectionEnd;
        order.feeBreakdown = financeLedger.quoteOrder(offer.amount);
        if (offer.kind === 'proposal' && offer.deliveryDays) {
          order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString().split('T')[0];
        }
        offer.orderId = order.id;
        offer.status = 'accepted';
        if (offer.kind === 'proposal') {
          const linkedProp = findLinkedProposalForOffer(offer, order);
          if (linkedProp) {
            linkedProp.status = 'accepted';
            linkedProp.workstreamOrderId = order.id;
            linkedProp.offerId = offer.id;
            order.proposalId = linkedProp.id;
            await postgresStore.saveProposals(proposals);
          }
        }
        await postgresStore.saveOrders(orders);
        postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was funded ($${offer.amount}).`, 'offer_accepted');
      } catch (fundingErr: any) {
        order.status = prevStatus;
        await postgresStore.saveOrders(orders);
        return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for offer.' });
      }
    } else if (isFollowOnAfterCompletion || isCancelledGigFollowOn || (order.orderType === 'project' && (order.status === 'completed' || order.status === 'cancelled') && offer.kind === 'proposal')) {
      const newOrderId = 'ord_' + randomUUID().slice(0, 12);
      const isGigFollowOn = order.orderType === 'gig' || (Boolean(order.gigId) && !order.projectId);
      const orderType: 'gig' | 'project' = isGigFollowOn ? 'gig' : 'project';
      const gigOrderId = orderType === 'gig' ? newOrderId : undefined;
      const projectOrderId = orderType === 'project' ? newOrderId : undefined;

      const newOrder: Order = {
        id: newOrderId,
        workspaceId: order.workspaceId,
        orderType,
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title: offer.title,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amount: offer.amount,
        status: 'payment_pending',
        createdAt: today,
        dueDate: offer.kind === 'proposal' && offer.deliveryDays
          ? new Date(Date.now() + offer.deliveryDays * 86400000).toISOString().split('T')[0]
          : new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: protectionEnd,
        feeBreakdown: financeLedger.quoteOrder(offer.amount),
        projectId: order.projectId,
        gigId: order.gigId
      };

      const enrichedOrder = enrichOrderWithServiceInfo(newOrder);
      recordOrder(enrichedOrder);
      await postgresStore.saveOrders(orders);
      emitSystemEvent(newOrder.id, 'order_created', `Order placed: ${newOrder.title}. Payment is held in escrow until the work is approved.`);

      try {
        await fundOrderEscrowWithEvent({
          orderId: newOrder.id,
          orderTitle: newOrder.title,
          amount: newOrder.amount,
          buyerId: newOrder.buyerId,
          sellerId: newOrder.sellerId,
          actor: `user:${newOrder.buyerId}`
        });
        
        enrichedOrder.status = 'funded_in_escrow';
        await postgresStore.saveOrders(orders);
        
        syncUserBalances();
      } catch (fundingErr: any) {
        const orderIdx = orders.findIndex(o => o.id === newOrder.id);
        if (orderIdx !== -1) orders.splice(orderIdx, 1);
        orderIndex.delete(newOrder.id);

        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].orderId === newOrder.id) {
            messages.splice(i, 1);
          }
        }

        await postgresStore.saveOrders(orders);
        await postgresStore.saveMessages(messages);
        return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for follow-on order.' });
      }

      offer.orderId = newOrder.id;
      offer.status = 'accepted';

      if (orderType === 'project') {
        createNotification({
          userId: newOrder.sellerId,
          type: 'proposal_accepted',
          title: 'Follow-on proposal accepted',
          message: `Your follow-on proposal "${offer.title}" was accepted and escrow has been funded.`,
          link: `/workstream/${newOrderId}`,
          metadata: { orderId: newOrderId, offerId: offer.id }
        });
      }

      postOfferMessage(enrichedOrder, offer, null, `Follow-on ${OFFER_LABEL[offer.kind]} ${offer.number} ("${offer.title}") was accepted and $${offer.amount.toLocaleString()} was funded into escrow in a new Order (#${newOrderId}).`, 'offer_accepted');
      return res.json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(enrichedOrder) });
    } else {
      await topUpOrderEscrowWithEvent({
        orderId: order.id,
        orderTitle: offer.title,
        amount: offer.amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`
      });
      order.amount = FinanceLedgerEngine.round(Number(order.amount || 0) + offer.amount);
      order.feeBreakdown = financeLedger.quoteOrder(order.amount);
      if (offer.kind === 'proposal' && offer.deliveryDays) {
        order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString().split('T')[0];
      }
      offer.orderId = order.id;
      offer.status = 'accepted';
      if (offer.kind === 'proposal') {
        const linkedProp = findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          linkedProp.status = 'accepted';
          linkedProp.workstreamOrderId = order.id;
          linkedProp.offerId = offer.id;
          await postgresStore.saveProposals(proposals);
        }
      }
      postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was topped up with $${offer.amount}. All funds and milestones remain unified under Order #${order.id}.`, 'offer_accepted');
    }

    offer.resolvedAt = now; offer.resolvedBy = caller.id;
    syncUserBalances();
    await postgresStore.saveOrders(orders);
    await postgresStore.saveOffers(workstreamOffers);
    res.json({ offer: viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(order.id);
  }
});

export default router;
