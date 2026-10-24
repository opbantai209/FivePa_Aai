import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  store,
  type Order,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { calculateOrderFees, DEFAULT_FEE_CONFIG } from '../../src/shared/fees.js';
import { financialRepository } from '../services/financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import {
  requireAuth,
  requireActiveStatus,
  rateLimit,
  isStaffUser,
  canAccessOrderWorkstream,
  resolveAuthenticatedUserId
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
  getActiveEscrowRemaining,
  hasCommittedFinancialState
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from '../services/notificationService.js';
import {
  recordMessage,
  sanitizeAndCreateMessage,
  emitSystemEvent
} from '../services/messagingService.js';
import { uploadFileToCloudStorage, openCloudFileStream, deleteFileFromCloudStorage } from '../cloudStorage.js';
import {
  WORKSTREAM_UPLOADS_DIR,
  WORKSTREAM_FILE_URL_PREFIX,
  workstreamFileExists,
  WORKSTREAM_MAX_UPLOAD_BYTES,
  WORKSTREAM_ALLOWED_EXTENSIONS,
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

function formatOfferRow(r: any): WorkstreamOffer {
  const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
  return {
    id: r.id,
    number: r.number || '',
    orderId: r.order_id,
    workspaceId: r.workspace_id || undefined,
    kind: r.kind,
    title: r.title,
    amount: Number(r.amount),
    deliveryDays: r.delivery_days ? Number(r.delivery_days) : undefined,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at || undefined,
    resolvedBy: r.resolved_by || undefined,
    note: meta.note || undefined,
    files: meta.files || undefined,
    reference: meta.reference || undefined,
    responseDeadline: meta.responseDeadline || undefined,
    rejectionReason: meta.rejectionReason || undefined,
    rejectedBy: meta.rejectedBy || undefined,
    rejectedAt: meta.rejectedAt || undefined,
    proposalId: meta.proposalId || undefined
  };
}

async function saveOfferToDb(offer: WorkstreamOffer): Promise<void> {
  const pool = postgresStore.getPool();
  await pool.query(
    `INSERT INTO workstream_offers (id, number, order_id, workspace_id, kind, title, amount, delivery_days, status, created_by, created_at, resolved_at, resolved_by, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET
       number = EXCLUDED.number,
       order_id = EXCLUDED.order_id,
       kind = EXCLUDED.kind,
       title = EXCLUDED.title,
       amount = EXCLUDED.amount,
       delivery_days = EXCLUDED.delivery_days,
       status = EXCLUDED.status,
       resolved_at = EXCLUDED.resolved_at,
       resolved_by = EXCLUDED.resolved_by,
       metadata = EXCLUDED.metadata`,
    [
      offer.id,
      offer.number,
      offer.orderId,
      offer.workspaceId || null,
      offer.kind,
      offer.title,
      offer.amount,
      offer.deliveryDays || null,
      offer.status,
      offer.createdBy,
      offer.createdAt,
      offer.resolvedAt || null,
      offer.resolvedBy || null,
      JSON.stringify({
        note: offer.note,
        files: offer.files,
        reference: offer.reference,
        responseDeadline: offer.responseDeadline,
        rejectionReason: offer.rejectionReason,
        rejectedBy: offer.rejectedBy,
        rejectedAt: offer.rejectedAt,
        proposalId: offer.proposalId
      })
    ]
  );
}

const router = Router();

// ==========================================
// WORKSPACES API
// ==========================================

router.get('/workspaces', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId || resolveAuthenticatedUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    const caller = await store.getUser(authUserId);
    const isAdmin = isStaffUser(caller);

    const [workspaces, allOrders] = await Promise.all([
      isAdmin ? workspaceService.listAllAsync() : workspaceService.getWorkspacesForUserAsync(authUserId),
      store.listOrders()
    ]);

    const ordersByWorkspace = new Map<string, Order[]>();
    for (const o of allOrders) {
      const wsId = o.workspaceId;
      if (wsId) {
        const list = ordersByWorkspace.get(wsId) || [];
        list.push(enrichOrderWithServiceInfo(o, isAdmin));
        ordersByWorkspace.set(wsId, list);
      }
    }

    const enrichedWorkspaces = workspaces.map(ws => {
      const wsOrders = ordersByWorkspace.get(ws.workspaceId) || [];
      return {
        ...ws,
        orders: wsOrders,
        orderIds: wsOrders.map(o => o.id),
        activeOrder: wsOrders.find(o => o.id === ws.activeOrderId) || wsOrders[0] || null
      };
    });

    res.json(enrichedWorkspaces);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch workspaces' });
  }
});

router.get('/workspaces/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId || resolveAuthenticatedUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    const caller = await store.getUser(authUserId);
    const isAdmin = isStaffUser(caller);

    const ws = await workspaceService.getWorkspaceAsync(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    if (!isAdmin && ws.buyerId !== authUserId && ws.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only workspace participants may view this workspace.' });
    }

    const allOrders = await store.listOrders();
    const wsOrders = allOrders
      .filter(o => o.workspaceId === ws.workspaceId)
      .map(o => enrichOrderWithServiceInfo(o, isAdmin));

    res.json({
      ...ws,
      orders: wsOrders,
      orderIds: wsOrders.map(o => o.id),
      activeOrder: wsOrders.find(o => o.id === ws.activeOrderId) || wsOrders[0] || null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch workspace details' });
  }
});

// ==========================================
// FILE UPLOAD AND SERVING
// ==========================================

router.post(
  '/workstream/upload',
  requireAuth,
  rateLimit(30, 60_000),
  express.raw({ type: '*/*', limit: WORKSTREAM_MAX_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    try {
      const caller = (req as any).authenticatedUser;
      const rawName = (req.query.name as string) || 'attachment';
      let decodedName: string;
      try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
      const safeBase = path.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const ext = path.extname(safeBase).toLowerCase();
      if (!ext || !WORKSTREAM_ALLOWED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: `File extension '${ext}' is not permitted.` });
      }
      const nameWithoutExt = path.basename(safeBase, path.extname(safeBase));
      const storedFilename = `${Date.now()}_${randomUUID().slice(0, 8)}_${nameWithoutExt}${ext}`;

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'No file data received' });
      }
      if (buffer.length > WORKSTREAM_MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: 'File is too large (25 MB maximum).' });
      }

      const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

      // FIX 18: Authoritative Order <-> WorkStream <-> Participant binding verification
      if (orderId && workspaceId) {
        const targetOrder = await store.getOrder(orderId);
        if (!targetOrder) {
          return res.status(404).json({ error: 'Associated order not found' });
        }
        if (targetOrder.workspaceId && targetOrder.workspaceId !== workspaceId) {
          return res.status(400).json({ error: 'Order workspace mismatch: The specified order does not belong to the specified workspace.' });
        }
        if (!isStaffUser(caller) && targetOrder.buyerId !== caller.id && targetOrder.sellerId !== caller.id) {
          return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified order' });
        }
      } else if (orderId) {
        const targetOrder = await store.getOrder(orderId);
        if (!targetOrder) {
          return res.status(404).json({ error: 'Associated order not found' });
        }
        if (!isStaffUser(caller) && targetOrder.buyerId !== caller.id && targetOrder.sellerId !== caller.id) {
          return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified order' });
        }
      } else if (workspaceId) {
        const wsRes = await postgresStore.getPool().query('SELECT buyer_id, seller_id FROM workspaces WHERE workspace_id = $1', [workspaceId]);
        if (wsRes.rows.length === 0) {
          return res.status(404).json({ error: 'Associated workspace not found' });
        }
        const wsRow = wsRes.rows[0];
        if (!isStaffUser(caller) && wsRow.buyer_id !== caller.id && wsRow.seller_id !== caller.id) {
          return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified workspace' });
        }
      }

      const mimeType = (req.headers['content-type'] as string) || 'application/octet-stream';
      await uploadFileToCloudStorage(storedFilename, buffer, mimeType);
      const fileUrl = `${WORKSTREAM_FILE_URL_PREFIX}${storedFilename}`;

      try {
        await store.saveUploadRecord(storedFilename, {
          ownerId: caller.id,
          originalName: safeBase,
          mime: mimeType,
          size: buffer.length,
          createdAt: new Date().toISOString(),
          orderId: orderId || undefined,
          workspaceId: workspaceId || undefined
        });
      } catch (dbErr) {
        console.error('Failed to save upload record to DB, cleaning up cloud storage file:', dbErr);
        await deleteFileFromCloudStorage(storedFilename).catch(delErr => {
          console.error('Failed to clean up cloud storage file after DB failure:', delErr);
        });
        throw dbErr;
      }

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

router.get('/workstream/files/:filename', requireAuth, async (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WORKSTREAM_UPLOADS_DIR, filename);
  const localExists = fs.existsSync(filePath);
  const dbRec = !localExists ? await store.getUploadRecord(filename) : null;
  if (!localExists && !dbRec) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!(await canAccessWorkstreamFile((req as any).authenticatedUser, filename))) {
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
    const stream = openCloudFileStream(filename);
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

router.get('/messages/:orderId', requireAuth, async (req: Request, res: Response) => {
  try {
    const order = await store.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!canAccessOrderWorkstream((req as any).authenticatedUser, order)) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
    }
    const msgs = await store.listMessages(req.params.orderId);
    res.json(msgs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/messages', requireAuth, rateLimit(120, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    if (!caller) return res.status(401).json({ error: 'User not found' });
    const orderId = req.body.orderId;
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

    let order = await store.getOrder(orderId);
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
      const pool = postgresStore.getPool();
      const existingRes = await pool.query(
        "SELECT * FROM messages WHERE order_id = $1 AND metadata->>'clientMessageId' = $2 LIMIT 1",
        [orderId, clientMessageId]
      );
      if (existingRes.rows.length > 0) {
        const r = existingRes.rows[0];
        return res.json({
          success: true,
          message: {
            id: r.id,
            orderId: r.order_id,
            senderId: r.sender_id,
            senderName: r.sender_name,
            text: r.text,
            timestamp: r.timestamp,
            type: r.type,
            fileInfo: typeof r.file_info === 'string' ? JSON.parse(r.file_info) : r.file_info,
            metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata
          },
          deduplicated: true
        });
      }
    }

    const newMsg = sanitizeAndCreateMessage(caller, order, req.body, fileCheck);
    recordMessage(newMsg);
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
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const userId = (req as any).authenticatedUserId;
    const user = await store.getUser(userId);
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
      const pool = postgresStore.getPool();
      const existingRes = await pool.query(
        "SELECT * FROM messages WHERE order_id = $1 AND metadata->>'clientMessageId' = $2 LIMIT 1",
        [order.id, clientMessageId]
      );
      if (existingRes.rows.length > 0) {
        const r = existingRes.rows[0];
        return res.json({
          success: true,
          message: {
            id: r.id,
            orderId: r.order_id,
            senderId: r.sender_id,
            senderName: r.sender_name,
            text: r.text,
            timestamp: r.timestamp,
            type: r.type,
            fileInfo: typeof r.file_info === 'string' ? JSON.parse(r.file_info) : r.file_info,
            metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata
          },
          deduplicated: true
        });
      }
    }

    const newMsg = sanitizeAndCreateMessage(user, order, req.body, fileCheck);
    recordMessage(newMsg);
    broadcastMessage(newMsg, order.id);

    res.json({ success: true, message: newMsg });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send message' });
  }
});

// ==========================================
// WORKSTREAM OFFERS (PROPOSALS, INVOICES, DEPOSITS)
// ==========================================

router.get('/offers', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const result = await pool.query(
      `SELECT wo.* FROM workstream_offers wo
       JOIN orders o ON wo.order_id = o.id
       WHERE o.buyer_id = $1 OR o.seller_id = $1
       ORDER BY wo.created_at DESC`,
      [authUserId]
    );
    const offers = result.rows.map(formatOfferRow);
    const viewed = await Promise.all(offers.map(viewOffer));
    res.json(viewed);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id/offers', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = await offerCaller(req);
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });

    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM workstream_offers WHERE order_id = $1 ORDER BY created_at ASC', [order.id]);
    const offers = await Promise.all(result.rows.map(formatOfferRow).map(viewOffer));
    const esc = await financialRepository.getEscrow(order.id);
    res.json({
      offers,
      currencySymbol: siteSettings.getFlattenedSettings().currencySymbol || '$',
      escrowFunded: await orderHasEscrow(order.id),
      escrowRemaining: await getActiveEscrowRemaining(order),
      totalReleased: esc ? esc.releasedGross : (order.status === 'completed' ? Number(order.amount || 0) : 0),
      hasPaidInvoice: await hasPaidInvoiceOrReleasedEscrow(order)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders/:id/offers', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const caller = await offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    const order = await store.getOrder(req.params.id);
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

    const funded = await orderHasEscrow(order.id);
    const activeEscrow = await getActiveEscrowRemaining(order);
    const hasPaidFirstInvoice = await hasPaidInvoiceOrReleasedEscrow(order);

    const pool = postgresStore.getPool();
    const existingOffersRes = await pool.query('SELECT * FROM workstream_offers WHERE order_id = $1', [order.id]);
    const existingOffers = existingOffersRes.rows.map(formatOfferRow);

    if (kind === 'invoice') {
      if (!funded || activeEscrow <= 0) return res.status(400).json({ error: 'Final invoices are for completed work on a funded workstream.' });
      if (activeEscrow > 0 && amount < activeEscrow) {
        return res.status(400).json({ error: `Final invoice amount cannot be less than the funded escrow price ($${activeEscrow}).` });
      }
      if (existingOffers.filter(o => o.kind === 'invoice' && o.status === 'pending').length >= 1) {
        return res.status(409).json({ error: 'A final invoice is already pending for this workstream.' });
      }
    } else if (kind === 'proposal' || kind === 'deposit') {
      if (existingOffers.some(o => o.kind === 'invoice' && o.status === 'pending')) {
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

    const countRes = await pool.query('SELECT COUNT(*) as cnt FROM workstream_offers WHERE kind = $1', [kind]);
    const kindCount = Number(countRes.rows[0]?.cnt || 0);

    const offer: WorkstreamOffer = {
      id: 'off_' + randomUUID().slice(0, 12),
      number: `${OFFER_PREFIX[kind]}-${String(kindCount + 1001)}`,
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
    await saveOfferToDb(offer);

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
      await store.saveOrder(order);
    }

    await postOfferMessage(order, offer, { id: caller.id, name: caller.name }, `New ${OFFER_LABEL[kind]} ${offer.number}: ${title}`, 'offer_created');
    res.status(201).json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/offers/:id/:action(accept|decline|cancel)', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const pool = postgresStore.getPool();
  const offerRes = await pool.query('SELECT * FROM workstream_offers WHERE id = $1', [req.params.id]);
  if (offerRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const offer = formatOfferRow(offerRes.rows[0]);
  const order = await store.getOrder(offer.orderId);
  if (!order) return res.status(404).json({ error: 'Not found' });

  if (!tryAcquireOrderLock(order.id, res)) return;
  try {
    const caller = await offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });
    if (offer.status !== 'pending') {
      if (offer.status === 'accepted' || offer.status === 'paid') {
        const associatedOrder = await store.getOrder(offer.orderId) || order;
        return res.json({ 
          offer: await viewOffer(offer), 
          order: enrichOrderWithServiceInfo(associatedOrder) 
        });
      }
      return res.status(409).json({ error: `This ${OFFER_LABEL[offer.kind]} is already ${offer.status}.` });
    }

    const action = req.params.action;
    const now = new Date().toISOString();

    if (action === 'cancel') {
      if (caller.id !== order.sellerId) return res.status(403).json({ error: 'Only the seller can cancel this.' });
      offer.status = 'cancelled';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp && linkedProp.status === 'pending') {
          await pool.query("UPDATE proposals SET status = 'rejected' WHERE id = $1", [linkedProp.id]);
        }
      }
      if (offer.kind === 'invoice' && (order.status === 'delivered' || order.status === 'draft_review')) {
        const otherPendingRes = await pool.query(
          "SELECT 1 FROM workstream_offers WHERE order_id = $1 AND id <> $2 AND kind = 'invoice' AND status = 'pending' LIMIT 1",
          [order.id, offer.id]
        );
        if (otherPendingRes.rows.length === 0 && (await orderHasEscrow(order.id))) {
          order.status = 'in_progress';
          await store.saveOrder(order);
        }
      }
      await saveOfferToDb(offer);
      await postOfferMessage(order, offer, null, `${offer.number} was cancelled by the seller.`, 'offer_cancelled');
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
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
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
        await store.saveOrder(order);
        createNotification({
          userId: order.sellerId,
          type: 'invoice_rejected',
          title: 'Invoice rejected',
          message: `Your invoice for "${order.title}" was rejected. Reason: ${reason}`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id, reason }
        });
      }

      offer.status = 'declined';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          await pool.query("UPDATE proposals SET status = 'rejected' WHERE id = $1", [linkedProp.id]);
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
        const otherPendingRes = await pool.query(
          "SELECT 1 FROM workstream_offers WHERE order_id = $1 AND id <> $2 AND kind = 'invoice' AND status = 'pending' LIMIT 1",
          [order.id, offer.id]
        );
        if (otherPendingRes.rows.length === 0 && (await orderHasEscrow(order.id))) {
          order.status = 'revision';
          await store.saveOrder(order);
        }
      }
      await saveOfferToDb(offer);
      await postOfferMessage(order, offer, null, `${offer.number} was declined by the buyer.${offer.rejectionReason ? ` Reason: ${offer.rejectionReason}` : ''}`, 'offer_declined');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
    }

    // accept: real money movement through the ledger
    await ensureWallet(order.buyerId);
    await ensureWallet(order.sellerId);
    const today = now.split('T')[0];
    const protectionEnd = new Date(Date.now() + siteSettings.getSettings().commission.escrowProtectionDays * 86400000).toISOString().split('T')[0];
    const isInitialFunding = !(await orderHasEscrow(order.id));
    const isFollowOnAfterCompletion = (await orderHasEscrow(order.id)) && (order.status === 'completed' || (await getActiveEscrowRemaining(order)) === 0);
    const isCancelledGigFollowOn = order.status === 'cancelled' && (order.orderType === 'gig' || order.gigOrderId);

    if (offer.kind === 'invoice') {
      const validationError = validateOrderReleasePreconditions(order, false, true);
      if (validationError) {
        return res.status(validationError.status).json({ error: validationError.error });
      }

      const esc = await financialRepository.getEscrow(order.id);
      const currentEscrow = esc ? esc.remaining : Number(order.amount || 0);
      const invoiceAmount = Number(offer.amount);
      const additionalAmount = Math.round((invoiceAmount - currentEscrow) * 100) / 100;

      if (additionalAmount < 0) {
        return res.status(400).json({ error: `Final invoice amount ($${invoiceAmount}) cannot be less than the current order escrow ($${currentEscrow}).` });
      }

      if (additionalAmount > 0) {
        await topUpOrderEscrowWithEvent({
          orderId: order.id,
          orderTitle: `Invoice Top-up: ${offer.title}`,
          amount: additionalAmount,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          actor: `user:${order.buyerId}`
        });
        order.amount = invoiceAmount;
        order.feeBreakdown = calculateOrderFees(order.amount, DEFAULT_FEE_CONFIG);
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

      await syncUserBalances();
      await saveOfferToDb(offer);
      await store.saveOrder(order);
      const completionNote = additionalAmount > 0
        ? `${offer.number} ($${invoiceAmount.toLocaleString()}) was paid (+$${additionalAmount.toLocaleString()} funded from wallet) and full escrow ($${invoiceAmount.toLocaleString()}) was released to the seller. Order completed!`
        : `${offer.number} was accepted and escrow funds ($${invoiceAmount.toLocaleString()}) were released to the seller. Order completed!`;
      await postOfferMessage(order, offer, null, completionNote, 'offer_paid');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });

    } else if (isInitialFunding) {
      if (order.status === 'funded_in_escrow' || (await orderHasEscrow(order.id))) {
        return res.status(409).json({ error: 'Order escrow is already funded.' });
      }
      if (order.status !== 'in_progress' && order.status !== 'payment_pending') {
        return res.status(409).json({ error: 'Cannot fund escrow for order in current status.' });
      }
      const newTitle = offer.kind === 'proposal' && (/^inquiry:/i.test(order.title) || !order.amount) ? offer.title : order.title;
      const prevStatus = order.status;
      order.previousStatus = prevStatus;
      order.status = 'payment_pending';
      await store.saveOrder(order);

      try {
        await fundOrderEscrowWithEvent({ orderId: order.id, orderTitle: newTitle, amount: offer.amount, buyerId: order.buyerId, sellerId: order.sellerId, actor: `user:${order.buyerId}` });
        order.title = newTitle;
        order.amount = offer.amount;
        order.status = 'funded_in_escrow';
        order.escrowProtectionStartDate = today;
        order.escrowProtectionEndDate = protectionEnd;
        order.feeBreakdown = calculateOrderFees(offer.amount, DEFAULT_FEE_CONFIG);
        if (offer.kind === 'proposal' && offer.deliveryDays) {
          order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString().split('T')[0];
        }
        offer.orderId = order.id;
        offer.status = 'accepted';
        if (offer.kind === 'proposal') {
          const linkedProp = await findLinkedProposalForOffer(offer, order);
          if (linkedProp) {
            linkedProp.status = 'accepted';
            linkedProp.workstreamOrderId = order.id;
            linkedProp.offerId = offer.id;
            order.proposalId = linkedProp.id;
            await pool.query(
              "UPDATE proposals SET status = 'accepted', workstream_order_id = $1, offer_id = $2 WHERE id = $3",
              [order.id, offer.id, linkedProp.id]
            );
          }
        }
        await store.saveOrder(order);
        await saveOfferToDb(offer);
        await postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was funded ($${offer.amount}).`, 'offer_accepted');
      } catch (fundingErr: any) {
        order.status = prevStatus;
        await store.saveOrder(order);
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
        feeBreakdown: calculateOrderFees(offer.amount, DEFAULT_FEE_CONFIG),
        projectId: order.projectId,
        gigId: order.gigId
      };

      const enrichedOrder = enrichOrderWithServiceInfo(newOrder);
      recordOrder(enrichedOrder);
      await store.saveOrder(enrichedOrder);
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
        await store.saveOrder(enrichedOrder);
        await syncUserBalances();
      } catch (fundingErr: any) {
        const financiallyCommitted = await hasCommittedFinancialState(newOrder.id);
        if (financiallyCommitted) {
          enrichedOrder.status = 'funded_in_escrow';
          await postgresStore.getPool().query("UPDATE orders SET status = 'funded_in_escrow' WHERE id = $1", [newOrder.id]);
          orderIndex.set(newOrder.id, enrichedOrder);
          await store.saveOrder(enrichedOrder);
          console.error('[WorkstreamFollowOn] Follow-up error after committed escrow funding:', fundingErr);
        } else {
          await pool.query('DELETE FROM orders WHERE id = $1', [newOrder.id]);
          await pool.query('DELETE FROM messages WHERE order_id = $1', [newOrder.id]);
          orderIndex.delete(newOrder.id);
          return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for follow-on order.' });
        }
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

      await saveOfferToDb(offer);
      await postOfferMessage(enrichedOrder, offer, null, `Follow-on ${OFFER_LABEL[offer.kind]} ${offer.number} ("${offer.title}") was accepted and $${offer.amount.toLocaleString()} was funded into escrow in a new Order (#${newOrderId}).`, 'offer_accepted');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(enrichedOrder) });
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
      order.feeBreakdown = calculateOrderFees(order.amount, DEFAULT_FEE_CONFIG);
      if (offer.kind === 'proposal' && offer.deliveryDays) {
        order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString().split('T')[0];
      }
      offer.orderId = order.id;
      offer.status = 'accepted';
      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          linkedProp.status = 'accepted';
          linkedProp.workstreamOrderId = order.id;
          linkedProp.offerId = offer.id;
          await pool.query(
            "UPDATE proposals SET status = 'accepted', workstream_order_id = $1, offer_id = $2 WHERE id = $3",
            [order.id, offer.id, linkedProp.id]
          );
        }
      }
      await postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was topped up with $${offer.amount}. All funds and milestones remain unified under Order #${order.id}.`, 'offer_accepted');
    }

    offer.resolvedAt = now;
    offer.resolvedBy = caller.id;
    await syncUserBalances();
    await store.saveOrder(order);
    await saveOfferToDb(offer);
    res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(order.id);
  }
});

export default router;
