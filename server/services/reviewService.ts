import { reviews, users, type Review } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';

export function isValidIntegerRating(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  const num = Number(val);
  return typeof num === 'number' && !isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 5;
}

export function isReviewPublic(r: Review): boolean {
  if (!r) return false;
  // Reviews on cancelled orders are private dispute/cancellation records between participants and staff
  if (r.isCancelledOrder) return false;
  // Non-approved, hidden, or non-public moderation status
  if ((r as any).moderationStatus && (r as any).moderationStatus !== 'approved') return false;
  if ((r as any).status && !['approved', 'published', 'active'].includes((r as any).status)) return false;
  return true;
}

export function recalculateUserRating(userId: string) {
  const targetUser = users.find(u => u.id === userId);
  if (!targetUser) return;
  const publicUserReviews = reviews.filter(r => r.targetUserId === userId && isReviewPublic(r));
  targetUser.reviewsCount = publicUserReviews.length;
  if (publicUserReviews.length > 0) {
    targetUser.rating = Number((publicUserReviews.reduce((sum, r) => sum + r.rating, 0) / publicUserReviews.length).toFixed(1));
  } else {
    targetUser.rating = 0;
  }
  postgresStore.saveUsers(users).catch(err => console.error('[PostgresStore] Failed to save users after rating recalculation:', err));
}

export function sanitizePublicReview(r: Review): Review {
  const { moderationReason, moderationNotes, ...publicRev } = r as any;
  return publicRev;
}
