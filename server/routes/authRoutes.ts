import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { users, type User } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  rateLimit,
  requireAuth,
  requireActiveStatus,
  resolveAuthenticatedUserId,
  safeUser,
  signToken,
  registerNewUserSession,
  MAX_ACTIVE_SESSIONS,
  IS_PRODUCTION,
  apiError
} from '../middleware/auth.js';
import { disconnectUserSockets } from '../websocket.js';
import {
  deliverSecurityCode,
  deliverAdminCode,
  recordUserEmail,
  EMAIL_DELIVERY_ENABLED
} from '../services/notificationService.js';
import {
  emailVerificationCodes,
  smsVerificationCodes,
  forgotPasswordCodes,
  withdrawalVerificationCodes,
  generate6DigitCode,
  isValidEmail,
  isValidMobile,
  checkRecoveryCode,
  handleLogin
} from '../services/authService.js';
import { handlePayoutRequest } from '../services/payoutService.js';
import { ensureWallet } from '../services/orderService.js';

export const authRouter = Router();

const isTestEnv = process.env.NODE_ENV === 'test';

// 1. Signup Endpoint
authRouter.post('/signup', rateLimit(20, 3_600_000), async (req: Request, res: Response) => {
  try {
    const { email, password, confirmPassword, mobile, name } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return apiError(res, 'Email and password are required.');
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ error: 'Password must be between 6 and 72 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const trimmedMobile = typeof mobile === 'string' ? mobile.trim() : '';
    if (trimmedMobile && !isValidMobile(trimmedMobile)) {
      return res.status(400).json({ error: 'Please enter a valid mobile number.' });
    }

    const existingEmail = users.find(u => u.email && u.email.toLowerCase() === normalizedEmail);
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    if (trimmedMobile) {
      const existingMobile = users.find(u => u.mobile && u.mobile.trim() === trimmedMobile);
      if (existingMobile) {
        return res.status(409).json({ error: 'An account with this mobile number already exists.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    if (users.some(u => u.email && u.email.toLowerCase() === normalizedEmail) ||
        (trimmedMobile && users.some(u => u.mobile && u.mobile.trim() === trimmedMobile))) {
      return res.status(409).json({ error: 'An account with this email or mobile number already exists.' });
    }
    const newUserId = 'user_' + Date.now() + '_' + randomBytes(3).toString('hex');
    const newUser: User = {
      id: newUserId,
      name: (typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : normalizedEmail.split('@')[0]),
      email: normalizedEmail,
      mobile: trimmedMobile || undefined,
      role: 'user',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&h=400&fit=crop',
      title: 'Freelancer / Member',
      rating: 0,
      reviewsCount: 0,
      hourlyRate: 50,
      earned: 0,
      completedJobs: 0,
      bio: 'New member on WorkPerHour.',
      skills: ['General'],
      status: 'active',
      verified: false,
      emailVerified: true,
      mobileVerified: false,
      walletBalance: 0,
      createdAt: new Date().toISOString().substring(0, 10),
      password: hashedPassword,
      sessionVersion: 1,
      activeSessionVersions: [1],
      knownDevices: req.body?.deviceId ? [String(req.body.deviceId).trim()] : ['dev_default_session']
    };

    users.push(newUser);
    try {
      await postgresStore.saveUsers(users);
    } catch (err) {
      console.error('[Signup] Failed to persist:', err);
      const idx = users.findIndex(u => u.id === newUser.id);
      if (idx !== -1) users.splice(idx, 1);
      return res.status(500).json({ error: 'Could not save. Please try again.' });
    }
    ensureWallet(newUserId);

    const emailCode = generate6DigitCode();
    emailVerificationCodes.set(normalizedEmail, {
      code: emailCode,
      expiresAt: Date.now() + 30 * 60 * 1000,
      lastResendAt: Date.now(),
      attempts: 0
    });

    deliverSecurityCode(normalizedEmail, 'SIGNUP_EMAIL', emailCode);

    if (trimmedMobile) {
      const smsCode = generate6DigitCode();
      smsVerificationCodes.set(trimmedMobile, {
        code: smsCode,
        expiresAt: Date.now() + 30 * 60 * 1000,
        lastResendAt: Date.now(),
        attempts: 0
      });
      deliverSecurityCode(trimmedMobile, 'SIGNUP_SMS', smsCode);
    }

    recordUserEmail({
      id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId: newUserId,
      userEmail: normalizedEmail,
      subject: 'Verify Your WorkPerHour Account',
      snippet: 'Welcome to WorkPerHour! Verification code dispatched.',
      body: 'Welcome to WorkPerHour! Please enter the verification code sent to your registered contact channel to verify your account.',
      date: new Date().toLocaleDateString(),
      read: false,
      type: 'GENERAL'
    });

    const token = signToken({ id: newUser.id, role: newUser.role, email: newUser.email, sessionVersion: newUser.sessionVersion });

    res.status(201).json({
      success: true,
      token,
      user: safeUser(newUser)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Signup failed' });
  }
});

// 2. Email Verification & Resend
authRouter.post('/verify-email', rateLimit(30, 3_600_000), (req: Request, res: Response) => {
  const { email, code: rawCode } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || rawCode === undefined || rawCode === null || String(rawCode).trim() === '') return res.status(400).json({ error: 'Email and code are required.' });
  const code = String(rawCode);
  const normalizedEmail = email.trim().toLowerCase();
  const record = emailVerificationCodes.get(normalizedEmail);
  if (!record) return res.status(400).json({ error: 'No verification code found or code expired.' });
  if (Date.now() > record.expiresAt) {
    emailVerificationCodes.delete(normalizedEmail);
    return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
  }
  if (record.attempts >= 5) {
    emailVerificationCodes.delete(normalizedEmail);
    return res.status(429).json({ error: 'Too many failed attempts. Code invalidated.' });
  }
  if (record.code !== code.trim()) {
    record.attempts++;
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  emailVerificationCodes.delete(normalizedEmail);
  const user = users.find(u => u.email && u.email.toLowerCase() === normalizedEmail);
  if (user) {
    (user as any).emailVerified = true;
    user.verified = true;
    postgresStore.saveUsers(users);
  }
  res.json({ success: true, message: 'Email verified successfully!' });
});

authRouter.post('/resend-email-code', rateLimit(10, 3_600_000), (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  const normalizedEmail = email.trim().toLowerCase();
  const user = users.find(u => u.email && u.email.toLowerCase() === normalizedEmail);
  const generic = { success: true, message: 'If this email needs verification, a new code has been sent.' };
  if (!user || (user as any).emailVerified) return res.json(generic);

  const existing = emailVerificationCodes.get(normalizedEmail);
  const now = Date.now();
  if (existing && now - existing.lastResendAt < 30_000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before requesting a new resend.' });
  }

  const newCode = generate6DigitCode();
  emailVerificationCodes.set(normalizedEmail, {
    code: newCode,
    expiresAt: now + 30 * 60 * 1000,
    lastResendAt: now,
    attempts: 0
  });

  deliverSecurityCode(normalizedEmail, 'EMAIL_VERIFICATION', newCode);

  recordUserEmail({
    id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
    userId: user.id,
    userEmail: normalizedEmail,
    subject: 'Your New WorkPerHour Verification Code',
    snippet: 'A new verification code was dispatched.',
    body: 'A new verification code was requested for your account. Please enter the code sent to your registered contact channel.',
    date: new Date().toLocaleDateString(),
    read: false,
    type: 'GENERAL'
  });

  res.json(generic);
});

// 3. Mobile / SMS Verification & Resend
authRouter.post('/verify-sms', rateLimit(30, 3_600_000), (req: Request, res: Response) => {
  const { mobile, code: rawCode } = req.body || {};
  if (typeof mobile !== 'string' || !mobile.trim() || rawCode === undefined || rawCode === null || String(rawCode).trim() === '') return res.status(400).json({ error: 'Mobile number and code are required.' });
  const code = String(rawCode);
  const cleanMobile = mobile.trim();
  const record = smsVerificationCodes.get(cleanMobile);
  if (!record) return res.status(400).json({ error: 'No SMS verification code found or expired.' });
  if (Date.now() > record.expiresAt) {
    smsVerificationCodes.delete(cleanMobile);
    return res.status(400).json({ error: 'SMS verification code has expired.' });
  }
  if (record.attempts >= 5) {
    smsVerificationCodes.delete(cleanMobile);
    return res.status(429).json({ error: 'Too many failed attempts.' });
  }
  if (record.code !== code.trim()) {
    record.attempts++;
    return res.status(400).json({ error: 'Invalid SMS verification code.' });
  }

  smsVerificationCodes.delete(cleanMobile);
  const user = users.find(u => u.mobile === cleanMobile);
  if (user) {
    (user as any).mobileVerified = true;
    user.verified = true;
    postgresStore.saveUsers(users);
  }
  res.json({ success: true, message: 'Mobile verified successfully via SMS! Account is now active and usable.' });
});

authRouter.post('/resend-sms-code', rateLimit(10, 3_600_000), (req: Request, res: Response) => {
  const { mobile } = req.body || {};
  if (typeof mobile !== 'string' || !mobile.trim()) return res.status(400).json({ error: 'Mobile number is required.' });
  const cleanMobile = mobile.trim();
  const existing = smsVerificationCodes.get(cleanMobile);
  const now = Date.now();
  if (existing && now - existing.lastResendAt < 30_000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before resending SMS.' });
  }

  const newCode = generate6DigitCode();
  smsVerificationCodes.set(cleanMobile, {
    code: newCode,
    expiresAt: now + 30 * 60 * 1000,
    lastResendAt: now,
    attempts: 0
  });

  deliverSecurityCode(cleanMobile, 'SMS_OTP', newCode);
  res.json({ success: true, message: 'New SMS OTP dispatched.' });
});

// 4. Login Endpoints
authRouter.post('/login', handleLogin);
authRouter.post('/login/verify', handleLogin);

// 5. Current Session (Me)
authRouter.get('/me', (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req);
  if (!authUserId) {
    return res.status(401).json({ error: 'Unauthenticated session token.' });
  }
  const u = users.find(user => user.id === authUserId);
  if (!u) {
    return res.status(401).json({ error: 'User account not found.' });
  }
  return res.json({ success: true, user: safeUser(u) });
});

// 6. Demo Session (dev/test only)
authRouter.post('/demo-session', async (req: Request, res: Response) => {
  if (IS_PRODUCTION && !isTestEnv) return res.status(404).json({ error: 'Not found.' });
  const { userId } = req.body || {};
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Demo user not found.' });
  if (['admin', 'super_admin', 'support'].includes(user.role)) {
    return res.status(403).json({ error: 'Demo login is not available for privileged accounts.' });
  }
  const sessionVersion = registerNewUserSession(user);
  try {
    await postgresStore.saveUsers(users);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to persist demo session.' });
  }
  const token = signToken({ id: user.id, role: user.role, email: user.email, sessionVersion });
  return res.json({ success: true, token, user: safeUser(user) });
});

// 7. Forgot Password Flow
authRouter.post('/forgot-password/request', rateLimit(10, 3_600_000), (req: Request, res: Response) => {
  const { emailOrMobile } = req.body || {};
  if (typeof emailOrMobile !== 'string' || !emailOrMobile.trim()) return res.status(400).json({ error: 'Email or mobile is required.' });
  const query = emailOrMobile.trim().toLowerCase();
  const genericResponse = { success: true, message: 'If an account exists, a recovery code has been sent.' };
  const user = users.find(u => (u.email && u.email.toLowerCase() === query) || u.mobile === query);
  if (!user) {
    return res.json(genericResponse);
  }

  const existing = forgotPasswordCodes.get(query);
  if (existing && Date.now() - existing.lastResendAt < 30_000) {
    return res.json(genericResponse);
  }

  const code = generate6DigitCode();
  forgotPasswordCodes.set(query, {
    code,
    expiresAt: Date.now() + 30 * 60 * 1000,
    lastResendAt: Date.now(),
    attempts: 0
  });

  if (user.role === 'admin' || user.role === 'super_admin') {
    deliverAdminCode(user.email, code);
  } else if (user.email) {
    deliverSecurityCode(user.email, 'PASSWORD_RESET', code);
  } else if (user.mobile) {
    deliverSecurityCode(user.mobile, 'PASSWORD_RESET', code);
  }

  res.json({ ...genericResponse });
});

authRouter.post('/forgot-password/verify', (req: Request, res: Response) => {
  const { emailOrMobile, code } = req.body || {};
  if (typeof emailOrMobile !== 'string' || !emailOrMobile.trim() || !code) return res.status(400).json({ error: 'Identifier and code are required.' });
  const query = emailOrMobile.trim().toLowerCase();
  const check = checkRecoveryCode(query, code, true);
  if (check === 'locked') return res.status(429).json({ error: 'Too many failed attempts. Please request a new recovery code.' });
  if (check !== 'ok') {
    return res.status(400).json({ error: 'Invalid or expired recovery code.' });
  }
  res.json({ success: true, message: 'Code verified successfully.' });
});

authRouter.post('/forgot-password/reset', async (req: Request, res: Response) => {
  const { emailOrMobile, code, newPassword, confirmPassword, confirmNewPassword } = req.body || {};
  if (typeof emailOrMobile !== 'string' || !emailOrMobile.trim() || !code || typeof newPassword !== 'string' || !newPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  const confirmToUse = confirmPassword || confirmNewPassword;
  if (confirmToUse && newPassword !== confirmToUse) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }
  if (newPassword.length > 72) {
    return res.status(400).json({ error: 'New password must be at most 72 characters long.' });
  }
  const query = emailOrMobile.trim().toLowerCase();
  const record = forgotPasswordCodes.get(query);
  if (!record || !record.verified || Date.now() > record.expiresAt || record.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Invalid or expired recovery code. Please request a new one.' });
  }

  const user = users.find(u => (u.email && u.email.toLowerCase() === query) || u.mobile === query);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  user.password = await bcrypt.hash(newPassword, 10);
  user.sessionVersion = (user.sessionVersion || 1) + MAX_ACTIVE_SESSIONS;
  (user as any).activeSessionVersions = [];
  postgresStore.saveUsers(users);
  disconnectUserSockets(user.id, 'Password reset');
  forgotPasswordCodes.delete(query);

  res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
});

// 8. Withdrawal Code Request & Execute
authRouter.post('/withdrawal/request-code', requireAuth, (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (!caller || !caller.email) return res.status(400).json({ error: 'User email not found.' });

  const code = generate6DigitCode();
  withdrawalVerificationCodes.set(caller.id, {
    code,
    expiresAt: Date.now() + 30 * 60 * 1000,
    lastResendAt: Date.now(),
    attempts: 0
  });

  deliverSecurityCode(caller.email, 'WITHDRAWAL', code);

  recordUserEmail({
    id: 'email_' + Date.now(),
    userId: caller.id,
    userEmail: caller.email,
    subject: 'Withdrawal Email Verification Requested',
    snippet: 'Withdrawal verification code dispatched.',
    body: 'You requested a withdrawal from your WorkPerHour wallet. Please use the verification code sent to your registered contact channel to complete the transaction.',
    date: new Date().toLocaleDateString(),
    read: false,
    type: 'GENERAL'
  });

  res.json({
    success: true,
    message: 'Withdrawal verification code sent to your registered email.',
    codeRequired: EMAIL_DELIVERY_ENABLED || !IS_PRODUCTION
  });
});

authRouter.post('/withdrawal/verify-and-execute', requireAuth, requireActiveStatus, rateLimit(10, 60_000), (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  req.body.userId = caller.id;
  return handlePayoutRequest(req, res);
});
