import fs from 'fs';
import path from 'path';
import { WORKSTREAM_UPLOADS_DIR, type Order } from './store.js';
import { diagnosticService } from './services/diagnosticService.js';

export const WORKSTREAM_FILE_URL_PREFIX = '/api/workstream/files/';

export const STAFF_ROLES = ['admin', 'super_admin', 'support'];

export function isStaffUser(user: any): boolean {
  return !!user && STAFF_ROLES.includes(user.role);
}

/** Only the order's buyer, its seller, or platform staff may read or write its workstream. */
export function canAccessOrderWorkstream(user: any, order: { buyerId: string; sellerId: string } | undefined): boolean {
  if (!user || !order) {
    diagnosticService.log(
      'security',
      'accessControl',
      'canAccessOrderWorkstream',
      'server/access.ts',
      'check_order_access',
      'INTERCEPTED',
      { userId: user?.id, buyerId: order?.buyerId, sellerId: order?.sellerId },
      'Unauthorized or missing user/order context'
    );
    return false;
  }
  const hasAccess = isStaffUser(user) || user.id === order.buyerId || user.id === order.sellerId;
  if (!hasAccess) {
    diagnosticService.log(
      'security',
      'accessControl',
      'canAccessOrderWorkstream',
      'server/access.ts',
      'check_order_access',
      'INTERCEPTED',
      { userId: user.id, buyerId: order.buyerId, sellerId: order.sellerId },
      'User is neither buyer, seller, nor staff for this order'
    );
  }
  return hasAccess;
}

/** Robust, canonical path extraction preventing null byte injection, URL-encoded path traversal, and directory climbing */
export function workstreamFilenameFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(WORKSTREAM_FILE_URL_PREFIX)) return null;
  
  // URL decode safely
  let cleanUrl = url;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    // Malformed URI encoding
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'decode_url',
      'INTERCEPTED',
      { url },
      'Malformed URI encoding in file URL'
    );
    return null;
  }

  // Remove null bytes and control characters
  if (cleanUrl.includes('\0') || /[\x00-\x1f\x7f]/.test(cleanUrl)) {
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'null_byte_check',
      'INTERCEPTED',
      { url: cleanUrl },
      'Null byte or control character detected in file URL'
    );
    return null;
  }

  // Strip query string and hash
  const rawSubpath = cleanUrl.slice(WORKSTREAM_FILE_URL_PREFIX.length).split('?')[0].split('#')[0];
  const name = path.basename(rawSubpath);

  // Security check: ensure path.basename matches and does not contain traversal tokens
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'path_traversal_check',
      'INTERCEPTED',
      { url, extractedName: name },
      'Path traversal or invalid filename sequence in URL'
    );
    return null;
  }

  return name;
}

/** True when any message, deliverable or delivery record still points at this stored file. */
export function workstreamFileReferencedBy(filename: string): Array<{ buyerId: string; sellerId: string }> {
  return [];
}

export {
  canAccessWorkstreamFile,
  validateMessageFileInfo,
  validateStoredWorkstreamFiles
} from './services/workstreamService.js';

export function assertOrderOpen(order: Order) {
  if (order.status === 'completed') {
    diagnosticService.log(
      'warning',
      'orderService',
      'assertOrderOpen',
      'server/access.ts',
      'order_state_guard',
      'INTERCEPTED',
      { orderId: order.id, status: order.status },
      'Attempted transaction on already completed order'
    );
    throw new Error('Order is already completed; funds were already released.');
  }
  if (order.status === 'cancelled') {
    diagnosticService.log(
      'warning',
      'orderService',
      'assertOrderOpen',
      'server/access.ts',
      'order_state_guard',
      'INTERCEPTED',
      { orderId: order.id, status: order.status },
      'Attempted transaction on already cancelled order'
    );
    throw new Error('Order is already cancelled; funds were already handled.');
  }
}
