import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { store } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  signToken,
  safeUser,
  registerNewUserSession,
  MAX_ACTIVE_SESSIONS,
  IS_PRODUCTION
} from '../middleware/auth.js';
import { disconnectUserSockets } from '../websocket.js';
import {
  deliverSecurityCode,
  deliverAdminCode,
  recordUserEmail
} from './notificationService.js';

export interface VerificationRecord {
  code: string;
  expiresAt: number;
  lastResendAt: number;
  attempts: number;
  verified?: boolean;
}

export const emailVerificationCodes = new Map<string, VerificationRecord>();
export const smsVerificationCodes = new Map<string, VerificationRecord>();
export const forgotPasswordCodes = new Map<string, VerificationRecord>();
export const withdrawalVerificationCodes = new Map<string, VerificationRecord>();

export function generate6DigitCode(): string {
  return randomInt(100000, 1000000).toString();
}

export function mockCode(_key: string, _code: string): Record<string, string> {
  return {};
}

const USER_DEVICE_VERIFICATION = process.env.USER_DEVICE_VERIFICATION
  ? process.env.USER_DEVICE_VERIFICATION === 'true'
  : !IS_PRODUCTION;

export function isValidEmail(v: string): boolean {
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isValidMobile(v: string): boolean {
  return /^\+?[0-9][0-9\s\-()]{6,18}$/.test(v);
}

export function verifyAndConsumeWithdrawalCode(userId: string, code: unknown): { ok: true } | { ok: false; status: number; error: string } {
  if (!code || typeof code !== 'string') {
    return { ok: false, status: 400, error: 'Email verification code is required for withdrawal. Please request a code first via /api/auth/withdrawal/request-code.' };
  }
  const record = withdrawalVerificationCodes.get(userId);
  if (!record) {
    return { ok: false, status: 400, error: 'No active withdrawal verification code found. Please request a new code via /api/auth/withdrawal/request-code.' };
  }
  if (Date.now() > record.expiresAt) {
    withdrawalVerificationCodes.delete(userId);
    return { ok: false, status: 400, error: 'Withdrawal verification code has expired. Please request a new code.' };
  }
  if (record.attempts >= 5) {
    withdrawalVerificationCodes.delete(userId);
    return { ok: false, status: 429, error: 'Too many incorrect attempts. Verification code invalidated. Please request a new code.' };
  }
  if (record.code !== code.trim()) {
    record.attempts++;
    return { ok: false, status: 400, error: 'Invalid verification code.' };
  }
  withdrawalVerificationCodes.delete(userId);
  return { ok: true };
}

export function checkRecoveryCode(query: string, code: unknown, markVerified = false): 'ok' | 'invalid' | 'locked' {
  const record = forgotPasswordCodes.get(query);
  if (!record || Date.now() > record.expiresAt) return 'invalid';
  if (record.attempts >= 5) {
    forgotPasswordCodes.delete(query);
    return 'locked';
  }
  if (typeof code !== 'string' && typeof code !== 'number') return 'invalid';
  if (record.code !== String(code).trim()) {
    record.attempts++;
    return 'invalid';
  }
  if (markVerified) record.verified = true;
  return 'ok';
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export async function handleLogin(req: Request, res: Response) {
  const clientIp = (req.ip || req.socket.remoteAddress || 'unknown-client').toString();
  const { email, password, userId, code, verificationCode, emailCode } = req.body || {};
  const lookupEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
  const lookupId = typeof userId === 'string' && userId.trim() ? userId.trim() : null;

  const now = Date.now();
  const cooldownMs = process.env.NODE_ENV === 'test' ? 2000 : 60000;
  const attemptKeys = [clientIp, ...(lookupEmail || lookupId ? ['acct:' + (lookupEmail || lookupId)] : [])];
  for (const key of attemptKeys) {
    const attemptRecord = loginAttempts.get(key);
    if (!attemptRecord) continue;
    if (now < attemptRecord.resetAt && attemptRecord.count >= 5) {
      return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
    }
    if (now >= attemptRecord.resetAt) {
      loginAttempts.delete(key);
    }
  }

  function recordFailedLogin() {
    for (const key of attemptKeys) {
      const record = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + cooldownMs };
      record.count++;
      loginAttempts.set(key, record);
    }
  }

  if (!lookupEmail && !lookupId) {
    return res.status(401).json({ error: 'Email is required for login.' });
  }

  if (typeof password !== 'string' || !password.trim()) {
    return res.status(401).json({ error: 'Password is required.' });
  }

  let user: any = null;
  if (lookupEmail) {
    const userRes = await postgresStore.getPool().query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [lookupEmail]);
    if (userRes.rows.length > 0) {
      user = await store.getUser(userRes.rows[0].id);
    }
  } else if (lookupId) {
    user = await store.getUser(lookupId);
  }

  if (!user) {
    recordFailedLogin();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const passwordMatch = typeof user.password === 'string' && user.password.length > 0 && (await bcrypt.compare(password, user.password));
  if (!passwordMatch) {
    recordFailedLogin();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: `Account is ${user.status}.` });
  }

  const rawDeviceId = req.body?.deviceId || req.headers['x-device-id'];
  const deviceId = rawDeviceId ? String(rawDeviceId).trim() : 'dev_default_session';

  if (!user.knownDevices || !Array.isArray(user.knownDevices)) {
    user.knownDevices = [];
  }

  const isAdminRole = user.role === 'admin' || user.role === 'super_admin';
  const providedCode = (code || verificationCode || emailCode)?.toString().trim();
  const isPlaceholderDevice = deviceId === 'dev_default_session' || deviceId === 'unknown';
  const trustedDevice = user.knownDevices.includes(deviceId) && !(isAdminRole && isPlaceholderDevice);
  const devBypass = !IS_PRODUCTION && !isAdminRole && (isPlaceholderDevice || Boolean(req.body?.skipDeviceVerification));
  const requiresVerification = isAdminRole
    ? !trustedDevice
    : (USER_DEVICE_VERIFICATION && !trustedDevice && !devBypass);

  if (requiresVerification) {
    const userEmailKey = (user.email || lookupEmail || user.id).toLowerCase();

    if (!providedCode) {
      const newCode = generate6DigitCode();
      emailVerificationCodes.set(userEmailKey, {
        code: newCode,
        expiresAt: Date.now() + 30 * 60 * 1000,
        lastResendAt: Date.now(),
        attempts: 0
      });

      deliverSecurityCode(user.email, isAdminRole ? 'ADMIN_2FA' : 'DEVICE_LOGIN', newCode);

      recordUserEmail({
        id: 'email_' + Date.now(),
        userId: user.id,
        userEmail: user.email,
        subject: isAdminRole ? 'Admin Login Security Notice' : 'New Device Login Security Notice',
        snippet: 'Security verification code dispatched.',
        body: isAdminRole
          ? 'An administrator login attempt was initiated. Please enter the verification code sent to your registered admin contact channel to access the Admin Dashboard.'
          : `A login attempt from a new device (${deviceId}) was detected. Please enter the verification code sent to your registered contact channel.`,
        date: new Date().toLocaleDateString(),
        read: false,
        type: 'GENERAL'
      });

      return res.status(200).json({
        requiresVerification: true,
        requireCode: true,
        message: isAdminRole
          ? 'Admin login requires an email verification code. Code sent to your registered admin email.'
          : 'New device detected. Please provide the email verification code sent to your email.',
        deviceId,
        mockEmailCode: !IS_PRODUCTION ? newCode : undefined
      });
    }

    const record = emailVerificationCodes.get(userEmailKey);
    if (!record || Date.now() > record.expiresAt) {
      recordFailedLogin();
      return res.status(400).json({ error: 'Invalid or expired email verification code.' });
    }
    if (record.attempts >= 5) {
      emailVerificationCodes.delete(userEmailKey);
      return res.status(429).json({ error: 'Too many failed attempts. Please log in again to receive a new code.' });
    }
    if (record.code !== providedCode) {
      record.attempts++;
      recordFailedLogin();
      return res.status(400).json({ error: 'Invalid or expired email verification code.' });
    }

    emailVerificationCodes.delete(userEmailKey);
    if (!user.knownDevices.includes(deviceId)) {
      user.knownDevices.push(deviceId);
      if (user.knownDevices.length > 10) user.knownDevices.shift();
    }
  }

  const sessionVersion = registerNewUserSession(user);

  for (const key of attemptKeys) loginAttempts.delete(key);

  try {
    await store.saveUser(user);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to persist login session.' });
  }

  const token = signToken({ id: user.id, role: user.role, email: user.email, sessionVersion });
  return res.json({
    success: true,
    token,
    user: safeUser(user)
  });
}
