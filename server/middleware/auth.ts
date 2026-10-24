import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { store, type User } from '../store.js';
import { disconnectUserSessionSocket } from '../websocket.js';

const isCompiledProductionBundle = path.basename(fileURLToPath(import.meta.url)).startsWith('server.js');
export const IS_PRODUCTION = process.env.NODE_ENV === 'production' || isCompiledProductionBundle;

export const JWT_SECRET: string = (() => {
  const fromEnv = process.env.JWT_SECRET;
  if (IS_PRODUCTION && (!fromEnv || fromEnv.length < 32)) {
    throw new Error('FATAL: JWT_SECRET must be configured in production and be at least 32 chars.');
  }
  return fromEnv || 'wph_jwt_secret_internal_session_token_key_2026';
})();

export const MAX_ACTIVE_SESSIONS = 3;

export function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function areSimulatedDepositsAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return !IS_PRODUCTION;
}

export function apiError(res: Response, message: string, status: number = 400) {
  return res.status(status).json({ error: message });
}

export function getUserActiveSessions(user: User): number[] {
  if (!Array.isArray((user as any).activeSessionVersions)) {
    const current = user.sessionVersion ? Number(user.sessionVersion) : 1;
    const versions: number[] = [];
    const minVer = Math.max(1, current - (MAX_ACTIVE_SESSIONS - 1));
    for (let v = minVer; v <= current; v++) {
      versions.push(v);
    }
    (user as any).activeSessionVersions = versions;
  }
  return (user as any).activeSessionVersions;
}

export function registerNewUserSession(user: User): number {
  const nextVersion = (user.sessionVersion || 0) + 1;
  user.sessionVersion = nextVersion;
  const sessions = getUserActiveSessions(user);
  sessions.push(nextVersion);
  while (sessions.length > MAX_ACTIVE_SESSIONS) {
    const evicted = sessions.shift();
    if (evicted !== undefined) {
      disconnectUserSessionSocket(user.id, evicted);
    }
  }
  (user as any).activeSessionVersions = sessions;
  return nextVersion;
}

export function signToken(
  payload: { id: string; role: string; email: string; sessionVersion?: number },
  expiresInMs = 7 * 24 * 3600 * 1000
): string {
  const data = JSON.stringify({ ...payload, exp: Date.now() + expiresInMs });
  const base64Data = Buffer.from(data).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(base64Data).digest('base64url');
  return `${base64Data}.${signature}`;
}

export function verifyToken(token: string): { id: string; role: string; email: string; sessionVersion?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [base64Data, signature] = parts;
    const expectedSig = createHmac('sha256', JWT_SECRET).update(base64Data).digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(base64Data, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// Global Authentication Middleware: verifies cryptographic signed JWT/session and populates req.user
export async function verifyAuthTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const payload = verifyToken(token);
    if (payload) {
      const dbUser = await store.getUser(payload.id);
      if (dbUser) {
        if (payload.sessionVersion !== undefined) {
          const activeSessions = getUserActiveSessions(dbUser);
          if (!activeSessions.includes(payload.sessionVersion)) {
            if (payload.sessionVersion === dbUser.sessionVersion) {
              activeSessions.push(payload.sessionVersion);
            } else {
              (req as any).user = null;
              (req as any).authenticatedUserId = null;
              (req as any).authenticatedUser = null;
              return next();
            }
          }
        }
        (req as any).user = {
          id: dbUser.id,
          role: dbUser.role,
          status: dbUser.status,
          email: dbUser.email
        };
        (req as any).authenticatedUserId = dbUser.id;
        (req as any).authenticatedUser = dbUser;
        return next();
      }
    }
  }

  (req as any).user = null;
  (req as any).authenticatedUserId = null;
  (req as any).authenticatedUser = null;
  next();
}

export function resolveAuthenticatedUserId(req: Request): string | null {
  const authUser = (req as any).user?.id || (req as any).authenticatedUserId;
  if (authUser && typeof authUser === 'string' && authUser.trim()) {
    return authUser.trim();
  }
  return null;
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let lastPruneTime = Date.now();

export function rateLimit(max: number, windowMs: number, prefix: string = '') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'test') {
      return next();
    }
    const identity = (req as any).authenticatedUserId || req.ip || req.socket?.remoteAddress || 'anon';
    const route = prefix || req.route?.path || req.path;
    const key = `${route}:${identity}`;
    const now = Date.now();

    // Periodic cleanup of expired rate buckets to prevent unbounded memory growth
    if (now - lastPruneTime > 60000 || rateBuckets.size > 500) {
      lastPruneTime = now;
      for (const [k, r] of rateBuckets.entries()) {
        if (now > r.resetAt) rateBuckets.delete(k);
      }
    }

    const record = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count++;
    rateBuckets.set(key, record);
    if (record.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

export function safeUser(user: any) {
  if (!user) return null;
  const { password, knownDevices, sessionVersion, activeSessionVersions, ...safe } = user;
  return safe;
}

export function orderParticipantSafeUser(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatar: user.avatar,
    title: user.title,
    rating: user.rating,
    reviewsCount: user.reviewsCount,
    hourlyRate: user.hourlyRate,
    skills: user.skills,
    verified: user.verified,
    status: user.status
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authUserId = resolveAuthenticatedUserId(req);
  if (!authUserId) {
    return res.status(401).json({ error: 'Authentication required. Please provide a valid session token.' });
  }
  let u = (req as any).authenticatedUser;
  if (!u || u.id !== authUserId) {
    u = await store.getUser(authUserId);
  }
  if (!u) {
    return res.status(401).json({ error: 'User account not found.' });
  }
  if (u.status === 'deactivated') {
    return res.status(403).json({ error: 'Forbidden: This account has been permanently deactivated.' });
  }
  (req as any).authenticatedUserId = u.id;
  (req as any).authenticatedUser = u;
  next();
}

export function requireActiveStatus(req: Request, res: Response, next: NextFunction) {
  const u = (req as any).authenticatedUser;
  if (!u) return res.status(401).json({ error: 'Authentication required.' });

  if (u.status === 'suspended') {
    return res.status(403).json({ error: 'Action forbidden: Your account is currently suspended. Please submit an appeal via Support.' });
  }
  if (u.status === 'restricted') {
    return res.status(403).json({ error: 'Action forbidden: Your account privileges are restricted. Please contact support.' });
  }
  next();
}

export const STAFF_ROLES = ['admin', 'super_admin', 'support'];
export function isStaffUser(user: any): boolean {
  return !!user && STAFF_ROLES.includes(user.role);
}

export function canAccessOrderWorkstream(user: any, order: { buyerId: string; sellerId: string } | undefined): boolean {
  if (!user || !order) return false;
  return isStaffUser(user) || user.id === order.buyerId || user.id === order.sellerId;
}

export function adminActor(req: Request): string {
  const authUser = (req as any).authenticatedUser;
  if (authUser) return `${authUser.name} (${authUser.role || 'admin'})`;
  return 'Administrator';
}

export function requireRole(allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authUserId = resolveAuthenticatedUserId(req);
    if (!authUserId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    let u = (req as any).authenticatedUser;
    if (!u || u.id !== authUserId) {
      u = await store.getUser(authUserId);
    }
    if (!u) {
      return res.status(401).json({ error: 'User not found.' });
    }
    if (!allowedRoles.includes(u.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    }
    (req as any).authenticatedUserId = u.id;
    (req as any).authenticatedUser = u;
    next();
  };
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authUserId = resolveAuthenticatedUserId(req);
  if (!authUserId) {
    return res.status(401).json({ error: 'Authentication required. Valid admin session missing.' });
  }
  let u = (req as any).authenticatedUser;
  if (!u || u.id !== authUserId) {
    u = await store.getUser(authUserId);
  }
  if (!u || (u.role !== 'super_admin' && u.role !== 'admin')) {
    return res.status(403).json({ error: 'Forbidden: Administrator privileges required.' });
  }
  (req as any).authenticatedUserId = u.id;
  (req as any).authenticatedUser = u;
  next();
}
