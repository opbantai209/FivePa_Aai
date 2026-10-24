import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  store,
  type Category,
  type Dispute,
  type SupportTicket,
  type Message,
  type User,
  type Order
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { financialRepository } from '../services/financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { paymentGatewayManager } from '../../src/server/paymentGateways.js';
import {
  requireAuth,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  safeUser,
  isStaffUser,
  escapeHtml
} from '../middleware/auth.js';
import {
  orderIndex,
  acquireOrderLock,
  releaseOrderLock,
  releaseOrderFunds,
  refundOrderFunds,
  splitOrderFunds,
  registerAuditLog
} from '../services/orderService.js';
import { recordMessage, messageIndex } from '../services/messagingService.js';
import { broadcastMessage, disconnectUserSockets } from '../websocket.js';
import { notifyUserOnAdminAction } from '../services/notificationService.js';

export let categories: Category[] = [
  {
    id: 'cat_ai',
    name: 'AI Services',
    slug: 'ai-services',
    enabled: true,
    order: 1,
    subcategories: [
      { id: 'sub_ai_1', name: 'Generative AI', slug: 'generative-ai', enabled: true },
      { id: 'sub_ai_2', name: 'AI Applications', slug: 'ai-applications', enabled: true },
      { id: 'sub_ai_3', name: 'AI Agents', slug: 'ai-agents', enabled: true },
      { id: 'sub_ai_4', name: 'Prompt Engineering', slug: 'prompt-engineering', enabled: true },
      { id: 'sub_ai_5', name: 'Machine Learning & Data Science', slug: 'machine-learning-data-science', enabled: true },
      { id: 'sub_ai_6', name: 'ChatGPT Integration', slug: 'chatgpt-integration', enabled: true },
      { id: 'sub_ai_7', name: 'Midjourney & AI Art', slug: 'ai-art', enabled: true }
    ]
  },
  {
    id: 'cat_tech',
    name: 'Technology & Programming',
    slug: 'technology-programming',
    enabled: true,
    order: 2,
    subcategories: [
      { id: 'sub_tech_1', name: 'Web Development', slug: 'web-development', enabled: true },
      { id: 'sub_tech_2', name: 'Mobile Apps', slug: 'mobile-apps', enabled: true },
      { id: 'sub_tech_3', name: 'Software Development', slug: 'software-development', enabled: true },
      { id: 'sub_tech_4', name: 'WordPress', slug: 'wordpress', enabled: true },
      { id: 'sub_tech_5', name: 'E-commerce', slug: 'ecommerce', enabled: true },
      { id: 'sub_tech_6', name: 'Databases', slug: 'databases', enabled: true },
      { id: 'sub_tech_7', name: 'Game Development', slug: 'game-development', enabled: true },
      { id: 'sub_tech_8', name: 'QA & Testing', slug: 'qa-testing', enabled: true },
      { id: 'sub_tech_9', name: 'DevOps & Cloud', slug: 'devops-cloud', enabled: true }
    ]
  },
  {
    id: 'cat_writing',
    name: 'Writing & Translation',
    slug: 'writing-translation',
    enabled: true,
    order: 3,
    subcategories: [
      { id: 'sub_writ_1', name: 'Content Writing', slug: 'content-writing', enabled: true },
      { id: 'sub_writ_2', name: 'Copywriting', slug: 'copywriting', enabled: true },
      { id: 'sub_writ_3', name: 'Translation', slug: 'translation', enabled: true },
      { id: 'sub_writ_4', name: 'Proofreading & Editing', slug: 'proofreading-editing', enabled: true },
      { id: 'sub_writ_5', name: 'Technical Writing', slug: 'technical-writing', enabled: true },
      { id: 'sub_writ_6', name: 'Blog Posts', slug: 'blog-posts', enabled: true },
      { id: 'sub_writ_7', name: 'Ghostwriting', slug: 'ghostwriting', enabled: true },
      { id: 'sub_writ_8', name: 'CV & Resume Writing', slug: 'resume-writing', enabled: true }
    ]
  },
  {
    id: 'cat_design',
    name: 'Design & Creative',
    slug: 'design-creative',
    enabled: true,
    order: 4,
    subcategories: [
      { id: 'sub_des_1', name: 'Logo & Brand Identity', slug: 'logo-brand-identity', enabled: true },
      { id: 'sub_des_2', name: 'Web & App Design (UI/UX)', slug: 'ui-ux-design', enabled: true },
      { id: 'sub_des_3', name: 'Illustration', slug: 'illustration', enabled: true },
      { id: 'sub_des_4', name: 'Photoshop & Image Editing', slug: 'image-editing', enabled: true },
      { id: 'sub_des_5', name: '3D Design & Modeling', slug: '3d-design', enabled: true },
      { id: 'sub_des_6', name: 'Presentation Design', slug: 'presentation-design', enabled: true },
      { id: 'sub_des_7', name: 'Vector Art', slug: 'vector-art', enabled: true }
    ]
  },
  {
    id: 'cat_marketing',
    name: 'Digital Marketing',
    slug: 'digital-marketing',
    enabled: true,
    order: 5,
    subcategories: [
      { id: 'sub_mkt_1', name: 'Search Engine Optimization (SEO)', slug: 'seo', enabled: true },
      { id: 'sub_mkt_2', name: 'Social Media Marketing (SMM)', slug: 'social-media-marketing', enabled: true },
      { id: 'sub_mkt_3', name: 'Search Engine Marketing (SEM)', slug: 'sem', enabled: true },
      { id: 'sub_mkt_4', name: 'Content Marketing', slug: 'content-marketing', enabled: true },
      { id: 'sub_mkt_5', name: 'Email Marketing', slug: 'email-marketing', enabled: true },
      { id: 'sub_mkt_6', name: 'Marketing Strategy', slug: 'marketing-strategy', enabled: true },
      { id: 'sub_mkt_7', name: 'Influencer Marketing', slug: 'influencer-marketing', enabled: true }
    ]
  },
  {
    id: 'cat_video',
    name: 'Video & Animation',
    slug: 'video-animation',
    enabled: true,
    order: 6,
    subcategories: [
      { id: 'sub_vid_1', name: 'Video Editing', slug: 'video-editing', enabled: true },
      { id: 'sub_vid_2', name: 'Motion Graphics', slug: 'motion-graphics', enabled: true },
      { id: 'sub_vid_3', name: '2D & 3D Animation', slug: 'animation', enabled: true },
      { id: 'sub_vid_4', name: 'Explainer Videos', slug: 'explainer-videos', enabled: true },
      { id: 'sub_vid_5', name: 'Short Video Ads (TikTok/Reels)', slug: 'short-video-ads', enabled: true },
      { id: 'sub_vid_6', name: 'Intro & Outro Videos', slug: 'intro-outro', enabled: true },
      { id: 'sub_vid_7', name: 'Visual Effects (VFX)', slug: 'vfx', enabled: true }
    ]
  },
  {
    id: 'cat_music',
    name: 'Music & Audio',
    slug: 'music-audio',
    enabled: true,
    order: 7,
    subcategories: [
      { id: 'sub_mus_1', name: 'Voice Over', slug: 'voice-over', enabled: true },
      { id: 'sub_mus_2', name: 'Mixing & Mastering', slug: 'mixing-mastering', enabled: true },
      { id: 'sub_mus_3', name: 'Producers & Composers', slug: 'producers-composers', enabled: true },
      { id: 'sub_mus_4', name: 'Audiobook Production', slug: 'audiobook-production', enabled: true },
      { id: 'sub_mus_5', name: 'Sound Design & SFX', slug: 'sound-design', enabled: true },
      { id: 'sub_mus_6', name: 'Podcast Editing', slug: 'podcast-editing', enabled: true }
    ]
  },
  {
    id: 'cat_business',
    name: 'Business & Consulting',
    slug: 'business-consulting',
    enabled: true,
    order: 8,
    subcategories: [
      { id: 'sub_biz_1', name: 'Business Plans & Pitch Decks', slug: 'business-plans', enabled: true },
      { id: 'sub_biz_2', name: 'Market Research', slug: 'market-research', enabled: true },
      { id: 'sub_biz_3', name: 'Financial Consulting & Modeling', slug: 'financial-consulting', enabled: true },
      { id: 'sub_biz_4', name: 'Legal Consulting & Contracts', slug: 'legal-consulting', enabled: true },
      { id: 'sub_biz_5', name: 'Human Resources (HR)', slug: 'hr-consulting', enabled: true },
      { id: 'sub_biz_6', name: 'Project Management', slug: 'project-management', enabled: true },
      { id: 'sub_biz_7', name: 'Virtual Assistant', slug: 'virtual-assistant', enabled: true }
    ]
  }
];

export function setCategories(newCats: Category[]) {
  categories = newCats;
}

function formatSupportTicketRow(r: any): SupportTicket {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    subject: r.subject,
    priority: r.priority,
    status: r.status,
    createdAt: r.created_at,
    messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : (r.messages || []),
    isAppeal: Boolean(r.is_appeal),
    category: r.category || undefined,
    appealContext: typeof r.appeal_context === 'string' ? JSON.parse(r.appeal_context) : (r.appeal_context || undefined)
  };
}

function formatUserRow(r: any): User {
  return {
    id: r.id,
    name: r.name,
    username: r.username || undefined,
    email: r.email,
    mobile: r.mobile || undefined,
    role: r.role,
    avatar: r.avatar || '',
    title: r.title || undefined,
    rating: Number(r.rating || 5.0),
    reviewsCount: Number(r.reviews_count || 0),
    hourlyRate: Number(r.hourly_rate || 0),
    earned: Number(r.earned || 0),
    completedJobs: Number(r.completed_jobs || 0),
    bio: r.bio || undefined,
    skills: Array.isArray(r.skills) ? r.skills : (typeof r.skills === 'string' ? r.skills.split(',').map((s: string) => s.trim()).filter(Boolean) : []),
    status: r.status || 'active',
    verified: Boolean(r.verified),
    emailVerified: Boolean(r.email_verified),
    mobileVerified: Boolean(r.mobile_verified),
    walletBalance: Number(r.wallet_balance || 0),
    createdAt: r.created_at,
    isFlagged: Boolean(r.is_flagged),
    flagReason: r.flag_reason || undefined,
    sessionVersion: r.session_version || 1,
    knownDevices: Array.isArray(r.known_devices) ? r.known_devices : [],
    isAvailableNow: Boolean(r.is_available_now),
    notificationPreferences: typeof r.notification_preferences === 'string' ? JSON.parse(r.notification_preferences) : r.notification_preferences
  };
}

const router = Router();

// ==========================================
// CATEGORIES ADMIN
// ==========================================

router.get('/categories', (_req: Request, res: Response) => {
  res.json(categories);
});

router.post('/admin/categories', requireAdmin, async (req: Request, res: Response) => {
  const { name, slug } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const catSlug = slug || name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  const newCat: Category = {
    id: 'cat_' + Date.now() + '_' + randomUUID().slice(0, 8),
    name,
    slug: catSlug,
    enabled: true,
    order: categories.length + 1,
    subcategories: []
  };
  categories.push(newCat);
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'CATEGORY_CREATED',
    target: `Category: ${name}`,
    details: `Created new main category "${name}" with slug /${catSlug}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.post('/admin/categories/bulk-delete', requireAdmin, async (req: Request, res: Response) => {
  const { categoryIds = [], subcategoryPairs = [] } = req.body;
  if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    categories = categories.filter(c => !categoryIds.includes(c.id));
  }
  if (Array.isArray(subcategoryPairs) && subcategoryPairs.length > 0) {
    subcategoryPairs.forEach(({ catId, subId }: { catId: string; subId: string }) => {
      const cat = categories.find(c => c.id === catId);
      if (cat) {
        cat.subcategories = cat.subcategories.filter(s => s.id !== subId);
      }
    });
  }
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'CATEGORIES_BULK_DELETED',
    target: 'Marketplace Categories',
    details: `Bulk deleted ${categoryIds.length} categories and ${subcategoryPairs.length} subcategories`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.patch('/admin/categories/:id', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  if (req.body.name) cat.name = req.body.name;
  if (req.body.slug) cat.slug = req.body.slug;
  if (typeof req.body.enabled === 'boolean') cat.enabled = req.body.enabled;
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'CATEGORY_UPDATED',
    target: `Category: ${cat.name}`,
    details: `Updated category name/slug/status for ${cat.name}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.patch('/admin/categories/:id/toggle', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  cat.enabled = !cat.enabled;
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: cat.enabled ? 'CATEGORY_ENABLED' : 'CATEGORY_DISABLED',
    target: `Category: ${cat.name}`,
    details: `Toggled status of category ${cat.name} to ${cat.enabled ? 'Enabled' : 'Disabled'}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.delete('/admin/categories/:id', requireAdmin, async (req: Request, res: Response) => {
  const index = categories.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Category not found' });
  const deleted = categories[index];
  categories.splice(index, 1);
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'CATEGORY_DELETED',
    target: `Category: ${deleted.name}`,
    details: `Deleted category ${deleted.name}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.post('/admin/categories/:id/subcategories', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const { name, slug } = req.body;
  if (!name) return res.status(400).json({ error: 'Subcategory name is required' });
  const subSlug = slug || name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  const newSub = {
    id: 'sub_' + Date.now() + '_' + randomUUID().slice(0, 8),
    name,
    slug: subSlug,
    enabled: true
  };
  cat.subcategories.push(newSub);
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'SUBCATEGORY_CREATED',
    target: `Subcategory: ${name} (under ${cat.name})`,
    details: `Created subcategory ${name}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.patch('/admin/categories/:id/subcategories/:subId', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const sub = cat.subcategories.find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Subcategory not found' });
  if (req.body.name) sub.name = req.body.name;
  if (req.body.slug) sub.slug = req.body.slug;
  if (typeof req.body.enabled === 'boolean') sub.enabled = req.body.enabled;
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'SUBCATEGORY_UPDATED',
    target: `Subcategory: ${sub.name}`,
    details: `Updated subcategory under ${cat.name}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.patch('/admin/categories/:id/subcategories/:subId/toggle', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const sub = cat.subcategories.find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Subcategory not found' });
  sub.enabled = !sub.enabled;
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: sub.enabled ? 'SUBCATEGORY_ENABLED' : 'SUBCATEGORY_DISABLED',
    target: `Subcategory: ${sub.name}`,
    details: `Toggled subcategory status to ${sub.enabled ? 'Enabled' : 'Disabled'}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

router.delete('/admin/categories/:id/subcategories/:subId', requireAdmin, async (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const subIndex = cat.subcategories.findIndex(s => s.id === req.params.subId);
  if (subIndex === -1) return res.status(404).json({ error: 'Subcategory not found' });
  const deletedSub = cat.subcategories[subIndex];
  cat.subcategories.splice(subIndex, 1);
  await postgresStore.saveCategories(categories);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'SUBCATEGORY_DELETED',
    target: `Subcategory: ${deletedSub.name}`,
    details: `Deleted subcategory from ${cat.name}`,
    timestamp: new Date().toLocaleString()
  });

  res.json(categories);
});

// ==========================================
// SITE & FEE SETTINGS
// ==========================================

const handleGetSiteSettings = (req: Request, res: Response) => {
  const flattened = siteSettings.getFlattenedSettings();
  res.json({ success: true, settings: flattened, ...flattened });
};

const handlePostSiteSettings = (req: Request, res: Response) => {
  try {
    const actor = (req as any).authenticatedUser?.name || req.body?.updatedBy || 'Super Admin';
    const updatedFlattened = siteSettings.updateFromFlatObject(req.body || {}, actor);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor,
      role: 'super_admin',
      action: 'SITE_FEE_SETTINGS_UPDATED',
      target: 'Platform Settings & Fee Structure',
      details: `Updated settings saved to disk and applied across backend engine: Commission=${updatedFlattened.freelancerCommissionRate}%, EscrowHold=${updatedFlattened.escrowHoldDays}d, ClientFee=${updatedFlattened.buyerProcessingFeeRate}%, SmallOrderFee=$${updatedFlattened.smallOrderFee} under $${updatedFlattened.smallOrderFeeThreshold}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, settings: updatedFlattened, ...updatedFlattened });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update site settings' });
  }
};

router.get('/admin/settings', requireAdmin, handleGetSiteSettings);
router.get('/admin/site-settings', requireAdmin, handleGetSiteSettings);
router.post('/admin/settings', requireAdmin, handlePostSiteSettings);
router.patch('/admin/settings', requireAdmin, handlePostSiteSettings);
router.post('/admin/site-settings', requireAdmin, handlePostSiteSettings);
router.patch('/admin/site-settings', requireAdmin, handlePostSiteSettings);

// ==========================================
// PAYMENT GATEWAYS
// ==========================================

router.get('/admin/payment-gateways', requireAdmin, (req: Request, res: Response) => {
  try {
    res.json({ success: true, gateways: paymentGatewayManager.getMaskedState() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/payment-gateways/:environment/:gateway', requireAdmin, (req: Request, res: Response) => {
  try {
    const env = req.params.environment as 'production' | 'sandbox';
    const gw = req.params.gateway as 'paypal' | 'stripe' | 'razorpay';
    const actor = (req as any).authenticatedUser?.name || 'Super Admin';

    if (!['production', 'sandbox'].includes(env)) {
      return res.status(400).json({ error: 'Invalid environment. Must be production or sandbox.' });
    }
    if (!['paypal', 'stripe', 'razorpay'].includes(gw)) {
      return res.status(400).json({ error: 'Invalid gateway. Must be paypal, stripe, or razorpay.' });
    }

    const updated = paymentGatewayManager.updateGateway(env, gw, req.body || {});

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor,
      role: 'super_admin',
      action: 'PAYMENT_GATEWAY_UPDATED',
      target: `${gw.toUpperCase()} (${env.toUpperCase()})`,
      details: `Updated ${gw} configuration for ${env} environment (Enabled: ${updated[gw].enabled}, Primary: ${updated[gw].primary})`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, environmentGateways: paymentGatewayManager.getMaskedState()[env] });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/payment-gateways/:environment/:gateway/test', requireAdmin, (req: Request, res: Response) => {
  try {
    const env = req.params.environment as 'production' | 'sandbox';
    const gw = req.params.gateway as 'paypal' | 'stripe' | 'razorpay';
    const actor = (req as any).authenticatedUser?.name || 'Super Admin';

    if (!['production', 'sandbox'].includes(env) || !['paypal', 'stripe', 'razorpay'].includes(gw)) {
      return res.status(400).json({ error: 'Invalid environment or gateway.' });
    }

    const result = paymentGatewayManager.testConnection(env, gw);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor,
      role: 'super_admin',
      action: 'PAYMENT_GATEWAY_CONNECTION_TESTED',
      target: `${gw.toUpperCase()} (${env.toUpperCase()})`,
      details: `Tested connection for ${gw} (${env}): ${result.message}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: result.success, message: result.message });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// MEMBERSHIPS ADMIN
// ==========================================

router.get('/admin/memberships', requireAdmin, (req: Request, res: Response) => {
  try {
    const currentSettings = siteSettings.getSettings();
    res.json({
      success: true,
      memberships: currentSettings.memberships,
      marketplace: currentSettings.marketplace
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/memberships', requireAdmin, (req: Request, res: Response) => {
  try {
    const { memberships, marketplace } = req.body || {};
    const actor = (req as any).authenticatedUser?.name || 'Super Admin';
    if (memberships) {
      siteSettings.updateSection('memberships', memberships, actor);
    }
    if (marketplace) {
      siteSettings.updateSection('marketplace', marketplace, actor);
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor,
      role: 'super_admin',
      action: 'MEMBERSHIPS_QUOTAS_UPDATED',
      target: 'Platform Membership & Gig Quotas',
      details: 'Updated membership plan limits and marketplace gig/project constraints',
      timestamp: new Date().toLocaleString()
    });

    const activeSettings = siteSettings.getSettings();
    res.json({
      success: true,
      memberships: activeSettings.memberships,
      marketplace: activeSettings.marketplace
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SUPPORT TICKETS & AUDIT LOGS
// ==========================================

router.get('/support-tickets', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'User not found' });

    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin' || caller.role === 'support';
    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM support_tickets ORDER BY created_at DESC');
    } else {
      result = await pool.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [authUserId]);
    }
    res.json(result.rows.map(formatSupportTicketRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/support-tickets', requireAuth, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'User not found' });

    const { subject, text, priority = 'medium', isAppeal: clientIsAppeal, category } = req.body;
    const safeSubject = String(subject || '').slice(0, 200);
    const safeText = String(text || '').slice(0, 5000);
    const userId = caller.id;
    const userName = caller.name;

    const isSuspendedOrRestricted = caller.status === 'suspended' || caller.status === 'restricted';
    const isAppeal = isSuspendedOrRestricted && (
      clientIsAppeal === true ||
      category === 'appeal' ||
      String(safeSubject || '').toLowerCase().includes('appeal') ||
      caller.status === 'suspended'
    );

    if (isAppeal) {
      const activeAppealsRes = await pool.query(
        "SELECT * FROM support_tickets WHERE user_id = $1 AND status IN ('open', 'in_progress')",
        [caller.id]
      );
      const hasActiveAppeal = activeAppealsRes.rows.some((t: any) => {
        return t.is_appeal || t.category === 'appeal' || String(t.subject || '').toLowerCase().includes('appeal');
      });

      if (hasActiveAppeal) {
        return res.status(409).json({
          error: 'An active appeal is already currently open for your account restriction. Please wait for our support team to review your case before submitting another appeal.'
        });
      }
    }

    const appealContext = isAppeal ? {
      accountStatus: caller.status,
      flagReason: caller.flag_reason || 'Policy Violation',
      appealedAt: new Date().toISOString()
    } : undefined;

    const newTicket: SupportTicket = {
      id: 'tick_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId,
      userName,
      subject: safeSubject || (isAppeal ? `Account Appeal (${caller.status})` : 'General Support Query'),
      priority: isAppeal ? 'high' : priority,
      status: 'open',
      createdAt: new Date().toISOString().split('T')[0],
      messages: [
        {
          sender: userName,
          text: safeText || 'I need support assistance regarding my account.',
          timestamp: new Date().toISOString(),
          ...(appealContext ? { appealContext } : {})
        }
      ],
      ...(isAppeal ? { isAppeal: true, category: 'appeal', appealContext } : {})
    };

    await pool.query(
      `INSERT INTO support_tickets (id, user_id, user_name, subject, priority, status, created_at, messages, is_appeal, category, appeal_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        newTicket.id,
        newTicket.userId,
        newTicket.userName,
        newTicket.subject,
        newTicket.priority,
        newTicket.status,
        newTicket.createdAt,
        JSON.stringify(newTicket.messages),
        Boolean(newTicket.isAppeal),
        newTicket.category || null,
        newTicket.appealContext ? JSON.stringify(newTicket.appealContext) : null
      ]
    );

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: userName,
      role: caller.role,
      action: isAppeal ? 'ACCOUNT_APPEAL_SUBMITTED' : 'SUPPORT_TICKET_OPENED',
      target: `Ticket #${newTicket.id}`,
      details: isAppeal
        ? `User submitted account appeal for ${caller.status} status (Flag reason: ${caller.flag_reason || 'None'}): ${safeSubject}`
        : `User submitted support request: ${safeSubject}`,
      timestamp: new Date().toLocaleString()
    });

    res.status(201).json({ success: true, ticket: newTicket, ...newTicket });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/tickets/:id/reply', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const t = formatSupportTicketRow(result.rows[0]);
    t.messages.push({
      sender: 'WorkPerHour Support Staff',
      text: req.body.text,
      timestamp: new Date().toISOString()
    });
    t.status = 'in_progress';

    await pool.query(
      'UPDATE support_tickets SET messages = $1, status = $2 WHERE id = $3',
      [JSON.stringify(t.messages), t.status, t.id]
    );

    res.json(t);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/audit-logs', requireRole(['admin', 'super_admin']), async (_req: Request, res: Response) => {
  try {
    const logs = await postgresStore.listAuditLogs();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// USER MANAGEMENT
// ==========================================

router.patch('/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (targetRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = formatUserRow(targetRes.rows[0]);
    const caller = (req as any).authenticatedUser;

    if (u.role === 'super_admin' && caller?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden: Regular administrators cannot modify a super_admin account.' });
    }

    if (req.body.role !== undefined) {
      if (caller?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden: Only super_admin can modify or assign roles.' });
      }
      const ALLOWED_ROLES = ['buyer', 'freelancer', 'admin', 'super_admin', 'support', 'moderator'];
      if (!ALLOWED_ROLES.includes(req.body.role)) {
        return res.status(400).json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` });
      }
      u.role = req.body.role;
    }

    if (req.body.email !== undefined) {
      if (u.role === 'admin' && caller?.role !== 'super_admin' && caller?.id !== u.id) {
        return res.status(403).json({ error: 'Forbidden: Only super_admin can change another administrator’s email.' });
      }
      u.email = escapeHtml(String(req.body.email));
    }

    if (req.body.name !== undefined) u.name = escapeHtml(String(req.body.name));
    if (req.body.title !== undefined) u.title = escapeHtml(String(req.body.title));
    if (req.body.bio !== undefined) u.bio = escapeHtml(String(req.body.bio));
    if (req.body.skills !== undefined) u.skills = Array.isArray(req.body.skills) ? req.body.skills : req.body.skills.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (req.body.hourlyRate !== undefined) {
      const hr = Number(req.body.hourlyRate);
      if (!Number.isFinite(hr) || hr < 0) return res.status(400).json({ error: 'Invalid hourly rate.' });
      u.hourlyRate = hr;
    }
    if (req.body.verified !== undefined) u.verified = Boolean(req.body.verified);

    if (req.body.status !== undefined) {
      const ALLOWED_STATUSES = ['active', 'frozen', 'restricted', 'suspended', 'deactivated'];
      const newStatus = String(req.body.status).toLowerCase().trim();
      if (!ALLOWED_STATUSES.includes(newStatus)) {
        return res.status(400).json({ error: `Invalid status. Allowed statuses: ${ALLOWED_STATUSES.join(', ')}` });
      }
      if (u.role === 'super_admin' && caller?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden: Only super_admin can change a super_admin status.' });
      }
      u.status = newStatus as any;
    }

    await store.saveUser(u);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller?.name || adminActor(req),
      role: caller?.role || 'admin',
      action: 'USER_PROFILE_EDITED',
      target: `User ${u.name}`,
      details: `Updated profile details and parameters for ${u.email}`,
      timestamp: new Date().toLocaleString()
    });

    res.json(safeUser(u));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/admin/users/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (targetRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = formatUserRow(targetRes.rows[0]);
    const admin = (req as any).authenticatedUser;

    const ALLOWED_STATUSES = ['active', 'frozen', 'restricted', 'suspended', 'deactivated'];
    const newStatus = String(req.body?.status || '').toLowerCase().trim();
    if (!newStatus || !ALLOWED_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status. Allowed statuses: ${ALLOWED_STATUSES.join(', ')}` });
    }

    if (u.role === 'super_admin' && admin?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden: Only a super_admin can change a super_admin account status.' });
    }

    const oldStatus = u.status;
    u.status = newStatus as any;
    await store.saveUser(u);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: admin?.name || adminActor(req),
      role: admin?.role || 'admin',
      action: `USER_STATUS_${newStatus.toUpperCase()}`,
      target: `User ${u.name}`,
      details: `Changed account status from ${oldStatus} to ${newStatus}`,
      timestamp: new Date().toLocaleString()
    });

    if (u.status !== 'active') {
      disconnectUserSockets(u.id, `Account is ${u.status}`);
    }

    if (newStatus === 'suspended' || newStatus === 'restricted' || newStatus === 'deactivated') {
      notifyUserOnAdminAction(u, newStatus, req.body.notes);
    }

    res.json(safeUser(u));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/users/:id/impersonate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = await store.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const admin = (req as any).authenticatedUser;
    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: admin?.name || 'Admin',
      role: admin?.role || 'admin',
      action: 'USER_IMPERSONATED',
      target: `User ${u.name}`,
      details: `Initialized administrative impersonation session for ${u.email}`,
      timestamp: new Date().toLocaleString()
    });

    notifyUserOnAdminAction(u, 'impersonated');
    res.json({ success: true, user: safeUser(u) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/users/:id/stop-impersonate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = await store.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const admin = (req as any).authenticatedUser;
    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: admin?.name || 'Admin',
      role: admin?.role || 'admin',
      action: 'USER_IMPERSONATION_ENDED',
      target: `User ${u.name}`,
      details: `Safely ended administrative impersonation session for ${u.email}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, user: safeUser(u) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/admin/users/:id/verify', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = await store.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    u.verified = !u.verified;
    await store.saveUser(u);

    const admin = (req as any).authenticatedUser;
    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: admin?.name || 'Admin',
      role: admin?.role || 'admin',
      action: u.verified ? 'USER_VERIFIED' : 'USER_UNVERIFIED',
      target: `User ${u.name}`,
      details: `Verification status changed to ${u.verified}`,
      timestamp: new Date().toLocaleString()
    });

    res.json(safeUser(u));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const target = await store.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'super_admin') {
      return res.status(403).json({ error: 'Cannot delete a super_admin account.' });
    }
    if (await financialRepository.hasOutstandingFunds(target.id)) {
      return res.status(409).json({ error: 'User still has wallet funds, pending withdrawals or active escrow. Resolve these before deleting the account.' });
    }

    const pool = postgresStore.getPool();
    const activeOrdersRes = await pool.query(
      "SELECT 1 FROM orders WHERE (buyer_id = $1 OR seller_id = $1) AND status NOT IN ('completed', 'cancelled') AND amount > 0 LIMIT 1",
      [target.id]
    );
    if (activeOrdersRes.rows.length > 0) {
      return res.status(409).json({ error: 'User has active paid orders. Complete or cancel them first.' });
    }

    await pool.query('DELETE FROM gigs WHERE freelancer_id = $1', [target.id]);
    await pool.query('DELETE FROM projects WHERE buyer_id = $1', [target.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [target.id]);

    const admin = (req as any).authenticatedUser;
    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: admin?.name || 'Admin',
      role: admin?.role || 'admin',
      action: 'USER_DELETED',
      target: `User ${target.name}`,
      details: `Permanently deleted user account ${target.email} and cleared their associated gigs & projects`,
      timestamp: new Date().toLocaleString()
    });

    disconnectUserSockets(req.params.id, 'Account deleted');
    res.json({ success: true, id: target.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// DISPUTE RESOLUTION
// ==========================================

router.patch('/admin/disputes/:id/resolve', requireAdmin, async (req: Request, res: Response) => {
  let lockedOrderId: string | null = null;
  try {
    const pool = postgresStore.getPool();
    const disputeRes = await pool.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
    if (disputeRes.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
    const d: Dispute = {
      id: disputeRes.rows[0].id,
      orderId: disputeRes.rows[0].order_id,
      buyerId: disputeRes.rows[0].buyer_id || undefined,
      sellerId: disputeRes.rows[0].seller_id || undefined,
      raisedBy: disputeRes.rows[0].raised_by,
      reason: disputeRes.rows[0].reason,
      evidence: disputeRes.rows[0].evidence || '',
      status: disputeRes.rows[0].status,
      createdAt: disputeRes.rows[0].created_at,
      resolutionNotes: disputeRes.rows[0].resolution_notes || undefined,
      resolutionType: disputeRes.rows[0].resolution_type || undefined,
      notes: disputeRes.rows[0].notes || undefined,
      assignedTo: disputeRes.rows[0].assigned_to || undefined
    };

    const status = req.body.status as Dispute['status'];
    if (!['open', 'under_investigation', 'resolved_refund', 'resolved_release', 'resolved_partial'].includes(status)) {
      return res.status(400).json({ error: 'Invalid dispute status.' });
    }
    if (d.status.startsWith('resolved')) return res.status(409).json({ error: `Dispute is already ${d.status}.` });
    const notes = String(req.body.notes || '');
    const reason = notes.trim().length >= 5 ? notes.trim() : 'Dispute resolved by administrator';
    const order = await store.getOrder(d.orderId);

    if (status.startsWith('resolved')) {
      if (!order) return res.status(404).json({ error: 'Order for this dispute not found' });
      lockedOrderId = order.id;
      try {
        acquireOrderLock(lockedOrderId);
      } catch (err: any) {
        return res.status(409).json({ error: err.message });
      }
      if (status === 'resolved_release') await releaseOrderFunds(order, adminActor(req), reason, false);
      else if (status === 'resolved_refund') await refundOrderFunds(order, undefined, adminActor(req), reason);
      else {
        const splitAmt = Number(req.body.refundAmount);
        if (typeof splitAmt !== 'number' || Number.isNaN(splitAmt) || !Number.isFinite(splitAmt) || splitAmt < 0) {
          return res.status(400).json({ error: 'Dispute split refund amount must be a valid non-negative number.' });
        }
        await splitOrderFunds(order, splitAmt, adminActor(req), reason);
      }
    }
    d.status = status;
    d.resolutionNotes = notes;

    await pool.query(
      'UPDATE disputes SET status = $1, resolution_notes = $2 WHERE id = $3',
      [status, notes, d.id]
    );

    if (order) {
      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'Dispute Resolution Desk',
        text: `⚖️ Dispute resolved by administrator: ${status}. Notes: ${notes || 'No notes provided'}`,
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'dispute_resolved', status, notes }
      };
      recordMessage(sysMsg);
      await store.addMessage(sysMsg);
      broadcastMessage(sysMsg, order.id);
    }

    registerAuditLog({
      id: 'log_' + randomUUID().slice(0, 12),
      actor: adminActor(req),
      role: 'super_admin',
      action: 'DISPUTE_RESOLVED',
      target: `Dispute #${d.id}`,
      details: `Resolved dispute with status ${status}. Notes: ${notes}`,
      timestamp: new Date().toLocaleString()
    });

    res.json(d);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    if (lockedOrderId) releaseOrderLock(lockedOrderId);
  }
});

// ==========================================
// MESSAGE THREADS MODERATION
// ==========================================

router.get('/admin/messages/threads', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    const threads = await Promise.all(ordersRes.rows.map(async (order: any) => {
      const buyer = await store.getUser(order.buyer_id);
      const seller = await store.getUser(order.seller_id);
      const orderMessages = await store.listMessages(order.id);
      const lastMsg = orderMessages[orderMessages.length - 1];

      return {
        id: order.id,
        orderId: order.id,
        projectId: order.project_id,
        projectOrGigTitle: order.title,
        participantOne: {
          id: buyer?.id || order.buyer_id,
          name: buyer?.name || order.buyer_username || 'Buyer',
          avatar: buyer?.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop',
          role: 'client' as const,
          email: buyer?.email || 'buyer@example.com',
          status: (buyer?.status || 'active') as any
        },
        participantTwo: {
          id: seller?.id || order.seller_id,
          name: seller?.name || order.seller_username || 'Seller',
          avatar: seller?.avatar || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop',
          role: 'freelancer' as const,
          email: seller?.email || 'seller@example.com',
          status: (seller?.status || 'active') as any
        },
        lastMessageSnippet: lastMsg?.text || (orderMessages.length > 0 ? 'Attachment' : 'No messages in workstream'),
        lastMessageTime: lastMsg?.timestamp || order.created_at,
        totalMessages: orderMessages.length,
        moderationStatus: 'clean' as const,
        flaggedCount: 0,
        messages: orderMessages.map(m => ({
          id: m.id,
          senderId: m.senderId,
          senderName: m.senderName || 'Participant',
          senderAvatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop',
          senderRole: (m.senderId === order.buyer_id ? 'client' : 'freelancer') as ('client' | 'freelancer'),
          text: m.text,
          timestamp: m.timestamp
        }))
      };
    }));

    res.json(threads);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ADMIN GIGS MANAGEMENT
// ==========================================

router.get('/admin/gigs', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM gigs ORDER BY created_at DESC');
    res.json(result.rows.map((r: any) => ({
      id: r.id,
      freelancerId: r.freelancer_id,
      freelancerName: r.freelancer_name,
      title: r.title,
      category: r.category,
      price: Number(r.price),
      status: r.status,
      moderationStatus: r.moderation_status,
      moderationNotes: r.moderation_notes,
      createdAt: r.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin gigs' });
  }
});

router.patch('/admin/gigs/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status, moderationStatus, moderationNotes } = req.body;
    const pool = postgresStore.getPool();
    await pool.query(
      `UPDATE gigs SET status = COALESCE($1, status), moderation_status = COALESCE($2, moderation_status), moderation_notes = COALESCE($3, moderation_notes) WHERE id = $4`,
      [status || null, moderationStatus || null, moderationNotes || null, req.params.id]
    );
    const updated = await pool.query('SELECT * FROM gigs WHERE id = $1', [req.params.id]);
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    const r = updated.rows[0];
    res.json({
      success: true,
      gig: {
        id: r.id,
        freelancerId: r.freelancer_id,
        title: r.title,
        status: r.status,
        moderationStatus: r.moderation_status,
        moderationNotes: r.moderation_notes
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update gig as admin' });
  }
});

export default router;
