/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { postgresStore } from '../db/postgresStore.js';
import { isGigPublic, sanitizePublicGig } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  adminActor,
  resolveAuthenticatedUserId,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { financialTransactionService } from '../services/financialService.js';
import { registerAuditLog } from '../services/orderService.js';
import { diagnosticService } from '../services/diagnosticService.js';
import type { Gig } from '../../src/types.js';

export const gigRouter = Router();

function formatGigRow(r: any): Gig {
  return {
    id: r.id,
    freelancerId: r.freelancer_id,
    freelancerName: r.freelancer_name,
    freelancerUsername: r.freelancer_username || r.freelancer_name?.toLowerCase().replace(/\s+/g, '_'),
    freelancerAvatar: r.freelancer_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
    freelancerLevel: r.freelancer_level || 'Level 1 ★',
    title: r.title,
    slug: r.slug || r.title?.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, ''),
    category: r.category,
    subcategory: r.subcategory || 'General',
    description: r.description,
    price: Number(r.price),
    deliveryDays: Number(r.delivery_days || 7),
    rating: Number(r.rating || 0),
    reviewsCount: Number(r.reviews_count || 0),
    image: r.image || 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&h=500&fit=crop',
    coverImage: r.cover_image || undefined,
    gallery: r.gallery || [],
    tags: r.tags || [],
    status: r.status,
    featured: Boolean(r.featured),
    featuredUntil: r.featured_until || undefined,
    extras: typeof r.extras === 'string' ? JSON.parse(r.extras) : (r.extras || []),
    moderationStatus: r.moderation_status || 'approved',
    moderationNotes: r.moderation_notes || undefined
  };
}

// Public gigs list
gigRouter.get('/gigs', async (req: Request, res: Response) => {
  try {
    const resDb = await postgresStore.getPool().query("SELECT * FROM gigs WHERE status = 'published'");
    const rawGigs = resDb.rows.map(formatGigRow);
    const publicGigs = rawGigs.filter(isGigPublic).map(sanitizePublicGig);
    res.json(publicGigs);
  } catch (err) {
    console.error('[GET /gigs] Error:', err);
    res.status(500).json({ error: 'Failed to fetch gigs' });
  }
});

// Single Gig Detail
gigRouter.get('/gigs/:id', async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM gigs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    const gig = formatGigRow(result.rows[0]);

    const authUserId = resolveAuthenticatedUserId(req);
    let callerRole = null;
    if (authUserId) {
      const userRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
      if (userRes.rows.length > 0) callerRole = userRes.rows[0].role;
    }
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';
    const isOwner = authUserId && gig.freelancerId === authUserId;

    if (isGigPublic(gig)) {
      if (isAdmin || isOwner) return res.json(gig);
      return res.json(sanitizePublicGig(gig));
    }

    if (isAdmin || isOwner) {
      return res.json(gig);
    }
    return res.status(404).json({ error: 'Gig not found or unavailable' });
  } catch (err) {
    console.error('[GET /gigs/:id] Error:', err);
    res.status(500).json({ error: 'Failed to fetch gig detail' });
  }
});

// Authenticated Owner Listings
gigRouter.get('/my/gigs', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM gigs WHERE freelancer_id = $1 ORDER BY created_at DESC', [authUserId]);
    const myGigs = result.rows.map(formatGigRow);
    res.json(myGigs);
  } catch (err) {
    console.error('[GET /my/gigs] Error:', err);
    res.status(500).json({ error: 'Failed to fetch user gigs' });
  }
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
    extras,
    moderationStatus: activeSettings.marketplace.gigModerationRequired ? 'pending' : 'approved'
  };

  try {
    const pool = postgresStore.getPool();
    await pool.query(
      `INSERT INTO gigs (id, freelancer_id, freelancer_name, freelancer_username, freelancer_avatar, freelancer_level, title, slug, category, subcategory, description, price, delivery_days, rating, reviews_count, image, status, featured, extras, moderation_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())`,
      [
        newGig.id, newGig.freelancerId, newGig.freelancerName, newGig.freelancerUsername, newGig.freelancerAvatar,
        newGig.freelancerLevel, newGig.title, newGig.slug, newGig.category, newGig.subcategory, newGig.description,
        newGig.price, newGig.deliveryDays, newGig.rating, newGig.reviewsCount, newGig.image, newGig.status,
        newGig.featured, JSON.stringify(newGig.extras), newGig.moderationStatus
      ]
    );
    res.json(newGig);
  } catch (err) {
    console.error('[CreateGig] Failed to persist to PostgreSQL:', err);
    res.status(500).json({ error: 'Could not save gig. Please try again.' });
  }
});

// Update Gig
gigRouter.patch('/gigs/:id', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const pool = postgresStore.getPool();
    const findRes = await pool.query('SELECT * FROM gigs WHERE id = $1', [req.params.id]);
    if (findRes.rows.length === 0) return res.status(404).json({ error: 'Gig/Service not found' });
    const g = formatGigRow(findRes.rows[0]);

    if (g.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit your own gigs.' });
    }

    let title = g.title;
    let category = g.category;
    let subcategory = g.subcategory;
    let description = g.description;
    let price = g.price;
    let deliveryDays = g.deliveryDays;
    let extras = g.extras;
    let image = g.image;
    let status = g.status;
    let moderationStatus = g.moderationStatus;

    if (req.body.title !== undefined) title = escapeHtml(req.body.title);
    if (req.body.category !== undefined && typeof req.body.category === 'string') category = req.body.category.trim().slice(0, 100);
    if (req.body.subcategory !== undefined && typeof req.body.subcategory === 'string') subcategory = req.body.subcategory.trim().slice(0, 100);
    if (req.body.description !== undefined) description = escapeHtml(req.body.description);
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
      price = newPrice;
    }
    if (req.body.deliveryDays !== undefined) {
      deliveryDays = Math.min(365, Math.max(1, Math.round(Number(req.body.deliveryDays)) || 7));
    }
    if (req.body.extras !== undefined && Array.isArray(req.body.extras)) {
      extras = req.body.extras.slice(0, 20).map((ex: any, idx: number) => ({
        id: String(ex?.id || `extra_${Date.now()}_${idx}`),
        title: String(ex?.title || '').slice(0, 200),
        price: Math.round(Math.min(100000, Math.max(0, Number(ex?.price) || 0)) * 100) / 100
      }));
    }
    if (req.body.image !== undefined && typeof req.body.image === 'string') {
      const defaultImage = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&h=500&fit=crop';
      image = /^\s*(javascript:|vbscript:|data:(?!image\/))/i.test(req.body.image) ? defaultImage : req.body.image;
    }

    if (req.body.status !== undefined) {
      const requestedStatus = String(req.body.status).toLowerCase().trim();
      if (!['published', 'paused', 'draft'].includes(requestedStatus)) {
        return res.status(400).json({ error: 'Invalid status. Sellers can only set status to published, paused, or draft.' });
      }

      if (requestedStatus === 'published' && (moderationStatus === 'rejected' || moderationStatus === 'flagged')) {
        return res.status(400).json({ error: 'This gig has been rejected or flagged by moderators and cannot be published until reviewed and approved by an administrator.' });
      }

      const activeSettings = siteSettings.getSettings();
      if (requestedStatus === 'published' && activeSettings.marketplace?.gigModerationRequired && moderationStatus !== 'approved') {
        status = 'pending';
        moderationStatus = 'pending';
      } else {
        status = requestedStatus as any;
      }
    }

    await pool.query(
      `UPDATE gigs SET title = $1, category = $2, subcategory = $3, description = $4, price = $5, delivery_days = $6, extras = $7, image = $8, status = $9, moderation_status = $10 WHERE id = $11`,
      [title, category, subcategory, description, price, deliveryDays, JSON.stringify(extras), image, status, moderationStatus, req.params.id]
    );

    const updatedGig = { ...g, title, category, subcategory, description, price, deliveryDays, extras, image, status, moderationStatus };

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'GIG_UPDATED',
      target: `Gig "${title}"`,
      details: `Updated gig details/status to "${status}" (moderation: ${moderationStatus || 'approved'})`,
      timestamp: new Date().toLocaleString()
    });

    res.json(updatedGig);
  } catch (err) {
    console.error('[UpdateGig] Error:', err);
    res.status(500).json({ error: 'Failed to update gig' });
  }
});

// Delete Gig
gigRouter.delete('/gigs/:id', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const pool = postgresStore.getPool();
    const findRes = await pool.query('SELECT * FROM gigs WHERE id = $1', [req.params.id]);
    if (findRes.rows.length === 0) return res.status(404).json({ error: 'Gig/Service not found' });
    const g = formatGigRow(findRes.rows[0]);

    if (g.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only delete your own gigs.' });
    }

    await pool.query('DELETE FROM gigs WHERE id = $1', [req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'GIG_DELETED',
      target: `Gig "${g.title}"`,
      details: `Permanently deleted freelancer gig #${g.id} by ${g.freelancerName}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, id: g.id });
  } catch (err) {
    console.error('[DeleteGig] Error:', err);
    res.status(500).json({ error: 'Failed to delete gig' });
  }
});

// Feature Gig
gigRouter.patch('/gigs/:id/feature', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const activeSettings = siteSettings.getSettings();
    const fee = activeSettings.marketplace.featuredGigFee;
    if (!fee || fee <= 0) {
      return res.status(500).json({ error: 'Feature fee is not configured.' });
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await financialTransactionService.chargeFeaturedGigFee({
      gigId: req.params.id,
      sellerId: caller.id,
      feeAmount: fee,
      featuredUntil: expiresAt,
      actor: `user:${caller.id}`
    });

    res.json(result);
  } catch (err: any) {
    console.error('[FeatureGig] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to feature gig' });
  }
});
