import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  projects,
  orders,
  proposals,
  users,
  projectClarifications,
  saveProjectClarificationsToDisk,
  type Project,
  type ProjectClarification
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { isProjectPublic, sanitizePublicProject } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  resolveAuthenticatedUserId,
  isStaffUser,
  rateLimit,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { createNotification } from '../services/notificationService.js';
import { registerAuditLog } from '../services/orderService.js';

export const projectRouter = Router();

export function getBuyerStats(buyerId: string) {
  const buyerOrders = orders.filter(o => o.buyerId === buyerId);
  const buyerProjects = projects.filter(p => p.buyerId === buyerId);

  let hiredCount = 0;
  let decidedCount = 0;

  for (const proj of buyerProjects) {
    const hasAcceptedProposal = proposals.some(p => p.projectId === proj.id && p.status === 'accepted');
    const isHired = hasAcceptedProposal || proj.status === 'in_progress';
    const isDecided = isHired || (proj.status === 'completed' && (proj.proposalsCount || 0) > 0);

    if (isHired) hiredCount++;
    if (isDecided) decidedCount++;
  }

  const hireRate = decidedCount >= 3 ? hiredCount / decidedCount : null;
  const totalSpent = buyerOrders.filter(o => o.status === 'completed').reduce((sum, o) => sum + (o.amount || 0), 0);
  const completedCount = buyerOrders.filter(o => o.status === 'completed').length;

  return {
    buyerSpent: totalSpent,
    buyerCompletedProjects: completedCount,
    hireRate,
    buyerProjectsPosted: buyerProjects.length
  };
}

// Public projects list
projectRouter.get('/projects', (req: Request, res: Response) => {
  const publicProjects = projects
    .filter(p => isProjectPublic(p) && (p.status === 'open' || p.status === 'published'))
    .map(p => {
      const stats = getBuyerStats(p.buyerId);
      return sanitizePublicProject({ ...p, ...stats });
    });
  res.json(publicProjects);
});

// Single Project Detail
projectRouter.get('/projects/:id', (req: Request, res: Response) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const authUserId = resolveAuthenticatedUserId(req);
  const caller = authUserId ? users.find(u => u.id === authUserId) : null;
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
  const isOwner = authUserId && project.buyerId === authUserId;

  if (isProjectPublic(project)) {
    const stats = getBuyerStats(project.buyerId);
    if (isAdmin || isOwner) return res.json({ ...project, ...stats });
    return res.json(sanitizePublicProject({ ...project, ...stats }));
  }

  if (isAdmin || isOwner) {
    return res.json(project);
  }
  return res.status(404).json({ error: 'Project not found or unavailable' });
});

// Authenticated Owner Listings
projectRouter.get('/my/projects', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const myProjects = projects.filter(p => p.buyerId === authUserId);
  res.json(myProjects);
});

// Project Clarifications
projectRouter.get('/projects/:id/clarifications', (req: Request, res: Response) => {
  const projectId = req.params.id;
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.json([]);

  const callerId = (req as any).authenticatedUserId;
  const callerUser = (req as any).authenticatedUser;
  const isBuyer = callerId && project.buyerId === callerId;
  const isStaff = callerUser && isStaffUser(callerUser);
  const hasProposal = callerId && proposals.some(pr => pr.projectId === projectId && pr.freelancerId === callerId);

  if (isProjectPublic(project) || isBuyer || isStaff || hasProposal) {
    const projectClarificationsList = projectClarifications.filter(c => c.projectId === projectId);
    return res.json(projectClarificationsList);
  }
  return res.json([]);
});

projectRouter.post('/projects/:id/clarifications', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const userId = (req as any).authenticatedUserId;
  const user = (req as any).authenticatedUser;
  const { text, replyToId } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required.' });

  if (replyToId) {
    const parent = projectClarifications.find(c => c.id === replyToId && c.projectId === projectId);
    if (!parent) return res.status(404).json({ error: 'Parent question not found.' });

    const isOwner = project.buyerId === userId;
    const isStaff = isStaffUser(user);
    if (!isOwner && !isStaff) return res.status(403).json({ error: 'Only the project owner can respond to clarifications.' });

    if (!parent.replies) parent.replies = [];
    parent.replies.push({
      id: 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      userId,
      userName: user.name,
      userAvatar: user.avatar,
      text: text.trim().slice(0, 2000),
      timestamp: new Date().toISOString()
    });
  } else {
    const newClarification: ProjectClarification = {
      id: 'clar_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      projectId,
      userId,
      userName: user.name,
      userAvatar: user.avatar,
      text: text.trim().slice(0, 2000),
      timestamp: new Date().toISOString(),
      replies: []
    };
    projectClarifications.push(newClarification);

    createNotification({
      userId: project.buyerId,
      type: 'project',
      title: 'New Clarification Question',
      message: `${user.name} asked a question about "${project.title}".`,
      link: `/project/${project.slug || project.id}`
    });
  }

  await saveProjectClarificationsToDisk();
  res.json({ success: true });
});

// Create Project
projectRouter.post('/projects', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
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

  const newProj: Project = {
    id: 'proj_' + Date.now() + '_' + randomUUID().slice(0, 8),
    buyerId: caller.id,
    buyerName: caller.name,
    buyerAvatar: caller.avatar,
    title: escapeHtml(req.body.title || 'Untitled Project'),
    category: req.body.category || 'Development & IT',
    subcategory: req.body.subcategory || 'General',
    description: escapeHtml(req.body.description || ''),
    budgetMin: Number(req.body.budgetMin),
    budgetMax: Number(req.body.budgetMax),
    deadlineDays: 14,
    proposalsCount: 0,
    createdAt: new Date().toISOString().split('T')[0],
    status: 'open',
    featured: false
  };
  projects.unshift(newProj);
  try {
    await postgresStore.saveProjects(projects);
  } catch (err) {
    console.error('[CreateProject] Failed to persist:', err);
    const idx = projects.findIndex(p => p.id === newProj.id);
    if (idx !== -1) projects.splice(idx, 1);
    return res.status(500).json({ error: 'Could not save. Please try again.' });
  }
  res.json(newProj);
});

// Update Project Status
projectRouter.patch('/projects/:id/status', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = (req as any).authenticatedUser || users.find(u => u.id === authUserId);
  if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });

  const p = projects.find(proj => proj.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });

  if (p.buyerId !== caller.id && !isStaffUser(caller)) {
    return res.status(403).json({ error: 'Forbidden: Only the project owner can update this project status.' });
  }

  const requestedStatus = typeof req.body?.status === 'string' ? req.body.status.trim().toLowerCase() : 'completed';
  const allowedStatuses: Project['status'][] = ['open', 'published', 'in_progress', 'completed', 'unpublished'];
  if (!allowedStatuses.includes(requestedStatus as Project['status'])) {
    return res.status(400).json({ error: 'Invalid project status.' });
  }

  const oldStatus = p.status;
  p.status = requestedStatus as Project['status'];
  postgresStore.saveProjects(projects);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: caller.name,
    role: caller.role || 'user',
    action: `PROJECT_STATUS_${p.status.toUpperCase()}`,
    target: `Project "${p.title}"`,
    details: `Buyer changed project status from "${oldStatus}" to "${p.status}" (${p.status === 'completed' ? 'Closed bidding & hidden from public listing' : 'Updated listing status'})`,
    timestamp: new Date().toLocaleString()
  });

  res.json(p);
});
