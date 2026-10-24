import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { gigs, users, type Gig } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { isGigPublic, sanitizePublicGig } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  resolveAuthenticatedUserId,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { financeLedger } from '../../src/server/financeLedger.js';
import { registerAuditLog } from '../services/orderService.js';

export const gigRouter = Router();

// Public gigs list
gigRouter.get('/gigs', (req: Request, res: Response) => {
  const publicGigs = gigs.filter(isGigPublic).map(sanitizePublicGig);
  res.json(publicGigs);
});

// Single Gig Detail
gigRouter.get('/gigs/:id', (req: Request, res: Response) => {
  const gig = gigs.find(g => g.id === req.params.id);
  if (!gig) return res.status(404).json({ error: 'Gig not found' });

  const authUserId = resolveAuthenticatedUserId(req);
  const caller = authUserId ? users.find(u => u.id === authUserId) : null;
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
  const isOwner = authUserId && gig.freelancerId === authUserId;

  if (isGigPublic(gig)) {
    if (isAdmin || isOwner) return res.json(gig);
    return res.json(sanitizePublicGig(gig));
  }

  if (isAdmin || isOwner) {
    return res.json(gig);
  }
  return res.status(404).json({ error: 'Gig not found or unavailable' });
});

// Authenticated Owner Listings
gigRouter.get('/my/gigs', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const myGigs = gigs.filter(g => g.freelancerId === authUserId);
  res.json(myGigs);
});

// Create Gig
gigRouter.post('/gigs', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot post new services while your account is restricted.' });

  const activeSettings = siteSettings.getSettings();
  const gigPrice = Number(req.body.price);
  if (!Number.isFinite(gigPrice)) return res.status(400).json({ error: 'Gig price must be a valid number.' });
  const minGigPrice = activeSettings.marketplace.minimumGigPrice ?? 5;
  const maxGigPrice = activeSettings.marketplace.maximumGigPrice ?? 10000;
  if (gigPrice < minGigPrice) {
    return res.status(400).json({ error: `Gig price ($${gigPrice}) cannot be lower than the platform minimum of $${minGigPrice}.` });
  }
  if (gigPrice > maxGigPrice) {
    return res.status(400).json({ error: `Gig price ($${gigPrice}) cannot exceed the platform maximum of $${maxGigPrice}.` });
  }

  const deliveryDays = Math.min(365, Math.max(1, Math.round(Number(req.body.deliveryDays)) || 7));
  const category = typeof req.body.category === 'string' ? req.body.category.trim().slice(0, 100) || 'Development & IT' : 'Development & IT';
  const subcategory = typeof req.body.subcategory === 'string' ? req.body.subcategory.trim().slice(0, 100) || 'General' : 'General';
  const rawImage = req.body.image;
  const defaultImage = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&h=500&fit=crop';
  const image = (typeof rawImage === 'string' && !/^\s*(javascript:|vbscript:|data:(?!image\/))/i.test(rawImage)) ? rawImage : defaultImage;
  let extras: { id: string; title: string; price: number }[] = [];
  if (Array.isArray(req.body.extras)) {
    extras = req.body.extras.slice(0, 20).map((ex: any, idx: number) => ({
      id: String(ex?.id || `extra_${Date.now()}_${idx}`),
      title: String(ex?.title || '').slice(0, 200),
      price: Math.round(Math.min(100000, Math.max(0, Number(ex?.price) || 0)) * 100) / 100
    }));
  }

  const initialStatus = activeSettings.marketplace.gigModerationRequired ? 'pending' : 'published';

  const newGig: Gig = {
    id: 'gig_' + Date.now() + '_' + randomUUID().slice(0, 8),
    freelancerId: caller.id,
    freelancerName: caller.name,
    freelancerUsername: caller.username || caller.name.toLowerCase().replace(/\s+/g, '_'),
    freelancerAvatar: caller.avatar,
    freelancerLevel: 'Level 1 ★',
    title: escapeHtml(req.body.title || 'Untitled Gig'),
    slug: req.body.title ? req.body.title.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') : 'custom-gig',
    category,
    subcategory,
    description: escapeHtml(req.body.description || ''),
    price: gigPrice,
    deliveryDays,
    rating: 0,
    reviewsCount: 0,
    image,
    status: initialStatus,
    featured: false,
    extras
  };
  gigs.unshift(newGig);
  try {
    await postgresStore.saveGigs(gigs);
  } catch (err) {
    console.error('[CreateGig] Failed to persist:', err);
    const idx = gigs.findIndex(g => g.id === newGig.id);
    if (idx !== -1) gigs.splice(idx, 1);
    return res.status(500).json({ error: 'Could not save. Please try again.' });
  }
  res.json(newGig);
});

// Update Gig
gigRouter.patch('/gigs/:id', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const g = gigs.find(gig => gig.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gig/Service not found' });
  if (g.freelancerId !== caller.id) {
    return res.status(403).json({ error: 'Forbidden: You can only edit your own gigs.' });
  }

  if (req.body.title !== undefined) g.title = escapeHtml(req.body.title);
  if (req.body.category !== undefined && typeof req.body.category === 'string') g.category = req.body.category.trim().slice(0, 100);
  if (req.body.subcategory !== undefined && typeof req.body.subcategory === 'string') g.subcategory = req.body.subcategory.trim().slice(0, 100);
  if (req.body.description !== undefined) g.description = escapeHtml(req.body.description);
  if (req.body.price !== undefined) {
    const newPrice = Number(req.body.price);
    if (!Number.isFinite(newPrice)) return res.status(400).json({ error: 'Gig price must be a valid number.' });
    const activeSettings = siteSettings.getSettings();
    const minGigPrice = activeSettings.marketplace.minimumGigPrice ?? 5;
    const maxGigPrice = activeSettings.marketplace.maximumGigPrice ?? 10000;
    if (newPrice < minGigPrice) {
      return res.status(400).json({ error: `Gig price ($${newPrice}) cannot be lower than the platform minimum of $${minGigPrice}.` });
    }
    if (newPrice > maxGigPrice) {
      return res.status(400).json({ error: `Gig price ($${newPrice}) cannot exceed the platform maximum of $${maxGigPrice}.` });
    }
    g.price = newPrice;
  }
  if (req.body.deliveryDays !== undefined) {
    g.deliveryDays = Math.min(365, Math.max(1, Math.round(Number(req.body.deliveryDays)) || 7));
  }
  if (req.body.extras !== undefined && Array.isArray(req.body.extras)) {
    g.extras = req.body.extras.slice(0, 20).map((ex: any, idx: number) => ({
      id: String(ex?.id || `extra_${Date.now()}_${idx}`),
      title: String(ex?.title || '').slice(0, 200),
      price: Math.round(Math.min(100000, Math.max(0, Number(ex?.price) || 0)) * 100) / 100
    }));
  }
  if (req.body.image !== undefined && typeof req.body.image === 'string') {
    const defaultImage = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&h=500&fit=crop';
    g.image = /^\s*(javascript:|vbscript:|data:(?!image\/))/i.test(req.body.image) ? defaultImage : req.body.image;
  }

  delete req.body.moderationStatus;
  delete req.body.moderationNotes;
  delete req.body.featured;
  delete req.body.featuredUntil;

  if (req.body.status !== undefined) {
    const requestedStatus = String(req.body.status).toLowerCase().trim();
    if (!['published', 'paused', 'draft'].includes(requestedStatus)) {
      return res.status(400).json({ error: 'Invalid status. Sellers can only set status to published, paused, or draft.' });
    }

    if (requestedStatus === 'published' && (g.moderationStatus === 'rejected' || g.moderationStatus === 'flagged')) {
      return res.status(400).json({ error: 'This gig has been rejected or flagged by moderators and cannot be published until reviewed and approved by an administrator.' });
    }

    const activeSettings = siteSettings.getSettings();
    if (requestedStatus === 'published' && activeSettings.marketplace?.gigModerationRequired && g.moderationStatus !== 'approved') {
      g.status = 'pending';
      g.moderationStatus = 'pending';
    } else {
      g.status = requestedStatus as any;
    }
  }

  postgresStore.saveGigs(gigs);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: caller.name,
    role: caller.role,
    action: 'GIG_UPDATED',
    target: `Gig "${g.title}"`,
    details: `Updated gig details/status to "${g.status}" (moderation: ${g.moderationStatus || 'approved'})`,
    timestamp: new Date().toLocaleString()
  });

  res.json(g);
});

// Delete Gig
gigRouter.delete('/gigs/:id', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const index = gigs.findIndex(gig => gig.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Gig/Service not found' });

  const deleted = gigs[index];
  if (deleted.freelancerId !== caller.id) {
    return res.status(403).json({ error: 'Forbidden: You can only delete your own gigs.' });
  }

  gigs.splice(index, 1);
  postgresStore.saveGigs(gigs);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: 'Freelancer / User',
    role: 'freelancer',
    action: 'GIG_DELETED',
    target: `Gig "${deleted.title}"`,
    details: `Permanently deleted freelancer gig #${deleted.id} by ${deleted.freelancerName}`,
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, id: deleted.id });
});

// Feature Gig
gigRouter.patch('/gigs/:id/feature', requireAuth, requireActiveStatus, (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const g = gigs.find(gig => gig.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gig/Service not found' });
  if (g.freelancerId !== caller.id) {
    return res.status(403).json({ error: 'Forbidden: You can only feature your own gigs.' });
  }

  if (g.featured && g.featuredUntil && new Date(g.featuredUntil) > new Date()) {
    return res.status(400).json({ error: 'Gig is already actively featured.' });
  }

  const activeSettings = siteSettings.getSettings();
  const fee = activeSettings.marketplace.featuredGigFee;
  if (!fee || fee <= 0) {
    return res.status(500).json({ error: 'Feature fee is not configured.' });
  }

  const idempotencyKey = `feat_${g.id}_${Date.now()}`;
  try {
    financeLedger.postJournal({
      reference: `Featured Gig: ${g.id}`,
      description: `Feature fee for gig: ${g.title}`,
      eventType: 'ADMIN_ADJUSTMENT_DEBIT',
      idempotencyKey,
      actor: caller.name,
      entries: [
        { accountCode: '2020', accountName: 'Freelancer Wallets Payable', debit: fee, credit: 0, currency: 'USD', description: 'Feature fee', userId: caller.id },
        { accountCode: '4010', accountName: 'Marketplace Platform Commission Fee', debit: 0, credit: fee, currency: 'USD', description: `Featured gig revenue: ${g.title}` }
      ]
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  g.featured = true;
  g.featuredUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  postgresStore.saveGigs(gigs);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: caller.name,
    role: caller.role,
    action: 'GIG_FEATURED',
    target: `Gig "${g.title}"`,
    details: `Featured gig for 7 days. Fee: $${fee}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(g);
});
