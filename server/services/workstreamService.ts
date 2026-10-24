import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import {
  orders,
  messages,
  proposals,
  users,
  workstreamOffers,
  workstreamUploadIndex,
  saveWorkstreamUploadIndex,
  type Order,
  type Proposal,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { financeLedger, FinanceLedgerEngine } from '../../src/server/financeLedger.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { isStaffUser } from '../middleware/auth.js';
import { recordMessage } from './messagingService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from './notificationService.js';
import { getActiveEscrowRemaining } from './orderService.js';

export const WORKSTREAM_UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'workstream');
if (!fs.existsSync(WORKSTREAM_UPLOADS_DIR)) {
  fs.mkdirSync(WORKSTREAM_UPLOADS_DIR, { recursive: true });
}

export const WORKSTREAM_FILE_URL_PREFIX = '/api/workstream/files/';
export const workstreamFileExists = (f: string) => Boolean(workstreamUploadIndex[f]) || fs.existsSync(path.join(WORKSTREAM_UPLOADS_DIR, f));
export const workstreamFileBytes = (f: string) => workstreamUploadIndex[f]?.size ?? (() => { try { return fs.statSync(path.join(WORKSTREAM_UPLOADS_DIR, f)).size; } catch { return 0; } })();
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

export function saveOffersToDisk() {
  postgresStore.saveOffers(workstreamOffers).catch(err => console.error('[PostgresStore] Failed to save offers:', err));
}

export const OFFER_LABEL: Record<WorkstreamOfferKind, string> = { proposal: 'proposal', invoice: 'invoice', deposit: 'deposit request' };
export const OFFER_PREFIX: Record<WorkstreamOfferKind, string> = { proposal: 'PRP', invoice: 'INV', deposit: 'DEP' };
export const FUNDED_STATUSES = ['funded_in_escrow', 'delivered', 'revision', 'completed', 'disputed'];

export function orderHasEscrow(orderId: string): boolean {
  return !!financeLedger.getEscrow(orderId);
}

export function hasPaidInvoiceOrReleasedEscrow(order: Order): boolean {
  const esc = financeLedger.getEscrow(order.id);
  return Boolean(
    order.status === 'completed' ||
    (esc && esc.releasedGross > 0) ||
    workstreamOffers.some(o => o.orderId === order.id && o.kind === 'invoice' && o.status === 'paid')
  );
}

export function findLinkedProposalForOffer(offer: WorkstreamOffer, order: Order): Proposal | undefined {
  return proposals.find(p =>
    (offer.proposalId && p.id === offer.proposalId) ||
    p.offerId === offer.id ||
    (order.proposalId && p.id === order.proposalId)
  );
}

export function viewOffer(o: WorkstreamOffer) {
  let clientTotal: number | undefined;
  let additionalAmount: number | undefined;
  let clientAdditionalTotal: number | undefined;
  try {
    clientTotal = financeLedger.quoteOrder(o.amount)?.clientTotal;
    if (o.kind === 'invoice') {
      const ord = orders.find(ord => ord.id === o.orderId);
      const curr = ord ? (o.status === 'pending' ? getActiveEscrowRemaining(ord) : Number(ord.amount || 0)) : 0;
      additionalAmount = Math.max(0, FinanceLedgerEngine.round(o.amount - curr));
      if (additionalAmount > 0) {
        clientAdditionalTotal = financeLedger.quoteOrder(additionalAmount)?.clientTotal;
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

export function postOfferMessage(order: Order, offer: WorkstreamOffer, sender: { id: string; name: string } | null, text: string, action: string) {
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
  postgresStore.saveMessages(messages);
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

export function offerCaller(req: Request) {
  const authUserId = (req as any).authenticatedUserId;
  return (req as any).authenticatedUser || users.find(u => u.id === authUserId);
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

export function workstreamFileReferencedBy(filename: string): Array<{ buyerId: string; sellerId: string }> {
  const holders: Array<{ buyerId: string; sellerId: string }> = [];
  const matches = (u: unknown) => workstreamFilenameFromUrl(u) === filename;
  for (const o of orders as any[]) {
    const inOrder =
      (Array.isArray(o.deliverableFiles) && o.deliverableFiles.some((f: any) => matches(f?.url))) ||
      (Array.isArray(o.deliveryHistory) && o.deliveryHistory.some((d: any) => Array.isArray(d.files) && d.files.some((f: any) => matches(f?.url)))) ||
      messages.some(m => m.orderId === o.id && matches(m.fileInfo?.url));
    if (inOrder) holders.push({ buyerId: o.buyerId, sellerId: o.sellerId });
  }
  return holders;
}

export function canAccessWorkstreamFile(user: any, filename: string): boolean {
  if (!user) return false;
  if (isStaffUser(user)) return true;
  if (workstreamUploadIndex[filename]?.ownerId === user.id) return true;
  return workstreamFileReferencedBy(filename).some(h => h.buyerId === user.id || h.sellerId === user.id);
}

export function validateMessageFileInfo(fileInfo: any, sender: any):
  { ok: true; fileInfo: any } | { ok: false; error: string } {
  if (fileInfo === undefined || fileInfo === null) return { ok: true, fileInfo: undefined };
  if (typeof fileInfo !== 'object') return { ok: false, error: 'Invalid file attachment.' };
  const filename = workstreamFilenameFromUrl(fileInfo.url);
  if (!filename || !workstreamFileExists(filename)) {
    return { ok: false, error: 'Attachments must be uploaded files; placeholder or external URLs are not accepted.' };
  }
  if (!isStaffUser(sender) && workstreamUploadIndex[filename]?.ownerId !== sender.id) {
    return { ok: false, error: 'You can only attach files that you uploaded.' };
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
    if (submitter && !isStaffUser(submitter) && workstreamUploadIndex[filename]?.ownerId !== submitter.id) {
      return { ok: false, error: 'You can only deliver files that you uploaded.' };
    }
    const bytes = workstreamFileBytes(filename);
    const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const parts = filename.split('_');
    const fallbackName = parts.length > 2 ? parts.slice(2).join('_') : filename;
    out.push({ name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : fallbackName, size, url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}` });
  }
  return { ok: true, files: out };
}

export function cleanupAbandonedWorkstreamUploads() {
  const now = Date.now();
  let changed = false;

  for (const [filename, rec] of Object.entries(workstreamUploadIndex)) {
    const isOld = now - new Date(rec.createdAt).getTime() > WORKSTREAM_ABANDONED_UPLOAD_TTL_MS;
    if (!isOld) continue;

    const isReferenced = workstreamFileReferencedBy(filename).length > 0;
    if (isReferenced) continue;

    try { fs.unlinkSync(path.join(WORKSTREAM_UPLOADS_DIR, filename)); } catch { /* already gone */ }
    delete workstreamUploadIndex[filename];
    postgresStore.deleteUploadRecord(filename).catch(console.error);
    changed = true;
  }

  try {
    const filesOnDisk = fs.readdirSync(WORKSTREAM_UPLOADS_DIR);
    for (const file of filesOnDisk) {
      if (!workstreamUploadIndex[file]) {
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

  if (changed) saveWorkstreamUploadIndex();
}
