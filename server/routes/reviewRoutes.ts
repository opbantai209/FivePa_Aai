import { Router, Request, Response } from 'express';
import {
  store,
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

router.get('/reviews', async (req: Request, res: Response) => {
  try {
    const authUserId = resolveAuthenticatedUserId(req);
    const caller = authUserId ? await store.getUser(authUserId) : null;
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const allReviews = await store.listReviews();

    if (isAdmin) {
      return res.json(allReviews);
    }

    const visibleReviews = allReviews.filter(r => {
      if (authUserId && (r.reviewerId === authUserId || r.targetUserId === authUserId)) {
        return (r as any).moderationStatus !== 'hidden';
      }
      return isReviewPublic(r);
    }).map(sanitizePublicReview);

    res.json(visibleReviews);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list reviews' });
  }
});

router.get('/users/:userId/reviews', async (req: Request, res: Response) => {
  try {
    const targetUserId = req.params.userId;
    const authUserId = resolveAuthenticatedUserId(req);
    const caller = authUserId ? await store.getUser(authUserId) : null;
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const allReviews = await store.listReviews();
    const userReviews = allReviews.filter(r => {
      if (r.targetUserId !== targetUserId) return false;
      if (isAdmin) return true;
      if (authUserId && (r.reviewerId === authUserId || r.targetUserId === authUserId)) {
        return (r as any).moderationStatus !== 'hidden';
      }
      return isReviewPublic(r);
    }).map(sanitizePublicReview);

    res.json(userReviews);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list user reviews' });
  }
});

router.post('/reviews', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
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

    const order = await store.getOrder(orderId);
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
    if (!allowedReviewStatuses.includes(order.status) && !(await hasPaidInvoiceOrReleasedEscrow(order))) {
      return res.status(409).json({ error: `Reviews can only be submitted for completed or cancelled Workstreams (current status: ${order.status}).` });
    }

    const isBuyerReviewer = caller.id === order.buyerId;
    const existingReviewsRes = await postgresStore.getPool().query(
      'SELECT id FROM reviews WHERE order_id = $1 AND reviewer_id = $2',
      [order.id, caller.id]
    );
    if (existingReviewsRes.rows.length > 0) {
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

    try {
      await store.addReview(newReview);
    } catch (err: any) {
      if (err.code === '23505' || err.message?.includes('duplicate key') || err.message?.includes('unique')) {
        return res.status(409).json({ error: 'A review has already been submitted for this order. Use PUT /api/reviews/:id to edit your review.' });
      }
      throw err;
    }

    if (isBuyerReviewer) {
      order.review = newReview;
    } else {
      (order as any).sellerReview = newReview;
    }
    await store.saveOrder(order);
    orderIndex.set(order.id, order);

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
    await store.addMessage(sysMsg);
    broadcastMessage(sysMsg, order.id);

    res.status(201).json({ success: true, review: newReview, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to submit review' });
  }
});

router.put('/reviews/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });

    const revRes = await postgresStore.getPool().query('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    if (revRes.rows.length === 0) return res.status(404).json({ error: 'Review not found' });
    const review = revRes.rows[0];

    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
    if (!isAdmin && review.reviewer_id !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit your own review.' });
    }

    const { rating, comment } = req.body;
    let newRating = Number(review.rating);
    if (rating !== undefined) {
      if (!isValidIntegerRating(rating)) {
        return res.status(400).json({ error: 'Rating must be an integer between 1 and 5 stars.' });
      }
      newRating = Number(rating);
    }

    let newComment = review.comment;
    if (comment && typeof comment === 'string' && comment.trim()) {
      newComment = comment.trim();
    }

    const now = new Date().toISOString();
    await postgresStore.getPool().query(
      'UPDATE reviews SET rating = $1, comment = $2, updated_at = $3 WHERE id = $4',
      [newRating, newComment, now, req.params.id]
    );

    if (review.target_user_id) {
      recalculateUserRating(review.target_user_id);
    }

    if (review.order_id) {
      const order = await store.getOrder(review.order_id);
      if (order && order.review && order.review.id === review.id) {
        order.review.rating = newRating;
        order.review.comment = newComment;
        await store.saveOrder(order);
        orderIndex.set(order.id, order);
      }
    }

    res.json({
      success: true,
      review: {
        id: review.id,
        orderId: review.order_id,
        reviewerId: review.reviewer_id,
        reviewerName: review.reviewer_name,
        targetUserId: review.target_user_id,
        rating: newRating,
        comment: newComment,
        updatedAt: now
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update review' });
  }
});

router.post('/reviews/:id/reply', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });

    const revRes = await postgresStore.getPool().query('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    if (revRes.rows.length === 0) return res.status(404).json({ error: 'Review not found' });
    const review = revRes.rows[0];

    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin' || caller.role === 'support';
    const isSeller = review.target_user_id === caller.id;
    const isBuyer = review.reviewer_id === caller.id;

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
      sellerId: (isSeller || (isAdmin && asRole === 'seller') ? caller.id : (review.target_user_id || 'unknown')) as string,
      sellerName: caller.name,
      sellerAvatar: caller.avatar,
      authorId: caller.id,
      authorName: caller.name,
      authorAvatar: caller.avatar,
      role: isAdmin ? (asRole || 'admin') : (isSeller ? 'seller' : 'buyer')
    };

    let isBuyerReply = isBuyer && !isAdmin;
    if (isAdmin && asRole === 'buyer') isBuyerReply = true;

    await postgresStore.getPool().query(
      'UPDATE reviews SET reply = $1 WHERE id = $2',
      [JSON.stringify(replyObj), req.params.id]
    );

    if (review.order_id) {
      const order = await store.getOrder(review.order_id);
      if (order) {
        if (order.review && order.review.id === review.id) {
          order.review.reply = replyObj;
          await store.saveOrder(order);
          orderIndex.set(order.id, order);
        }

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
        await store.addMessage(sysMsg);
        broadcastMessage(sysMsg, order.id);
      }
    }

    res.json({ success: true, reply: replyObj });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to reply to review' });
  }
});

router.patch('/admin/reviews/:id/moderation', requireRole(['admin', 'super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const { moderationStatus } = req.body;
    await postgresStore.getPool().query(
      'UPDATE reviews SET moderation_status = $1 WHERE id = $2',
      [moderationStatus || 'approved', req.params.id]
    );

    const revRes = await postgresStore.getPool().query('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    const review = revRes.rows[0];
    if (review?.target_user_id) {
      recalculateUserRating(review.target_user_id);
    }
    res.json({ success: true, review });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to moderate review' });
  }
});

export default router;
