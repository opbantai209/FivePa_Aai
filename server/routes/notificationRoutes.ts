import { Router, Request, Response } from 'express';
import { postgresStore } from '../db/postgresStore.js';
import { requireAuth, resolveAuthenticatedUserId } from '../middleware/auth.js';

const router = Router();

router.get('/notifications', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
    const result = await postgresStore.getPool().query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const userNotifs = result.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      message: r.message,
      link: r.link || undefined,
      read: Boolean(r.read),
      createdAt: r.created_at,
      dedupKey: r.dedup_key || undefined
    }));
    res.json(userNotifs);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list notifications' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
    const notifId = req.params.id;
    await postgresStore.markNotificationRead(notifId, userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to mark notification read' });
  }
});

router.post('/notifications/read-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = resolveAuthenticatedUserId(req) || (req as any).user?.id;
    await postgresStore.markAllNotificationsRead(userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to mark notifications read' });
  }
});

export default router;
