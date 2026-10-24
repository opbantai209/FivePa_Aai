import { Router, Request, Response } from 'express';
import { store } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { isUserPublic, sanitizePublicUser } from '../publicData.js';
import {
  requireAuth,
  requireAdmin,
  adminActor,
  safeUser,
  isStaffUser,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { registerAuditLog } from '../services/orderService.js';

export const userRouter = Router();

// Public users list
userRouter.get('/users', async (req: Request, res: Response) => {
  try {
    const publicUsers = await store.listPublicUsers();
    res.json(publicUsers.map(sanitizePublicUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list users' });
  }
});

// Update authenticated user profile
userRouter.patch('/users/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const {
      name,
      title,
      bio,
      hourlyRate,
      skills,
      avatar,
      isAvailableNow,
      username
    } = req.body || {};

    if (typeof name === 'string' && name.trim()) {
      user.name = escapeHtml(name.trim().slice(0, 80));
    }
    if (typeof title === 'string') {
      user.title = escapeHtml(title.trim().slice(0, 120));
    }
    if (typeof bio === 'string') {
      user.bio = escapeHtml(bio.trim());
    }
    if (typeof hourlyRate === 'number' && Number.isFinite(hourlyRate) && hourlyRate >= 0) {
      user.hourlyRate = hourlyRate;
    }
    if (Array.isArray(skills)) {
      user.skills = skills.map((s: any) => String(s).trim()).filter(Boolean);
    } else if (typeof skills === 'string') {
      user.skills = skills.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (typeof avatar === 'string' && avatar.trim()) {
      user.avatar = avatar.trim();
    }
    if (typeof isAvailableNow === 'boolean') {
      user.isAvailableNow = isAvailableNow;
    }
    if (typeof username === 'string' && username.trim() && username.trim().toLowerCase() !== user.username?.toLowerCase()) {
      const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
      if (cleanUsername) {
        const check = await postgresStore.getPool().query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2', [cleanUsername, user.id]);
        if (check.rows.length > 0) {
          return res.status(409).json({ error: 'Username is already taken.' });
        }
        user.username = cleanUsername;
      }
    }

    try {
      await store.saveUser(user);
    } catch (saveErr: any) {
      if (saveErr.code === '23505' || saveErr.message?.includes('idx_unique_lower_username') || saveErr.message?.includes('duplicate key')) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      throw saveErr;
    }

    if (user.role === 'freelancer') {
      await postgresStore.getPool().query(
        `UPDATE gigs SET 
          freelancer_name = $1, 
          freelancer_username = $2, 
          freelancer_avatar = $3 
         WHERE freelancer_id = $4`,
        [user.name, user.username || null, user.avatar || null, user.id]
      );
    }

    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update profile' });
  }
});

// Update user email address
userRouter.patch('/users/email', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { email } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail === user.email.toLowerCase()) {
      return res.json({ success: true, user: safeUser(user) });
    }

    const check = await postgresStore.getPool().query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [normalizedEmail, user.id]);
    if (check.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    user.email = normalizedEmail;
    try {
      await store.saveUser(user);
    } catch (saveErr: any) {
      if (saveErr.code === '23505' || saveErr.message?.includes('idx_unique_lower_username') || saveErr.message?.includes('duplicate key')) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      throw saveErr;
    }
    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update email' });
  }
});

// Get user profile by ID
userRouter.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await store.getUser(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(safeUser(user));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch user' });
  }
});

userRouter.get('/users/notification-preferences', requireAuth, async (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = await store.getUser(authUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const prefs = user.notificationPreferences || {};
  res.json({
    emailNotifications: prefs.emailNotifications || 'Instant alerts for all messages',
    smsNotifications: prefs.smsNotifications || (user.mobile ? `Enabled (${user.mobile})` : 'Disabled'),
    marketingNotifs: prefs.marketingNotifs || 'Subscribed',
    mobile: user.mobile || null
  });
});

userRouter.patch('/users/notification-preferences', requireAuth, async (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = await store.getUser(authUserId);
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

  await store.saveUser(user);
  res.json({
    success: true,
    notificationPreferences: user.notificationPreferences
  });
});

userRouter.patch('/users/availability', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).authenticatedUserId;
  const { isAvailableNow } = req.body;
  const user = await store.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.isAvailableNow = !!isAvailableNow;
  await store.saveUser(user);
  res.json({ success: true, user: safeUser(user) });
});

userRouter.post('/users/:id/flag', requireAdmin, async (req: Request, res: Response) => {
  const user = await store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.isFlagged = !user.isFlagged;
  user.flagReason = user.isFlagged ? (req.body.reason || 'Flagged for TOS investigation.') : undefined;
  await store.saveUser(user);

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

userRouter.get('/user/quota-status', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeSettings = siteSettings.getSettings();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [bidsRes, jobPostsRes] = await Promise.all([
      postgresStore.getPool().query(
        'SELECT count(*) FROM proposals WHERE freelancer_id = $1 AND created_at >= $2',
        [user.id, thirtyDaysAgo]
      ),
      postgresStore.getPool().query(
        'SELECT count(*) FROM projects WHERE buyer_id = $1 AND created_at >= $2',
        [user.id, thirtyDaysAgo]
      )
    ]);

    const bidsUsed = parseInt(bidsRes.rows[0]?.count || '0', 10);
    const jobPostsUsed = parseInt(jobPostsRes.rows[0]?.count || '0', 10);

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

userRouter.post('/user/membership', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
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
    try {
      await store.saveUser(user);
    } catch (saveErr: any) {
      if (saveErr.code === '23505' || saveErr.message?.includes('idx_unique_lower_username') || saveErr.message?.includes('duplicate key')) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      throw saveErr;
    }
    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/user-emails/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    const targetUser = await store.getUser(req.params.userId);
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

    const emailRes = await postgresStore.getPool().query(
      'SELECT * FROM user_emails WHERE user_id = $1 ORDER BY date DESC',
      [req.params.userId]
    );

    const userList = emailRes.rows.map(e => ({
      id: e.id,
      userId: e.user_id,
      userEmail: e.user_email,
      subject: e.subject,
      snippet: e.snippet ? e.snippet.replace(/\b\d{6}\b/g, '******') : '',
      body: e.body ? e.body.replace(/\b\d{6}\b/g, '******') : '',
      date: e.date,
      read: e.read,
      type: e.type || 'GENERAL'
    }));

    res.json(userList);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list user emails' });
  }
});

userRouter.patch('/user-emails/:id/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const callerId = (req as any).authenticatedUserId;
    const isStaff = isStaffUser((req as any).authenticatedUser);

    if (isStaff) {
      await postgresStore.getPool().query('UPDATE user_emails SET read = TRUE WHERE id = $1', [req.params.id]);
    } else {
      await postgresStore.getPool().query('UPDATE user_emails SET read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, callerId]);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to mark email read' });
  }
});
