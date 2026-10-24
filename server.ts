import express from 'express';
import fs from 'fs';
import { createServer } from 'http';
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
  users,
  gigs,
  orders,
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
  saveOrdersToDisk,
  hydrateStoreFromPostgres
} from './server/store.js';
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

  await setupSSR(app, IS_PROD, __dirname, () => ({ gigs, users, projects, categories }));

  const portArgIndex = process.argv.findIndex(arg => arg === '--port' || arg === '-p');
  const cliPort = portArgIndex !== -1 && process.argv[portArgIndex + 1] ? Number(process.argv[portArgIndex + 1]) : null;
  const PORT = cliPort || (process.env.PORT && process.env.PORT !== '8080' ? Number(process.env.PORT) : 3000);

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
  console.log(`Received ${signal}. Flushing pending writes...`);
  await postgresStore.flushAll();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
