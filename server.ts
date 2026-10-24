import express from 'express';
import fs from 'fs';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initWebSocketServer } from './server/websocket.js';
import { runBackgroundJobs } from './server/jobs/backgroundJobs.js';
import { setupSSR } from './server/ssr.js';
import { slugify } from './src/utils/slugify.js';
import { postgresStore } from './server/db/postgresStore.js';
import { apiRouter } from './server/routes/index.js';
import { categories } from './server/routes/adminRoutes.js';
import { rootRouter } from './server/routes/rootRoutes.js';
import { siteSettings, DEFAULT_SITE_SETTINGS } from './src/server/siteSettings.js';
import { isGigPublic, sanitizePublicGig } from './server/publicData.js';
import { safeUser } from './server/middleware/auth.js';
import {
  saveOrdersToDisk,
  hydrateStoreFromPostgres
} from './server/store.js';

const users: any[] = [];
const gigs: any[] = [];
const orders: any[] = [];
const projects: any[] = [];
const proposals: any[] = [];
const reviews: any[] = [];
const messages: any[] = [];
const disputes: any[] = [];
const refunds: any[] = [];
const payouts: any[] = [];
const customInvoices: any[] = [];
const workstreamOffers: any[] = [];
const auditLogs: any[] = [];
import {
  clearingEarnings,
  getUnclearedEarnings,
  releaseOrderFunds,
  refundOrderFunds,
  processAutoAcceptOrders,
  isAutoAcceptEnabled,
  getReviewWindowDays,
  registerOrder,
  orderIndex
} from './server/services/orderService.js';

// Backward compatibility exports for existing unit and regression tests
export {
  orders,
  users,
  gigs,
  projects,
  proposals,
  reviews,
  messages,
  disputes,
  refunds,
  payouts,
  customInvoices,
  workstreamOffers,
  auditLogs,
  categories,
  siteSettings,
  DEFAULT_SITE_SETTINGS,
  isGigPublic,
  sanitizePublicGig,
  safeUser,
  saveOrdersToDisk,
  clearingEarnings,
  getUnclearedEarnings,
  releaseOrderFunds,
  refundOrderFunds,
  processAutoAcceptOrders,
  isAutoAcceptEnabled,
  getReviewWindowDays,
  registerOrder,
  orderIndex
};
export { verifyAndConsumeWithdrawalCode, mockCode } from './server/services/authService.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const app = express();
app.set('trust proxy', 1);

// Production detection
const isCompiledProductionBundle = path.basename(fileURLToPath(import.meta.url)).startsWith('server.js');
const isNpmStart = process.env.npm_lifecycle_event === 'start';
const isExplicitProd = process.env.NODE_ENV === 'production';
const isTestEnv = process.env.NODE_ENV === 'test';
export const IS_PRODUCTION = (isExplicitProd || isNpmStart || isCompiledProductionBundle) && !isTestEnv;
const IS_PROD = IS_PRODUCTION;

if (IS_PROD) {
  (process.env as any).NODE_ENV = 'production';
}

// Global Security Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  (req as any).requestId = randomUUID();
  res.setHeader('X-Request-ID', (req as any).requestId);
  next();
});

// JSON Body Parser with raw body exemption for webhook endpoints
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook' && req.method === 'POST') {
    return next();
  }
  return express.json({ limit: '10mb' })(req, res, next);
});

// Mount Central API Router
app.use('/api', apiRouter);

// Register root routes (robots.txt, sitemap.xml)
app.use('/', rootRouter);


export const server = createServer(app);

// Initialize WebSocket Engine
initWebSocketServer(server);

// Application Startup & Hydration
(async () => {
  try {
    await hydrateStoreFromPostgres();
    runBackgroundJobs();
  } catch (err) {
    console.error('[FATAL] Postgres hydration failed; refusing to start:', err);
    process.exit(1);
  }

  await setupSSR(app, IS_PROD, __dirname, async () => {
    try {
      const pool = postgresStore.getPool();
      const [gigsRes, usersRes, projectsRes] = await Promise.all([
        pool.query("SELECT * FROM gigs WHERE status = 'published' LIMIT 50"),
        pool.query("SELECT * FROM users WHERE status = 'active' LIMIT 50"),
        pool.query("SELECT * FROM projects WHERE status = 'open' LIMIT 50")
      ]);
      
      const gigs = gigsRes.rows.map(r => ({
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
          rating: Number(r.rating || 5.0),
          reviewsCount: Number(r.reviews_count || 0),
          image: r.image || 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&h=500&fit=crop',
          coverImage: r.cover_image || '',
          gallery: r.gallery || [],
          tags: r.tags || [],
          status: r.status,
          createdAt: r.created_at,
          extras: r.extras || []
        }));

      const users = usersRes.rows.map(r => ({
          id: r.id,
          name: r.name,
          username: r.username,
          email: r.email,
          mobile: r.mobile,
          role: r.role,
          avatar: r.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
          title: r.title || '',
          rating: Number(r.rating || 5.0),
          reviewsCount: Number(r.reviews_count || 0),
          hourlyRate: Number(r.hourly_rate || 0),
          earned: Number(r.earned || 0),
          completedJobs: Number(r.completed_jobs || 0),
          bio: r.bio || '',
          skills: r.skills || [],
          status: r.status,
          verified: Boolean(r.verified),
          emailVerified: Boolean(r.email_verified),
          mobileVerified: Boolean(r.mobile_verified),
          walletBalance: Number(r.wallet_balance || 0),
          createdAt: r.created_at,
          isFlagged: Boolean(r.is_flagged),
          flagReason: r.flag_reason,
          sessionVersion: Number(r.session_version || 1),
          knownDevices: r.known_devices || [],
          isAvailableNow: Boolean(r.is_available_now),
          notificationPreferences: r.notification_preferences
        }));

      const projects = projectsRes.rows.map(r => ({
          id: r.id,
          buyerId: r.buyer_id,
          buyerName: r.buyer_name,
          buyerAvatar: r.buyer_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
          title: r.title,
          slug: r.slug || r.title?.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, ''),
          description: r.description,
          category: r.category,
          budgetType: r.budget_type,
          budget: Number(r.budget),
          budgetMin: Number(r.budget_min),
          budgetMax: Number(r.budget_max),
          deadlineDays: Number(r.deadline_days),
          duration: r.duration,
          status: r.status,
          proposalsCount: Number(r.proposals_count || 0),
          skills: r.skills || [],
          createdAt: r.created_at,
          acceptedProposalId: r.accepted_proposal_id || undefined
        }));
      
      return { gigs, users, projects, categories: [] };
    } catch (err) {
      console.error('[SSR] Error fetching data for SSR:', err);
      return { gigs: [], users: [], projects: [], categories: [] };
    }
  });

  const portArgIndex = process.argv.findIndex(arg => arg === '--port' || arg === '-p');
  const cliPort = portArgIndex !== -1 && process.argv[portArgIndex + 1] ? Number(process.argv[portArgIndex + 1]) : null;
  const PORT = cliPort || Number(process.env.PORT) || 3000;

  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });

  if (!server.listening) {
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${PORT} in use, selecting dynamic fallback port`);
        server.listen(0, '0.0.0.0');
      }
    });
    server.listen(Number(PORT), '0.0.0.0', () => {
      const actualPort = (server.address() as any)?.port || PORT;
      console.log(`WorkPerHour server running on http://0.0.0.0:${actualPort}`);
    });
  }
})();

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Initiating graceful shutdown...`);
  
  // 1. Stop accepting new requests
  server.close(async () => {
    console.log('HTTP server closed.');
    
    // 2. Close DB connections
    try {
      await postgresStore.getPool().end();
      console.log('Postgres pool closed.');
    } catch (err) {
      console.error('Error closing Postgres pool:', err);
    }
    
    // 3. Flush pending writes
    await postgresStore.flushAll();
    console.log('Pending writes flushed.');
    
    process.exit(0);
  });
  
  // Force exit after 10s if not shut down
  setTimeout(() => {
    console.error('Shutdown timeout, forcing exit.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
