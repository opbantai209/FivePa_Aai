import { Router, Request, Response } from 'express';
import { users, userEmails, proposals, projects } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { isUserPublic, sanitizePublicUser } from '../publicData.js';
import {
  requireAuth,
  requireAdmin,
  adminActor,
  safeUser,
  isStaffUser
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { registerAuditLog } from '../services/orderService.js';

export const userRouter = Router();

// Public users list
userRouter.get('/users', (req: Request, res: Response) => {
  const publicUsers = users.filter(isUserPublic).map(sanitizePublicUser);
  res.json(publicUsers);
});

userRouter.get('/users/notification-preferences', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = users.find(u => u.id === authUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const prefs = user.notificationPreferences || {};
  res.json({
    emailNotifications: prefs.emailNotifications || 'Instant alerts for all messages',
    smsNotifications: prefs.smsNotifications || (user.mobile ? `Enabled (${user.mobile})` : 'Disabled'),
    marketingNotifs: prefs.marketingNotifs || 'Subscribed',
    mobile: user.mobile || null
  });
});

userRouter.patch('/users/notification-preferences', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = users.find(u => u.id === authUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { emailNotifications, smsNotifications, marketingNotifs } = req.body || {};

  if (!user.notificationPreferences) {
    user.notificationPreferences = {};
  }

  if (typeof emailNotifications === 'string') {
    user.notificationPreferences.emailNotifications = emailNotifications;
  }
  if (typeof smsNotifications === 'string') {
    user.notificationPreferences.smsNotifications = smsNotifications;
  }
  if (typeof marketingNotifs === 'string') {
    user.notificationPreferences.marketingNotifs = marketingNotifs;
  }

  postgresStore.saveUsers(users);
  res.json({
    success: true,
    notificationPreferences: user.notificationPreferences
  });
});

userRouter.patch('/users/availability', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).authenticatedUserId;
  const { isAvailableNow } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.isAvailableNow = !!isAvailableNow;
  postgresStore.saveUsers(users);
  res.json({ success: true, user: safeUser(user) });
});

userRouter.post('/users/:id/flag', requireAdmin, (req: Request, res: Response) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.isFlagged = !user.isFlagged;
  user.flagReason = user.isFlagged ? (req.body.reason || 'Flagged for TOS investigation.') : undefined;
  postgresStore.saveUsers(users);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: 'admin',
    action: user.isFlagged ? 'USER_FLAGGED_TOS' : 'USER_UNFLAGGED_TOS',
    target: `User #${user.id} (${user.name})`,
    details: user.flagReason || 'Flag removed',
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, isFlagged: user.isFlagged, flagReason: user.flagReason });
});

userRouter.get('/user/quota-status', requireAuth, (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = users.find(u => u.id === authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeSettings = siteSettings.getSettings();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const bidsUsed = proposals.filter(p => p.freelancerId === user.id && p.createdAt && p.createdAt.substring(0, 10) >= thirtyDaysAgo).length;
    const jobPostsUsed = projects.filter(p => p.buyerId === user.id && p.createdAt && p.createdAt.substring(0, 10) >= thirtyDaysAgo).length;

    const freelancerPlanId = (user as any).membershipTier || 'plan_free';
    const freelancerPlan = activeSettings.memberships.freelancerPlans.find(p => p.id === freelancerPlanId) || activeSettings.memberships.freelancerPlans[0];

    const buyerPlanId = (user as any).buyerMembershipTier || 'buyer_free';
    const buyerPlan = activeSettings.memberships.buyerPlans.find(p => p.id === buyerPlanId) || activeSettings.memberships.buyerPlans[0];

    const rawBidsLimit = freelancerPlan?.bidsPerMonth ?? 0;
    const bidsLimit = rawBidsLimit > 0 ? rawBidsLimit : null;
    const bidsRemaining = bidsLimit !== null ? Math.max(0, bidsLimit - bidsUsed) : null;

    const rawJobPostsLimit = buyerPlan?.jobPostsPerMonth ?? 0;
    const jobPostsLimit = rawJobPostsLimit > 0 ? rawJobPostsLimit : null;
    const jobPostsRemaining = jobPostsLimit !== null ? Math.max(0, jobPostsLimit - jobPostsUsed) : null;

    res.json({
      success: true,
      membershipsEnabled: activeSettings.memberships.membershipsEnabled,
      freelancer: {
        planId: freelancerPlanId,
        planName: freelancerPlan?.name || 'Standard Freelancer',
        bidsUsed,
        bidsLimit,
        bidsRemaining,
        unlimited: bidsLimit === null
      },
      buyer: {
        planId: buyerPlanId,
        planName: buyerPlan?.name || 'Standard Client',
        jobPostsUsed,
        jobPostsLimit,
        jobPostsRemaining,
        unlimited: jobPostsLimit === null
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

userRouter.post('/user/membership', requireAuth, (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = users.find(u => u.id === authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeSettings = siteSettings.getSettings();
    const { freelancerPlanId, buyerPlanId } = req.body || {};
    if (freelancerPlanId) {
      const plan = activeSettings.memberships.freelancerPlans.find(p => p.id === freelancerPlanId);
      if (!plan || !plan.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled membership plan.' });
      }
      if (plan.priceMonthly > 0) {
        return res.status(402).json({ error: 'Paid plans require checkout' });
      }
      (user as any).membershipTier = freelancerPlanId;
    }
    if (buyerPlanId) {
      const plan = activeSettings.memberships.buyerPlans.find(p => p.id === buyerPlanId);
      if (!plan || !plan.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled buyer plan.' });
      }
      if (plan.priceMonthly > 0) {
        return res.status(402).json({ error: 'Paid plans require checkout' });
      }
      (user as any).buyerMembershipTier = buyerPlanId;
    }
    postgresStore.saveUsers(users);
    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/user-emails/:userId', requireAuth, (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const targetUser = users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const isSelf = caller.id === req.params.userId;
  const isSuperAdmin = caller.role === 'super_admin';
  const isAdmin = caller.role === 'admin';
  const isSupport = caller.role === 'support';
  const isTargetAdmin = targetUser.role === 'admin' || targetUser.role === 'super_admin';

  if (!isSelf) {
    if (isSupport && isTargetAdmin) {
      return res.status(403).json({ error: 'Forbidden: Support staff cannot inspect administrator emails.' });
    }
    if (isAdmin && targetUser.role === 'super_admin') {
      return res.status(403).json({ error: 'Forbidden: Only super_admin can inspect super_admin emails.' });
    }
    if (!isAdmin && !isSuperAdmin && !isSupport) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    }
  }

  const userList = userEmails
    .filter(e => e.userId === req.params.userId)
    .map(e => ({
      ...e,
      snippet: e.snippet ? e.snippet.replace(/\b\d{6}\b/g, '******') : '',
      body: e.body ? e.body.replace(/\b\d{6}\b/g, '******') : ''
    }));

  res.json(userList);
});

userRouter.patch('/user-emails/:id/read', requireAuth, (req: Request, res: Response) => {
  const em = userEmails.find(e => e.id === req.params.id);
  if (!em) return res.status(404).json({ error: 'Notification not found' });
  const callerId = (req as any).authenticatedUserId;
  if (em.userId !== callerId && !isStaffUser((req as any).authenticatedUser)) return res.status(404).json({ error: 'Notification not found' });
  em.read = true;
  postgresStore.saveUserEmails(userEmails).catch(err => console.error('[PostgresStore] Failed to save user emails:', err));
  res.json({ success: true });
});
