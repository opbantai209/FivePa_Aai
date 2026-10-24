import { Router, Request, Response } from 'express';
import { notifications } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { requireAuth, resolveAuthenticatedUserId } from '../middleware/auth.js';

const router = Router();

router.get('/notifications', requireAuth, (req: Request, res: Response) => {
  const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
  const userNotifs = notifications.filter(n => n.userId === userId);
  res.json(userNotifs);
});

router.post('/notifications/:id/read', requireAuth, (req: Request, res: Response) => {
  const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
  const notifId = req.params.id;
  const notif = notifications.find(n => n.id === notifId && n.userId === userId);
  if (notif) {
    notif.read = true;
    postgresStore.markNotificationRead(notifId, userId).catch(err => console.error('[PostgresStore] Failed to mark notification read:', err));
  }
  res.json({ success: true });
});

router.post('/notifications/read-all', requireAuth, (req: Request, res: Response) => {
  const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
  notifications.forEach(n => {
    if (n.userId === userId) n.read = true;
  });
  postgresStore.markAllNotificationsRead(userId).catch(err => console.error('[PostgresStore] Failed to mark all notifications read:', err));
  res.json({ success: true });
});

export default router;
