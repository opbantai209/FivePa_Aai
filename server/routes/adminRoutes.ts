import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  users,
  gigs,
  projects,
  orders,
  messages,
  disputes,
  refunds,
  supportTickets,
  auditLogs,
  financeLedger,
  type Category,
  type Dispute,
  type SupportTicket,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { paymentGatewayManager } from '../../src/server/paymentGateways.js';
import {
  requireAuth,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  safeUser,
  isStaffUser
} from '../middleware/auth.js';
import {
  orderIndex,
  acquireOrderLock,
  releaseOrderLock,
  releaseOrderFunds,
  refundOrderFunds,
  splitOrderFunds,
  registerAuditLog,
  saveUsersToPostgres,
  saveGigsToPostgres,
  processAutoAcceptOrders
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
      { id: 'sub_des_1', name: 'Logo Design', slug: 'logo-design', enabled: true },
      { id: 'sub_des_2', name: 'Brand Identity', slug: 'brand-identity', enabled: true },
      { id: 'sub_des_3', name: 'UI/UX Design', slug: 'ui-ux-design', enabled: true },
      { id: 'sub_des_4', name: 'Illustration', slug: 'illustration', enabled: true },
      { id: 'sub_des_5', name: 'Flyers & Brochures', slug: 'flyers-brochures', enabled: true },
      { id: 'sub_des_6', name: 'Social Media Design', slug: 'social-media-design', enabled: true },
      { id: 'sub_des_7', name: 'Packaging & Labels', slug: 'packaging-labels', enabled: true }
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
      { id: 'sub_mkt_2', name: 'Social Media Marketing', slug: 'social-media-marketing', enabled: true },
      { id: 'sub_mkt_3', name: 'Paid Advertising (SEM/PPC)', slug: 'sem-ppc', enabled: true },
      { id: 'sub_mkt_4', name: 'Email Marketing', slug: 'email-marketing', enabled: true },
      { id: 'sub_mkt_5', name: 'Content Marketing', slug: 'content-marketing', enabled: true },
      { id: 'sub_mkt_6', name: 'Influencer Marketing', slug: 'influencer-marketing', enabled: true },
      { id: 'sub_mkt_7', name: 'Affiliate Marketing', slug: 'affiliate-marketing', enabled: true }
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
      { id: 'sub_vid_2', name: 'Short Video Ads (TikTok/Reels)', slug: 'short-video-ads', enabled: true },
      { id: 'sub_vid_3', name: 'Animated Explainers', slug: 'animated-explainers', enabled: true },
      { id: 'sub_vid_4', name: 'Motion Graphics', slug: 'motion-graphics', enabled: true },
      { id: 'sub_vid_5', name: 'Logo Animation', slug: 'logo-animation', enabled: true },
      { id: 'sub_vid_6', name: 'Intros & Outros', slug: 'intros-outros', enabled: true },
      { id: 'sub_vid_7', name: 'Visual Effects (VFX)', slug: 'vfx', enabled: true }
    ]
  },
  {
    id: 'cat_biz',
    name: 'Business',
    slug: 'business',
    enabled: true,
    order: 7,
    subcategories: [
      { id: 'sub_biz_1', name: 'Business Plans', slug: 'business-plans', enabled: true },
      { id: 'sub_biz_2', name: 'Financial Modeling', slug: 'financial-modeling', enabled: true },
      { id: 'sub_biz_3', name: 'Virtual Assistant', slug: 'virtual-assistant', enabled: true },
      { id: 'sub_biz_4', name: 'Market Research', slug: 'market-research', enabled: true },
      { id: 'sub_biz_5', name: 'Legal Consulting', slug: 'legal-consulting', enabled: true },
      { id: 'sub_biz_6', name: 'HR & Recruiting', slug: 'hr-recruiting', enabled: true },
      { id: 'sub_biz_7', name: 'Project Management', slug: 'project-management', enabled: true }
    ]
  },
  {
    id: 'cat_audio',
    name: 'Music & Audio',
    slug: 'music-audio',
    enabled: true,
    order: 8,
    subcategories: [
      { id: 'sub_aud_1', name: 'Voice Over', slug: 'voice-over', enabled: true },
      { id: 'sub_aud_2', name: 'Mixing & Mastering', slug: 'mixing-mastering', enabled: true },
      { id: 'sub_aud_3', name: 'Music Production', slug: 'music-production', enabled: true },
      { id: 'sub_aud_4', name: 'Podcast Editing', slug: 'podcast-editing', enabled: true },
      { id: 'sub_aud_5', name: 'Sound Design', slug: 'sound-design', enabled: true },
      { id: 'sub_aud_6', name: 'Audio Production', slug: 'audio-production', enabled: true },
      { id: 'sub_aud_7', name: 'Jingles & Intros', slug: 'jingles-intros', enabled: true }
    ]
  }
];

function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const router = Router();

// ==========================================
// CATEGORIES & SUBCATEGORIES
// ==========================================

router.get('/categories', (req: Request, res: Response) => res.json(categories));

router.post('/admin/categories', requireAdmin, (req: Request, res: Response) => {
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

router.post('/admin/categories/bulk-delete', requireAdmin, (req: Request, res: Response) => {
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

router.patch('/admin/categories/:id', requireAdmin, (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  if (req.body.name) cat.name = req.body.name;
  if (req.body.slug) cat.slug = req.body.slug;
  if (typeof req.body.enabled === 'boolean') cat.enabled = req.body.enabled;

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

router.patch('/admin/categories/:id/toggle', requireAdmin, (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  cat.enabled = !cat.enabled;

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

router.delete('/admin/categories/:id', requireAdmin, (req: Request, res: Response) => {
  const index = categories.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Category not found' });
  const deleted = categories[index];
  categories.splice(index, 1);

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

router.post('/admin/categories/:id/subcategories', requireAdmin, (req: Request, res: Response) => {
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

router.patch('/admin/categories/:id/subcategories/:subId', requireAdmin, (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const sub = cat.subcategories.find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Subcategory not found' });
  if (req.body.name) sub.name = req.body.name;
  if (req.body.slug) sub.slug = req.body.slug;
  if (typeof req.body.enabled === 'boolean') sub.enabled = req.body.enabled;

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

router.patch('/admin/categories/:id/subcategories/:subId/toggle', requireAdmin, (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const sub = cat.subcategories.find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Subcategory not found' });
  sub.enabled = !sub.enabled;

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

router.delete('/admin/categories/:id/subcategories/:subId', requireAdmin, (req: Request, res: Response) => {
  const cat = categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Parent category not found' });
  const subIndex = cat.subcategories.findIndex(s => s.id === req.params.subId);
  if (subIndex === -1) return res.status(404).json({ error: 'Subcategory not found' });
  const deletedSub = cat.subcategories[subIndex];
  cat.subcategories.splice(subIndex, 1);

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

router.get('/support-tickets', requireAuth, (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
  if (!caller) return res.status(401).json({ error: 'User not found' });

  const isAdmin = caller.role === 'admin' || caller.role === 'super_admin' || caller.role === 'support';

  if (isAdmin) {
    res.json(supportTickets);
  } else {
    res.json(supportTickets.filter(t => t.userId === authUserId));
  }
});

router.post('/support-tickets', requireAuth, rateLimit(10, 60_000), (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const caller = users.find(u => u.id === authUserId);
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
    const currentStatus = caller.status;
    const currentFlagReason = caller.flagReason || 'Policy Violation';

    const hasActiveAppeal = supportTickets.some(t => {
      if (t.userId !== caller.id) return false;
      if (t.status !== 'open' && t.status !== 'in_progress') return false;
      if (!t.isAppeal && t.category !== 'appeal' && !String(t.subject || '').toLowerCase().includes('appeal')) return false;

      const ctx = t.appealContext;
      if (ctx) {
        return ctx.accountStatus === currentStatus && (ctx.flagReason || 'Policy Violation') === currentFlagReason;
      }
      return true;
    });

    if (hasActiveAppeal) {
      return res.status(409).json({
        error: 'An active appeal is already currently open for your account restriction. Please wait for our support team to review your case before submitting another appeal.'
      });
    }
  }

  const appealContext = isAppeal ? {
    accountStatus: caller.status,
    flagReason: caller.flagReason || 'Policy Violation',
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

  supportTickets.unshift(newTicket);
  postgresStore.saveSupportTickets(supportTickets).catch(err => console.error('[PostgresStore] Failed to save tickets:', err));

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: userName,
    role: caller.role,
    action: isAppeal ? 'ACCOUNT_APPEAL_SUBMITTED' : 'SUPPORT_TICKET_OPENED',
    target: `Ticket #${newTicket.id}`,
    details: isAppeal
      ? `User submitted account appeal for ${caller.status} status (Flag reason: ${caller.flagReason || 'None'}): ${safeSubject}`
      : `User submitted support request: ${safeSubject}`,
    timestamp: new Date().toLocaleString()
  });

  res.status(201).json({ success: true, ticket: newTicket, ...newTicket });
});

router.post('/admin/tickets/:id/reply', requireAdmin, (req: Request, res: Response) => {
  const t = supportTickets.find(tick => tick.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  t.messages.push({
    sender: 'WorkPerHour Support Staff',
    text: req.body.text,
    timestamp: new Date().toISOString()
  });
  t.status = 'in_progress';
  postgresStore.saveSupportTickets(supportTickets).catch(err => console.error('[PostgresStore] Failed to save tickets:', err));
  res.json(t);
});

router.get('/audit-logs', requireRole(['admin', 'super_admin']), (req: Request, res: Response) => res.json(auditLogs));

// ==========================================
// USER MANAGEMENT
// ==========================================

router.patch('/admin/users/:id', requireAdmin, (req: Request, res: Response) => {
  const u = users.find(user => user.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
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

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: caller?.name || adminActor(req),
    role: caller?.role || 'admin',
    action: 'USER_PROFILE_EDITED',
    target: `User ${u.name}`,
    details: `Updated profile details and parameters for ${u.email}`,
    timestamp: new Date().toLocaleString()
  });

  saveUsersToPostgres();
  res.json(safeUser(u));
});

router.patch('/admin/users/:id/status', requireAdmin, (req: Request, res: Response) => {
  const u = users.find(user => user.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
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

  saveUsersToPostgres();
  res.json(safeUser(u));
});

router.post('/admin/users/:id/impersonate', requireAdmin, (req: Request, res: Response) => {
  const u = users.find(user => user.id === req.params.id);
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
});

router.post('/admin/users/:id/stop-impersonate', requireAdmin, (req: Request, res: Response) => {
  const u = users.find(user => user.id === req.params.id);
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
});

router.patch('/admin/users/:id/verify', requireAdmin, (req: Request, res: Response) => {
  const u = users.find(user => user.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  u.verified = !u.verified;

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

  saveUsersToPostgres();
  res.json(safeUser(u));
});

router.delete('/admin/users/:id', requireAdmin, (req: Request, res: Response) => {
  const index = users.findIndex(user => user.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'User not found' });

  const target = users[index];
  if (target.role === 'super_admin') {
    return res.status(403).json({ error: 'Cannot delete a super_admin account.' });
  }
  if (financeLedger.hasOutstandingFunds(target.id)) {
    return res.status(409).json({ error: 'User still has wallet funds, pending withdrawals or active escrow. Resolve these before deleting the account.' });
  }
  if (orders.some(o => (o.buyerId === target.id || o.sellerId === target.id) && o.status !== 'completed' && o.status !== 'cancelled' && o.amount > 0)) {
    return res.status(409).json({ error: 'User has active paid orders. Complete or cancel them first.' });
  }
  const deletedUser = users[index];
  users.splice(index, 1);

  const remainingGigs = gigs.filter(g => g.freelancerId !== req.params.id);
  gigs.length = 0;
  gigs.push(...remainingGigs);
  const remainingProjects = projects.filter(p => p.buyerId !== req.params.id);
  projects.length = 0;
  projects.push(...remainingProjects);
  postgresStore.saveProjects(projects);

  saveUsersToPostgres();
  saveGigsToPostgres();

  const admin = (req as any).authenticatedUser;
  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: admin?.name || 'Admin',
    role: admin?.role || 'admin',
    action: 'USER_DELETED',
    target: `User ${deletedUser.name}`,
    details: `Permanently deleted user account ${deletedUser.email} and cleared their associated gigs & projects`,
    timestamp: new Date().toLocaleString()
  });

  disconnectUserSockets(req.params.id, 'Account deleted');

  res.json({ success: true, id: deletedUser.id });
});

// ==========================================
// DISPUTE RESOLUTION
// ==========================================

router.patch('/admin/disputes/:id/resolve', requireAdmin, async (req: Request, res: Response) => {
  let lockedOrderId: string | null = null;
  try {
    const d = disputes.find(disp => disp.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Dispute not found' });
    const status = req.body.status as Dispute['status'];
    if (!['open', 'under_investigation', 'resolved_refund', 'resolved_release', 'resolved_partial'].includes(status)) {
      return res.status(400).json({ error: 'Invalid dispute status.' });
    }
    if (d.status.startsWith('resolved')) return res.status(409).json({ error: `Dispute is already ${d.status}.` });
    const notes = String(req.body.notes || '');
    const reason = notes.trim().length >= 5 ? notes.trim() : 'Dispute resolved by administrator';
    const order = orderIndex.get(d.orderId);
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
      else await splitOrderFunds(order, Number(req.body.refundAmount), adminActor(req), reason);
    }
    d.status = status;
    d.resolutionNotes = notes;
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
      postgresStore.saveMessages(messages);
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
    postgresStore.saveDisputes(disputes);
    postgresStore.saveOrders(orders);
    postgresStore.saveRefunds(refunds);
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

router.get('/admin/messages/threads', requireAdmin, (req: Request, res: Response) => {
  const threads = orders.map(order => {
    const buyer = users.find(u => u.id === order.buyerId);
    const seller = users.find(u => u.id === order.sellerId);
    const orderMessages = messageIndex.get(order.id) || [];
    const lastMsg = orderMessages[orderMessages.length - 1];

    return {
      id: order.id,
      orderId: order.id,
      projectId: order.projectId,
      projectOrGigTitle: order.title,
      participantOne: {
        id: buyer?.id || order.buyerId,
        name: buyer?.name || order.buyerUsername || 'Buyer',
        avatar: buyer?.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop',
        role: 'client' as const,
        email: buyer?.email || 'buyer@example.com',
        status: (buyer?.status || 'active') as any
      },
      participantTwo: {
        id: seller?.id || order.sellerId,
        name: seller?.name || order.sellerUsername || 'Seller',
        avatar: seller?.avatar || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop',
        role: 'freelancer' as const,
        email: seller?.email || 'seller@example.com',
        status: (seller?.status || 'active') as any
      },
      lastMessageSnippet: lastMsg?.text || (orderMessages.length > 0 ? 'Attachment' : 'No messages in workstream'),
      lastMessageTime: lastMsg?.timestamp || order.createdAt,
      totalMessages: orderMessages.length,
      moderationStatus: 'clean' as const,
      flaggedCount: 0,
      messages: orderMessages.map(m => {
        const sender = users.find(u => u.id === m.senderId);
        return {
          id: m.id,
          senderId: m.senderId,
          senderName: m.senderName || sender?.name || 'Participant',
          senderAvatar: sender?.avatar || 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop',
          senderRole: (m.senderId === order.buyerId ? 'client' : 'freelancer') as ('client' | 'freelancer'),
          text: m.text,
          timestamp: m.timestamp
        };
      })
    };
  });

  res.json(threads);
});

// ==========================================
// ORDER AUTO-ACCEPT TRIGGER
// ==========================================

router.post('/admin/orders/check-auto-accept', requireAdmin, async (req: Request, res: Response) => {
  try {
    const processed = await processAutoAcceptOrders();
    res.json({ success: true, processedCount: processed.length, processed });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Auto-accept check failed' });
  }
});

export default router;
