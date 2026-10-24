import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import {
  store,
  type Order,
  type Proposal,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { calculateOrderFees, DEFAULT_FEE_CONFIG } from '../../src/shared/fees.js';
import { financialRepository } from './financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { isStaffUser } from '../middleware/auth.js';
import { recordMessage } from './messagingService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from './notificationService.js';

export const WORKSTREAM_UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'workstream');
if (!fs.existsSync(WORKSTREAM_UPLOADS_DIR)) {
  fs.mkdirSync(WORKSTREAM_UPLOADS_DIR, { recursive: true });
}

export const WORKSTREAM_FILE_URL_PREFIX = '/api/workstream/files/';
export const workstreamFileExists = (f: string) => fs.existsSync(path.join(WORKSTREAM_UPLOADS_DIR, f));
export const workstreamFileBytes = (f: string) => { try { return fs.statSync(path.join(WORKSTREAM_UPLOADS_DIR, f)).size; } catch { return 0; } };
export const WORKSTREAM_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const WORKSTREAM_ABANDONED_UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

export const WORKSTREAM_ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.md', '.csv', '.json',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
  '.mp4', '.mov', '.webm', '.mp3', '.wav', '.fig', '.psd', '.ai', '.sketch',
  '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.css', '.scss',
  '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.sql', '.sh', '.xml', '.vue', '.svelte', '.yaml', '.yml'
]);

export const WORKSTREAM_INLINE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.svg', '.txt']);

export const OFFER_LABEL: Record<WorkstreamOfferKind, string> = { proposal: 'proposal', invoice: 'invoice', deposit: 'deposit request' };
export const OFFER_PREFIX: Record<WorkstreamOfferKind, string> = { proposal: 'PRP', invoice: 'INV', deposit: 'DEP' };
export const FUNDED_STATUSES = ['funded_in_escrow', 'delivered', 'revision', 'completed', 'disputed'];

export async function orderHasEscrow(orderId: string): Promise<boolean> {
  const esc = await financialRepository.getEscrow(orderId);
  return Boolean(esc && esc.status === 'held' && esc.remaining > 0);
}

export async function hasPaidInvoiceOrReleasedEscrow(order: Order): Promise<boolean> {
  const esc = await financialRepository.getEscrow(order.id);
  if (order.status === 'completed' || (esc && esc.releasedGross > 0)) return true;
  try {
    const pool = postgresStore.getPool();
    const res = await pool.query(
      "SELECT 1 FROM workstream_offers WHERE order_id = $1 AND kind = 'invoice' AND status = 'paid' LIMIT 1",
      [order.id]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

export async function findLinkedProposalForOffer(offer: WorkstreamOffer, order: Order): Promise<Proposal | undefined> {
  try {
    const pool = postgresStore.getPool();
    const query = `
      SELECT * FROM proposals
      WHERE id = $1 OR offer_id = $2 OR (project_id = $3 AND freelancer_id = $4)
      LIMIT 1
    `;
    const res = await pool.query(query, [offer.proposalId || null, offer.id, order.projectId || null, order.sellerId]);
    if (res.rows.length === 0) return undefined;
    const r = res.rows[0];
    return {
      id: r.id,
      projectId: r.project_id,
      freelancerId: r.freelancer_id,
      freelancerName: r.freelancer_name,
      freelancerAvatar: r.freelancer_avatar || undefined,
      freelancerTitle: r.freelancer_title || undefined,
      coverLetter: r.cover_letter || '',
      bidAmount: Number(r.bid_amount),
      deliveryDays: Number(r.delivery_days),
      createdAt: r.created_at,
      status: r.status,
      workstreamOrderId: r.workstream_order_id || undefined,
      offerId: r.offer_id || undefined
    };
  } catch {
    return undefined;
  }
}

export async function viewOffer(o: WorkstreamOffer) {
  let clientTotal: number | undefined;
  let additionalAmount: number | undefined;
  let clientAdditionalTotal: number | undefined;
  try {
    clientTotal = calculateOrderFees(o.amount, DEFAULT_FEE_CONFIG)?.clientTotal;
    if (o.kind === 'invoice') {
      const ord = await store.getOrder(o.orderId);
      const escrow = ord ? await financialRepository.getEscrow(ord.id) : null;
      const curr = ord ? (o.status === 'pending' ? (escrow?.remaining ?? (ord.status === 'completed' || ord.status === 'cancelled' ? 0 : Number(ord.amount || 0))) : Number(ord.amount || 0)) : 0;
      additionalAmount = Math.max(0, Math.round((o.amount - curr) * 100) / 100);
      if (additionalAmount > 0) {
        clientAdditionalTotal = calculateOrderFees(additionalAmount, DEFAULT_FEE_CONFIG)?.clientTotal;
      } else {
        clientAdditionalTotal = 0;
      }
    }
  } catch { /* quote is informational only */ }
  return {
    ...o,
    clientTotal,
    additionalAmount,
    clientAdditionalTotal,
    currencySymbol: siteSettings.getFlattenedSettings().currencySymbol || '$'
  };
}

export async function postOfferMessage(order: Order, offer: WorkstreamOffer, sender: { id: string; name: string } | null, text: string, action: string) {
  const msg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: sender?.id || 'system',
    senderName: sender?.name || 'Workstream',
    text,
    timestamp: new Date().toISOString(),
    type: sender ? 'message' : 'system',
    metadata: { action, offerId: offer.id, offerKind: offer.kind }
  };
  recordMessage(msg);
  await store.addMessage(msg);
  broadcastMessage(msg, order.id);

  const recipientIds: string[] = [];
  if (sender?.id) {
    const other = sender.id === order.buyerId ? order.sellerId : order.buyerId;
    if (other) recipientIds.push(other);
  } else {
    if (order.buyerId) recipientIds.push(order.buyerId);
    if (order.sellerId && order.sellerId !== order.buyerId) recipientIds.push(order.sellerId);
  }
  for (const userId of recipientIds) {
    createNotification({
      userId,
      type: 'offer',
      title: 'New Offer Activity',
      message: text,
      link: `/messages/${order.id}`,
      dedupKey: `offer_${action}_${msg.id}`,
      actorId: sender?.id
    });
  }
}

export async function offerCaller(req: Request) {
  const authUserId = (req as any).authenticatedUserId;
  if ((req as any).authenticatedUser) return (req as any).authenticatedUser;
  if (!authUserId) return null;
  return await store.getUser(authUserId);
}

export function workstreamFilenameFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith(WORKSTREAM_FILE_URL_PREFIX)) {
    const name = path.basename(trimmed.slice(WORKSTREAM_FILE_URL_PREFIX.length).split('?')[0]);
    if (name && workstreamFileExists(name)) return name;
  }
  if (trimmed.startsWith('/uploads/workstream/')) {
    const name = path.basename(trimmed.slice('/uploads/workstream/'.length).split('?')[0]);
    if (name && workstreamFileExists(name)) return name;
  }
  if (trimmed.includes('workstream/')) {
    const parts = trimmed.split('workstream/');
    const lastPart = parts[parts.length - 1].split('?')[0];
    const name = path.basename(lastPart);
    if (name && workstreamFileExists(name)) {
      return name;
    }
  }
  const baseName = path.basename(trimmed.split('?')[0]);
  if (baseName && workstreamFileExists(baseName)) {
    return baseName;
  }
  return null;
}

export async function canAccessWorkstreamFile(user: any, filename: string): Promise<boolean> {
  if (!user) return false;
  if (isStaffUser(user)) return true;

  try {
    const rec = await store.getUploadRecord(filename);
    if (!rec) return false;

    if (rec.ownerId === user.id) {
      return true;
    }

    if (rec.orderId) {
      const order = await store.getOrder(rec.orderId);
      if (order && (user.id === order.buyerId || user.id === order.sellerId)) {
        return true;
      }
    }

    if (rec.workspaceId) {
      const ws = await postgresStore.getPool().query('SELECT buyer_id, seller_id FROM workspaces WHERE workspace_id = $1', [rec.workspaceId]);
      if (ws.rows.length > 0) {
        const row = ws.rows[0];
        if (user.id === row.buyer_id || user.id === row.seller_id) {
          return true;
        }
      }
    }
  } catch (err) {
    console.error(`[canAccessWorkstreamFile] Authorization check error for file ${filename}:`, err);
  }

  return false;
}

export function validateMessageFileInfo(fileInfo: any, sender: any):
  { ok: true; fileInfo: any } | { ok: false; error: string } {
  if (fileInfo === undefined || fileInfo === null) return { ok: true, fileInfo: undefined };
  if (typeof fileInfo !== 'object') return { ok: false, error: 'Invalid file attachment.' };
  const filename = workstreamFilenameFromUrl(fileInfo.url);
  if (!filename || !workstreamFileExists(filename)) {
    return { ok: false, error: 'Attachments must be uploaded files; placeholder or external URLs are not accepted.' };
  }
  const bytes = workstreamFileBytes(filename);
  const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return {
    ok: true,
    fileInfo: {
      name: typeof fileInfo.name === 'string' && fileInfo.name.trim() ? fileInfo.name.trim().slice(0, 200) : filename,
      size,
      url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}`,
      ...(typeof fileInfo.type === 'string' ? { type: fileInfo.type.slice(0, 100) } : {})
    }
  };
}

export function validateStoredWorkstreamFiles(raw: any[], submitter?: any): { ok: true; files: Array<{ name: string; size: string; url: string }> } | { ok: false; error: string } {
  const out: Array<{ name: string; size: string; url: string }> = [];
  for (const f of raw) {
    const filename = workstreamFilenameFromUrl(f?.url);
    if (!filename) {
      if (typeof f?.url !== 'string') {
        return { ok: false, error: 'Invalid deliverable link.' };
      }
      const extUrl = f.url.trim();
      out.push({
        name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : 'External Deliverable',
        size: typeof f?.size === 'string' ? f.size : '1.0 MB',
        url: extUrl
      });
      continue;
    }
    if (!workstreamFileExists(filename)) {
      return { ok: false, error: `Uploaded file not found on server: ${filename}` };
    }
    const bytes = workstreamFileBytes(filename);
    const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const parts = filename.split('_');
    const fallbackName = parts.length > 2 ? parts.slice(2).join('_') : filename;
    out.push({ name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : fallbackName, size, url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}` });
  }
  return { ok: true, files: out };
}

export async function cleanupAbandonedWorkstreamUploads() {
  const now = Date.now();
  try {
    const uploadRecords = await postgresStore.listUploadRecords();
    for (const [filename, rec] of Object.entries(uploadRecords)) {
      const isOld = now - new Date(rec.createdAt).getTime() > WORKSTREAM_ABANDONED_UPLOAD_TTL_MS;
      if (!isOld) continue;

      // Fix 15: Never delete files that are currently referenced by active orders, messages, deliverables, or offers
      const pool = postgresStore.getPool();
      const inUseCheck = await pool.query(
        `SELECT 1 FROM messages WHERE file_info::text LIKE $1 
         UNION ALL 
         SELECT 1 FROM orders WHERE deliverable_files::text LIKE $1
         UNION ALL 
         SELECT 1 FROM workstream_offers WHERE metadata::text LIKE $1 LIMIT 1`,
        [`%${filename}%`]
      );
      if (inUseCheck.rows.length > 0) continue;

      try { fs.unlinkSync(path.join(WORKSTREAM_UPLOADS_DIR, filename)); } catch { /* already gone */ }
      await postgresStore.deleteUploadRecord(filename);
    }

    const filesOnDisk = fs.readdirSync(WORKSTREAM_UPLOADS_DIR);
    for (const file of filesOnDisk) {
      if (!uploadRecords[file]) {
        const filePath = path.join(WORKSTREAM_UPLOADS_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 3600_000) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }
    }
  } catch (e) {
    console.error('Error during deep Workstream cleanup:', e);
  }
}
