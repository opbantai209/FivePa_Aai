import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  type Project,
  type ProjectClarification
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { isProjectPublic, sanitizePublicProject } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  adminActor,
  resolveAuthenticatedUserId,
  isStaffUser,
  rateLimit,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { createNotification } from '../services/notificationService.js';
import { registerAuditLog } from '../services/orderService.js';
import { diagnosticService } from '../services/diagnosticService.js';

export const projectRouter = Router();

export async function getBuyerStats(buyerId: string) {
  try {
    const [ordersRes, projectsRes, proposalsRes] = await Promise.all([
      postgresStore.getPool().query('SELECT amount, status FROM orders WHERE buyer_id = $1', [buyerId]),
      postgresStore.getPool().query('SELECT id, status, proposals_count FROM projects WHERE buyer_id = $1', [buyerId]),
      postgresStore.getPool().query(
        'SELECT project_id, status FROM proposals WHERE project_id IN (SELECT id FROM projects WHERE buyer_id = $1)',
        [buyerId]
      )
    ]);

    const buyerOrders = ordersRes.rows;
    const buyerProjects = projectsRes.rows;
    const proposalsList = proposalsRes.rows;

    let hiredCount = 0;
    let decidedCount = 0;

    for (const proj of buyerProjects) {
      const hasAcceptedProposal = proposalsList.some(p => p.project_id === proj.id && p.status === 'accepted');
      const isHired = hasAcceptedProposal || proj.status === 'in_progress';
      const isDecided = isHired || (proj.status === 'completed' && Number(proj.proposals_count || 0) > 0);

      if (isHired) hiredCount++;
      if (isDecided) decidedCount++;
    }

    const hireRate = decidedCount >= 3 ? hiredCount / decidedCount : null;
    const totalSpent = buyerOrders.filter(o => o.status === 'completed').reduce((sum, o) => sum + Number(o.amount || 0), 0);
    const completedCount = buyerOrders.filter(o => o.status === 'completed').length;

    return {
      buyerSpent: totalSpent,
      buyerCompletedProjects: completedCount,
      hireRate,
      buyerProjectsPosted: buyerProjects.length
    };
  } catch {
    return {
      buyerSpent: 0,
      buyerCompletedProjects: 0,
      hireRate: null,
      buyerProjectsPosted: 0
    };
  }
}

// Public projects list
projectRouter.get('/projects', async (req: Request, res: Response) => {
  try {
    const projects = await postgresStore.listProjects();
    const publicProjects = await Promise.all(
      projects
        .filter(p => isProjectPublic(p) && (p.status === 'open' || p.status === 'published' || p.status === 'in_progress'))
        .map(async p => {
          const stats = await getBuyerStats(p.buyerId);
          return sanitizePublicProject({ ...p, ...stats });
        })
    );
    res.json(publicProjects);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list projects' });
  }
});

// Single Project Detail
projectRouter.get('/projects/:id', async (req: Request, res: Response) => {
  try {
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const r = projRes.rows[0];
    const project: Project = {
      id: r.id,
      buyerId: r.buyer_id,
      buyerName: r.buyer_name,
      buyerAvatar: r.buyer_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      title: r.title,
      slug: r.slug || undefined,
      category: r.category,
      subcategory: r.subcategory || undefined,
      description: r.description || '',
      budgetMin: Number(r.budget_min),
      budgetMax: Number(r.budget_max),
      budget: r.budget ? Number(r.budget) : undefined,
      budgetType: r.budget_type || undefined,
      duration: r.duration || undefined,
      skills: r.skills || [],
      deadlineDays: Number(r.deadline_days),
      proposalsCount: Number(r.proposals_count),
      createdAt: r.created_at,
      status: r.status,
      featured: Boolean(r.featured),
      moderationStatus: r.moderation_status || undefined,
      moderationNotes: r.moderation_notes || undefined
    };

    const authUserId = resolveAuthenticatedUserId(req);
    const userRes = authUserId ? await postgresStore.getPool().query('SELECT role FROM users WHERE id = $1', [authUserId]) : null;
    const callerRole = userRes?.rows[0]?.role;
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';
    const isOwner = Boolean(authUserId && project.buyerId === authUserId);

    const stats = await getBuyerStats(project.buyerId);

    if (isProjectPublic(project)) {
      if (isAdmin || isOwner) return res.json({ ...project, ...stats });
      return res.json(sanitizePublicProject({ ...project, ...stats }));
    }

    if (isAdmin || isOwner) {
      return res.json({ ...project, ...stats });
    }
    return res.status(404).json({ error: 'Project not found or unavailable' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get project' });
  }
});

// Authenticated Owner Listings
projectRouter.get('/my/projects', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const projRes = await postgresStore.getPool().query(
      'SELECT * FROM projects WHERE buyer_id = $1 ORDER BY created_at DESC',
      [authUserId]
    );
    const myProjects = projRes.rows.map(r => ({
      id: r.id,
      buyerId: r.buyer_id,
      buyerName: r.buyer_name,
      buyerAvatar: r.buyer_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      title: r.title,
      slug: r.slug || undefined,
      category: r.category,
      subcategory: r.subcategory || undefined,
      description: r.description || '',
      budgetMin: Number(r.budget_min),
      budgetMax: Number(r.budget_max),
      budget: r.budget ? Number(r.budget) : undefined,
      budgetType: r.budget_type || undefined,
      duration: r.duration || undefined,
      skills: r.skills || [],
      deadlineDays: Number(r.deadline_days),
      proposalsCount: Number(r.proposals_count),
      createdAt: r.created_at,
      status: r.status,
      featured: Boolean(r.featured),
      moderationStatus: r.moderation_status || undefined,
      moderationNotes: r.moderation_notes || undefined
    }));
    res.json(myProjects);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list my projects' });
  }
});

// Project Clarifications
projectRouter.get('/projects/:id/clarifications', async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projRes.rows.length === 0) return res.json([]);
    const project = projRes.rows[0];

    const callerId = (req as any).authenticatedUserId;
    const callerUser = (req as any).authenticatedUser;
    const isBuyer = callerId && project.buyer_id === callerId;
    const isStaff = callerUser && isStaffUser(callerUser);

    const propCheck = callerId ? await postgresStore.getPool().query(
      'SELECT id FROM proposals WHERE project_id = $1 AND freelancer_id = $2',
      [projectId, callerId]
    ) : { rows: [] };
    const hasProposal = propCheck.rows.length > 0;

    if (project.status === 'open' || project.status === 'published' || isBuyer || isStaff || hasProposal) {
      const clarRes = await postgresStore.getPool().query(
        'SELECT * FROM project_clarifications WHERE project_id = $1 ORDER BY timestamp ASC',
        [projectId]
      );
      const projectClarificationsList = clarRes.rows.map(c => ({
        id: c.id,
        projectId: c.project_id,
        userId: c.user_id,
        userName: c.user_name,
        userAvatar: c.user_avatar || '',
        text: c.text,
        timestamp: c.timestamp,
        replies: c.replies || []
      }));
      return res.json(projectClarificationsList);
    }
    return res.json([]);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list clarifications' });
  }
});

projectRouter.post('/projects/:id/clarifications', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];

    const userId = (req as any).authenticatedUserId;
    const user = (req as any).authenticatedUser;
    const { text, replyToId } = req.body;

    if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required.' });

    if (replyToId) {
      const clarRes = await postgresStore.getPool().query(
        'SELECT * FROM project_clarifications WHERE id = $1 AND project_id = $2',
        [replyToId, projectId]
      );
      if (clarRes.rows.length === 0) return res.status(404).json({ error: 'Parent question not found.' });
      const parent = clarRes.rows[0];

      const isOwner = project.buyer_id === userId;
      const isStaff = isStaffUser(user);
      if (!isOwner && !isStaff) return res.status(403).json({ error: 'Only the project owner can respond to clarifications.' });

      const replies = parent.replies || [];
      replies.push({
        id: 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        text: text.trim().slice(0, 2000),
        timestamp: new Date().toISOString()
      });

      await postgresStore.getPool().query(
        'UPDATE project_clarifications SET replies = $1 WHERE id = $2',
        [JSON.stringify(replies), replyToId]
      );
    } else {
      const newClarId = 'clar_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const timestamp = new Date().toISOString();
      await postgresStore.getPool().query(
        `INSERT INTO project_clarifications (id, project_id, user_id, user_name, user_avatar, text, timestamp, replies)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb)`,
        [newClarId, projectId, userId, user.name, user.avatar || null, text.trim().slice(0, 2000), timestamp]
      );

      createNotification({
        userId: project.buyer_id,
        type: 'project',
        title: 'New Clarification Question',
        message: `${user.name} asked a question about "${project.title}".`,
        link: `/projects/${project.slug || project.id}`
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to post clarification' });
  }
});

// Create Project
projectRouter.post('/projects', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot post new projects while your account is restricted.' });

    const activeSettings = siteSettings.getSettings();
    const minBudget = activeSettings.marketplace.minimumProjectBudget ?? 5;
    const budgetMin = Number(req.body.budgetMin);
    if (minBudget > 0 && budgetMin < minBudget) {
      return res.status(400).json({
        error: `Project budget ($${budgetMin}) is below the platform minimum requirement of $${minBudget}.`
      });
    }

    const newProjId = 'proj_' + Date.now() + '_' + randomUUID().slice(0, 8);
    const title = escapeHtml(req.body.title || 'Untitled Project');
    const category = req.body.category || 'Development & IT';
    const subcategory = req.body.subcategory || 'General';
    const description = escapeHtml(req.body.description || '');
    const budgetMax = Number(req.body.budgetMax || budgetMin);
    const deadlineDays = 14;
    const createdAt = new Date().toISOString().split('T')[0];

    await postgresStore.getPool().query(
      `INSERT INTO projects (
        id, buyer_id, buyer_name, buyer_avatar, title, category, subcategory, 
        description, budget_min, budget_max, deadline_days, proposals_count, 
        created_at, status, featured, moderation_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, 'open', FALSE, 'approved')`,
      [newProjId, caller.id, caller.name, caller.avatar || null, title, category, subcategory, description, budgetMin, budgetMax, deadlineDays, createdAt]
    );

    const newProj: Project = {
      id: newProjId,
      buyerId: caller.id,
      buyerName: caller.name,
      buyerAvatar: caller.avatar,
      title,
      category,
      subcategory,
      description,
      budgetMin,
      budgetMax,
      deadlineDays,
      proposalsCount: 0,
      createdAt,
      status: 'open',
      featured: false
    };

    res.json(newProj);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create project' });
  }
});

// Update Project Status
projectRouter.patch('/projects/:id/status', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser;
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });

    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projRes.rows[0];

    if (p.buyer_id !== caller.id && !isStaffUser(caller)) {
      return res.status(403).json({ error: 'Forbidden: Only the project owner can update this project status.' });
    }

    const requestedStatus = typeof req.body?.status === 'string' ? req.body.status.trim().toLowerCase() : 'completed';
    const allowedStatuses: Project['status'][] = ['open', 'published', 'in_progress', 'completed', 'unpublished'];
    if (!allowedStatuses.includes(requestedStatus as Project['status'])) {
      return res.status(400).json({ error: 'Invalid project status.' });
    }

    const oldStatus = p.status;
    await postgresStore.getPool().query('UPDATE projects SET status = $1 WHERE id = $2', [requestedStatus, req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role || 'user',
      action: `PROJECT_STATUS_${requestedStatus.toUpperCase()}`,
      target: `Project "${p.title}"`,
      details: `Buyer changed project status from "${oldStatus}" to "${requestedStatus}"`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ ...p, status: requestedStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update project status' });
  }
});

// Admin: List all projects with admin moderation metadata
projectRouter.get('/admin/projects', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projects = await postgresStore.listProjects();
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list admin projects' });
  }
});

// Admin: Update project details, status, and moderation
projectRouter.patch('/admin/projects/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) {
      diagnosticService.log('warning', 'projectService', 'adminUpdateProject', 'server/routes/projectRoutes.ts', 'admin_update_project', 'FAILED', { projectId: req.params.id }, 'Project not found');
      return res.status(404).json({ error: 'Project not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.title !== undefined) {
      updates.push(`title = $${idx++}`);
      values.push(escapeHtml(String(req.body.title)));
    }
    if (req.body.category !== undefined && typeof req.body.category === 'string') {
      updates.push(`category = $${idx++}`);
      values.push(req.body.category.trim().slice(0, 100));
    }
    if (req.body.subcategory !== undefined && typeof req.body.subcategory === 'string') {
      updates.push(`subcategory = $${idx++}`);
      values.push(req.body.subcategory.trim().slice(0, 100));
    }
    if (req.body.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(escapeHtml(String(req.body.description)));
    }
    if (req.body.budgetMin !== undefined) {
      updates.push(`budget_min = $${idx++}`);
      values.push(Number(req.body.budgetMin));
    }
    if (req.body.budgetMax !== undefined) {
      updates.push(`budget_max = $${idx++}`);
      values.push(Number(req.body.budgetMax));
    }
    if (req.body.deadlineDays !== undefined) {
      updates.push(`deadline_days = $${idx++}`);
      values.push(Math.max(1, Math.min(365, Number(req.body.deadlineDays) || 14)));
    }
    if (req.body.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(req.body.status);
    }
    if (req.body.moderationStatus !== undefined) {
      updates.push(`moderation_status = $${idx++}`);
      values.push(req.body.moderationStatus);
    }
    if (req.body.moderationNotes !== undefined) {
      updates.push(`moderation_notes = $${idx++}`);
      values.push(req.body.moderationNotes);
    }
    if (req.body.featured !== undefined) {
      updates.push(`featured = $${idx++}`);
      values.push(Boolean(req.body.featured));
    }

    if (updates.length > 0) {
      values.push(req.params.id);
      await postgresStore.getPool().query(
        `UPDATE projects SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    const updatedRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    res.json(updatedRes.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update project' });
  }
});

// Admin: Update project status
projectRouter.patch('/admin/projects/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projRes.rows[0];

    const oldStatus = p.status;
    const newStatus = req.body.status;
    await postgresStore.getPool().query('UPDATE projects SET status = $1 WHERE id = $2', [newStatus, req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: 'super_admin',
      action: `PROJECT_STATUS_${String(newStatus).toUpperCase()}`,
      target: `Project "${p.title}"`,
      details: `Admin changed status from "${oldStatus}" to "${newStatus}"`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ ...p, status: newStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update status' });
  }
});

// Admin: Toggle project featured
projectRouter.patch('/admin/projects/:id/feature', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projRes.rows[0];
    const newFeatured = !p.featured;
    await postgresStore.getPool().query('UPDATE projects SET featured = $1 WHERE id = $2', [newFeatured, req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: 'super_admin',
      action: newFeatured ? 'ADMIN_PROJECT_FEATURED' : 'ADMIN_PROJECT_UNFEATURED',
      target: `Project "${p.title}"`,
      details: `Admin toggled featured status to ${newFeatured}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ ...p, featured: newFeatured });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to toggle featured' });
  }
});

// Admin: Delete project
projectRouter.delete('/admin/projects/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const deleted = projRes.rows[0];

    await postgresStore.getPool().query('DELETE FROM projects WHERE id = $1', [req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: 'super_admin',
      action: 'ADMIN_PROJECT_DELETED',
      target: `Project "${deleted.title}"`,
      details: `Admin permanently removed project #${deleted.id}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, id: deleted.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete project' });
  }
});
