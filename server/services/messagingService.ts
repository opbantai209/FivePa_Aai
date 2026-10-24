import {
  messages,
  orders,
  type Message,
  type Order,
  type User
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { broadcastMessage } from '../websocket.js';
import { notifyOrderParties } from './notificationService.js';
import { isStaffUser } from '../middleware/auth.js';

export const messageIndex = new Map<string, Message[]>();

export function registerMessage(m: Message) {
  if (!m.orderId) return;
  const list = messageIndex.get(m.orderId) || [];
  const existingIdx = m.id ? list.findIndex(item => item.id === m.id) : -1;
  if (existingIdx !== -1) {
    list[existingIdx] = m;
  } else {
    list.push(m);
  }
  messageIndex.set(m.orderId, list);
}

export function recordMessage(m: Message) {
  if (!m.id || !messages.some(existing => existing.id === m.id)) {
    messages.push(m);
  }
  registerMessage(m);
}

export function sanitizeAndCreateMessage(
  sender: User,
  order: Order,
  body: any,
  fileCheck: { ok: boolean; fileInfo?: any; error?: string }
): Message {
  let text = typeof body.text === 'string' ? body.text.trim() : '';
  const isSystemOrStaff = isStaffUser(sender);

  // Check for off-platform contact info
  const offPlatformRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b|(?:https?:\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)+(?:com|net|org|io|me|co)\b/gi;
  const metadata: any = {};
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    Object.assign(metadata, body.metadata);
  }

  if (!isSystemOrStaff && offPlatformRegex.test(text)) {
    metadata.offPlatformWarning = true;
  }

  delete metadata.offerId;
  delete metadata.offerKind;

  if (!isSystemOrStaff) {
    const FORBIDDEN_METADATA_KEYS = [
      'disputeId', 'revisionId', 'reviewId', 'ticketId', 'payoutId', 'refundId', 'transactionId',
      'deliveryVersion', 'version', 'amount', 'refundAmount', 'feeBreakdown',
      'system', 'isSystem', 'official', 'verified', 'trusted', 'isAdmin', 'isStaff',
      'role', 'senderRole', 'status', 'orderStatus', 'paymentStatus', 'escrowStatus'
    ];
    for (const key of FORBIDDEN_METADATA_KEYS) {
      delete metadata[key];
    }

    if (typeof metadata.action === 'string') {
      const action = metadata.action.trim().toLowerCase();
      const isReservedAction =
        /^(offer_|escrow_|deliverable_|delivery_|revision_|dispute_|review_|order_|payment_|payout_|refund_|wallet_|transaction_|deposit_|system_|admin_|staff_|moderation_|audit_|project_proposal)/i.test(action) ||
        ['auto_accept', 'order_auto_accepted', 'release_escrow', 'escrow_release'].includes(action);

      if (isReservedAction) {
        delete metadata.action;
      }
    }

    for (const k of Object.keys(metadata)) {
      if (k !== 'requirementText') delete metadata[k];
    }
    if (typeof metadata.requirementText === 'string') {
      metadata.requirementText = metadata.requirementText.slice(0, 2000);
    } else {
      delete metadata.requirementText;
    }
  } else {
    if (typeof metadata.action === 'string' && /^offer_/i.test(metadata.action)) {
      delete metadata.action;
    }
  }

  if (body.clientMessageId) {
    metadata.clientMessageId = String(body.clientMessageId);
  }
  if (body.metadata?.clientMessageId) {
    metadata.clientMessageId = String(body.metadata.clientMessageId);
  }

  const requestedType = typeof body.type === 'string' ? body.type : 'text';
  const NON_STAFF_TYPES = ['message', 'text', 'file'];
  const safeType = (isSystemOrStaff || NON_STAFF_TYPES.includes(requestedType)) ? requestedType : 'text';
  if (safeType !== 'file' && !text) throw new Error('Message text is required.');

  return {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: sender.id,
    senderName: sender.name,
    text: text.slice(0, 5000),
    timestamp: new Date().toISOString(),
    type: safeType,
    fileInfo: fileCheck.fileInfo,
    metadata: Object.keys(metadata).length ? metadata : undefined
  };
}

export function emitSystemEvent(orderId: string, action: string, text: string, metadata: Record<string, any> = {}) {
  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId,
    senderId: 'system',
    senderName: 'WorkSphere System',
    text,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { ...metadata, action }
  };
  recordMessage(sysMsg);
  postgresStore.saveMessages(messages);
  broadcastMessage(sysMsg, orderId);
  notifyOrderParties(orderId, action, text, sysMsg.id);
}

export function pushSystemMessage(orderId: string, text: string, action = 'system_notice') {
  emitSystemEvent(orderId, action, text);
}
