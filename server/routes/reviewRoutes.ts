import { Router, Request, Response } from 'express';
import {
  reviews,
  users,
  orders,
  messages,
  type Review,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  requireAuth,
  requireRole,
  resolveAuthenticatedUserId
} from '../middleware/auth.js';
import {
  isValidIntegerRating,
  isReviewPublic,
  recalculateUserRating,
  sanitizePublicReview
} from '../services/reviewService.js';
import { orderIndex, enrichOrderWithServiceInfo } from '../services/orderService.js';
import { hasPaidInvoiceOrReleasedEscrow } from '../services/workstreamService.js';
import { createNotification } from '../services/notificationService.js';
import { recordMessage } from '../services/messagingService.js';
import { broadcastMessage } from '../websocket.js';

const router = Router();

router.get('/reviews', (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req);
  const caller = authUserId ? users.find(u => u.id === authUserId) : null;
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

  if (isAdmin) {
    return res.json(reviews);
  }

  const visibleReviews = reviews.filter(r => {
    if (authUserId && (r.reviewerId === authUserId || r.targetUserId === authUserId)) {
      return (r as any).moderationStatus !== 'hidden';
    }
    return isReviewPublic(r);
  }).map(sanitizePublicReview);

  res.json(visibleReviews);
});

router.get('/users/:userId/reviews', (req: Request, res: Response) => {
  const targetUserId = req.params.userId;
  const authUserId = resolveAuthenticatedUserId(req);
  const caller = authUserId ? users.find(u => u.id === authUserId) : null;
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

  const userReviews = reviews.filter(r => {
    if (r.targetUserId !== targetUserId) return false;
    if (isAdmin) return true;
    if (authUserId && (r.reviewerId === authUserId || r.targetUserId === authUserId)) {
      return (r as any).moderationStatus !== 'hidden';
    }
    return isReviewPublic(r);
  }).map(sanitizePublicReview);

  res.json(userReviews);
});

router.post('/reviews', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
  if (!caller) return res.status(401).json({ error: 'Authentication required to submit a review' });

  const { orderId, targetUserId, rating, comment } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: 'Order ID is required' });
  }

  if (!isValidIntegerRating(rating)) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5 stars.' });
  }
  const numRating = Number(rating);

  if (!comment || typeof comment !== 'string' || !comment.trim()) {
    return res.status(400).json({ error: 'Review comment cannot be empty' });
  }

  const order = orderIndex.get(orderId);
  if (!order) return res.status(404).json({ error: 'Workstream order not found' });
  if (caller.id !== order.buyerId && caller.id !== order.sellerId) {
    return res.status(403).json({ error: 'Forbidden: Only the buyer or seller of this order can submit a review.' });
  }

  const expectedTargetUserId = caller.id === order.buyerId ? order.sellerId : order.buyerId;
  if (targetUserId && targetUserId !== expectedTargetUserId) {
    return res.status(400).json({ error: 'Invalid targetUserId. Review must target the seller or buyer associated with this order.' });
  }
  const resolvedTargetUserId = expectedTargetUserId;

  const allowedReviewStatuses = ['completed', 'cancelled'];
  if (!allowedReviewStatuses.includes(order.status) && !hasPaidInvoiceOrReleasedEscrow(order)) {
    return res.status(409).json({ error: `Reviews can only be submitted for completed or cancelled Workstreams (current status: ${order.status}).` });
  }

  const isBuyerReviewer = caller.id === order.buyerId;
  const existingReview = reviews.find(r => r.orderId === order.id && r.reviewerId === caller.id) ||
    (isBuyerReviewer && order.review && order.review.reviewerId === caller.id ? order.review : null) ||
    (!isBuyerReviewer && (order as any).sellerReview && (order as any).sellerReview.reviewerId === caller.id ? (order as any).sellerReview : null);
  if (existingReview) {
    return res.status(409).json({ error: 'A review has already been submitted for this order. Use PUT /api/reviews/:id to edit your review.' });
  }

  const newReview: Review = {
    id: 'rev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    orderId: order.id,
    reviewerId: caller.id,
    reviewerName: caller.name,
    reviewerAvatar: caller.avatar,
    targetUserId: resolvedTargetUserId,
    rating: numRating,
    comment: comment.trim(),
    orderTitle: order.title || 'Workstream Milestone Deliverable',
    gigId: order.gigId,
    projectId: order.projectId,
    isCancelledOrder: order.status === 'cancelled',
    createdAt: new Date().toISOString().split('T')[0]
  };

  reviews.unshift(newReview);
  postgresStore.saveReviews(reviews);

  if (isBuyerReviewer) {
    order.review = newReview;
  } else {
    (order as any).sellerReview = newReview;
  }
  postgresStore.saveOrders(orders);

  recalculateUserRating(resolvedTargetUserId);

  createNotification({
    userId: resolvedTargetUserId,
    type: 'review',
    title: 'New Review Received',
    message: `${caller.name} left a ${numRating}-star review for order "${order.title}".`,
    link: `/messages/${order.id}`,
    dedupKey: `review_${newReview.id}`,
    actorId: caller.id
  });

  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'WorkSphere Reviews',
    text: `⭐ ${order.status === 'cancelled' ? 'Post-cancellation review' : 'Review'} submitted by ${caller.name} (${newReview.rating}/5 stars): "${newReview.comment}"`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: {
      action: 'review_submitted',
      rating: newReview.rating,
      comment: newReview.comment,
      isCancelledOrder: order.status === 'cancelled'
    }
  };
  recordMessage(sysMsg);
  postgresStore.saveMessages(messages);
  broadcastMessage(sysMsg, order.id);

  res.status(201).json({ success: true, review: newReview, order: enrichOrderWithServiceInfo(order) });
});

router.put('/reviews/:id', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
  if (!caller) return res.status(401).json({ error: 'Authentication required' });

  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
  if (!isAdmin && review.reviewerId !== caller.id) {
    return res.status(403).json({ error: 'Forbidden: You can only edit your own review.' });
  }

  const { rating, comment } = req.body;
  if (rating !== undefined) {
    if (!isValidIntegerRating(rating)) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5 stars.' });
    }
    review.rating = Number(rating);
  }

  if (comment && typeof comment === 'string' && comment.trim()) {
    review.comment = comment.trim();
  }

  review.updatedAt = new Date().toISOString();
  postgresStore.saveReviews(reviews);

  if (review.targetUserId) {
    recalculateUserRating(review.targetUserId);
  }

  if (review.orderId) {
    const order = orderIndex.get(review.orderId);
    if (order && order.review && order.review.id === review.id) {
      order.review.rating = review.rating;
      order.review.comment = review.comment;
      postgresStore.saveOrders(orders);
    }
  }

  res.json({ success: true, review });
});

router.post('/reviews/:id/reply', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
  if (!caller) return res.status(401).json({ error: 'Authentication required' });

  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const isAdmin = caller.role === 'admin' || caller.role === 'super_admin' || caller.role === 'support';
  const isSeller = review.targetUserId === caller.id;
  const isBuyer = review.reviewerId === caller.id;

  if (!isAdmin && !isSeller && !isBuyer) {
    return res.status(403).json({ error: 'Forbidden: Only the reviewed seller, the reviewer (buyer), or an admin can reply to this review.' });
  }

  const { text, asRole } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Reply text cannot be empty.' });
  }

  const trimmedText = text.trim();
  const replyObj = {
    text: trimmedText,
    createdAt: new Date().toISOString(),
    sellerId: (isSeller || (isAdmin && asRole === 'seller') ? caller.id : (review.targetUserId || 'unknown')) as string,
    sellerName: caller.name,
    sellerAvatar: caller.avatar,
    authorId: caller.id,
    authorName: caller.name,
    authorAvatar: caller.avatar,
    role: isAdmin ? (asRole || 'admin') : (isSeller ? 'seller' : 'buyer')
  };

  let isBuyerReply = isBuyer && !isAdmin;
  if (isAdmin && asRole === 'buyer') isBuyerReply = true;

  if (isBuyerReply) {
    if (review.buyerReply) {
      return res.status(409).json({ error: 'A public response has already been submitted by the buyer for this review.' });
    }
    review.buyerReply = replyObj;
  } else {
    if (review.reply || (review as any).sellerReply) {
      return res.status(409).json({ error: 'A public response has already been submitted by the seller for this review.' });
    }
    review.reply = replyObj;
    (review as any).sellerReply = replyObj;
  }

  postgresStore.saveReviews(reviews);

  if (review.orderId) {
    const order = orderIndex.get(review.orderId);
    if (order) {
      if (order.review && order.review.id === review.id) {
        if (isBuyerReply) {
          order.review.buyerReply = replyObj;
        } else {
          order.review.reply = replyObj;
          (order.review as any).sellerReply = replyObj;
        }
      }
      postgresStore.saveOrders(orders);

      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'WorkSphere Reviews',
        text: `💬 Public response posted by ${isBuyerReply ? 'buyer' : 'seller'} ${caller.name}: "${replyObj.text}"`,
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'review_reply_submitted', reply: replyObj }
      };
      recordMessage(sysMsg);
      postgresStore.saveMessages(messages);
      broadcastMessage(sysMsg, order.id);
    }
  }

  res.json({ success: true, review });
});

router.patch('/admin/reviews/:id/moderation', requireRole(['admin', 'super_admin', 'support']), (req: Request, res: Response) => {
  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const { moderationStatus, moderationReason } = req.body;
  if (moderationStatus !== undefined) {
    (review as any).moderationStatus = moderationStatus;
  }
  if (moderationReason !== undefined) {
    (review as any).moderationReason = moderationReason;
  }
  postgresStore.saveReviews(reviews);
  if (review.orderId) {
    const order = orderIndex.get(review.orderId);
    if (order) {
      if (order.review && order.review.id === review.id) {
        (order.review as any).moderationStatus = (review as any).moderationStatus;
      }
      postgresStore.saveOrders(orders);
    }
  }
  if (review.targetUserId) {
    recalculateUserRating(review.targetUserId);
  }
  res.json({ success: true, review });
});

export default router;
