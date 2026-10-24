import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { type Payout } from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { DEFAULT_SITE_SETTINGS } from '../../src/server/siteSettings.js';
import { financialTransactionService, financialRepository } from './financialService.js';
import { EMAIL_DELIVERY_ENABLED } from './notificationService.js';
import {
  resolveAuthenticatedUserId,
  adminActor,
  IS_PRODUCTION
} from '../middleware/auth.js';
import { verifyAndConsumeWithdrawalCode } from './authService.js';
import { syncUserBalances, registerAuditLog } from './orderService.js';

export const ALLOWED_METHODS: Record<string, keyof typeof DEFAULT_SITE_SETTINGS.wallets.allowedPayoutMethods> = {
  'UPI': 'upi',
  'Bank Transfer': 'bankTransfer',
  'Stripe': 'stripeConnect',
  'Razorpay': 'razorpayX',
  'PayPal': 'paypal'
};

export function resolvePayoutUserId(req: Request): string | null {
  return resolveAuthenticatedUserId(req);
}

export function formatPayoutRow(r: any): Payout {
  return {
    id: r.id,
    freelancerId: r.freelancer_id,
    amount: Number(r.amount),
    method: r.method,
    status: r.status,
    createdAt: r.created_at,
    accountDetails: r.account_details || r.details?.accountDetails || ''
  };
}

export function payoutAudit(req: Request, action: string, p: Payout, details: string) {
  registerAuditLog({
    id: 'FAUD-' + randomUUID().slice(0, 12),
    actor: adminActor(req),
    role: 'super_admin',
    action,
    target: `Payout #${p.id}`,
    details,
    timestamp: new Date().toLocaleString()
  });
}

export async function handlePayoutRequest(req: Request, res: Response) {
  try {
    const freelancerId = resolvePayoutUserId(req);
    if (!freelancerId) {
      return res.status(401).json({ error: 'Authentication required to request a payout.' });
    }
    const pool = postgresStore.getPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [freelancerId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User account not found.' });
    }
    const user = userRes.rows[0];
    await financialTransactionService.ensureWallet(freelancerId);

    const codeRequired = EMAIL_DELIVERY_ENABLED || !IS_PRODUCTION;
    if (codeRequired) {
      const verification = verifyAndConsumeWithdrawalCode(freelancerId, req.body?.code);
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }
    }

    const rawMethod = String(req.body?.method || 'Bank Transfer');
    const settingKey = ALLOWED_METHODS[rawMethod];
    if (!settingKey || !DEFAULT_SITE_SETTINGS.wallets.allowedPayoutMethods[settingKey]) {
      return res.status(400).json({ error: `Unsupported payout method "${rawMethod}".` });
    }

    const numAmount = Number(req.body?.amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid withdrawal amount greater than $0.00' });
    }

    const minWithdrawal = DEFAULT_SITE_SETTINGS.wallets?.minimumWithdrawalAmount ?? 10;
    if (numAmount < minWithdrawal) {
      return res.status(400).json({ error: `Minimum withdrawal amount is $${minWithdrawal.toFixed(2)}.` });
    }

    const id = String(req.body?.idempotencyKey || req.headers['x-idempotency-key'] || req.body?.payoutId || ('pay_' + randomUUID().slice(0, 8)));
    const idempotencyKey = String(req.headers['x-idempotency-key'] || req.body?.idempotencyKey || req.body?.idempotency_key || `IDEMP-PAYREQ-${freelancerId}-${numAmount}-${rawMethod}`);
    const accountDetails = String(req.body?.accountDetails || 'Primary Bank Account').slice(0, 500);

    const payoutResult = await financialTransactionService.requestPayout({
      payoutId: id,
      freelancerId,
      amount: numAmount,
      method: rawMethod,
      accountDetails,
      actor: `user:${freelancerId}`,
      idempotencyKey
    });

    const finalPayoutId = payoutResult.payoutId || id;
    const finalAmount = payoutResult.amount || numAmount;

    // Retrieve or confirm the single authoritative payout record from PostgreSQL
    const existingPayoutRes = await pool.query('SELECT * FROM payouts WHERE id = $1', [finalPayoutId]);
    let record: Payout;
    if (existingPayoutRes.rows.length > 0) {
      record = formatPayoutRow(existingPayoutRes.rows[0]);
    } else {
      record = {
        id: finalPayoutId,
        freelancerId,
        amount: finalAmount,
        method: rawMethod as Payout['method'],
        status: 'pending',
        createdAt: new Date().toISOString().substring(0, 10),
        accountDetails: payoutResult.accountDetails || accountDetails
      };
      await pool.query(
        `INSERT INTO payouts (id, freelancer_id, amount, method, status, created_at, account_details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           freelancer_id = EXCLUDED.freelancer_id,
           amount = EXCLUDED.amount,
           method = EXCLUDED.method,
           status = EXCLUDED.status,
           created_at = EXCLUDED.created_at,
           account_details = EXCLUDED.account_details`,
        [record.id, record.freelancerId, record.amount, record.method, record.status, record.createdAt, record.accountDetails]
      );
    }

    syncUserBalances();

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: user.name,
      role: user.role,
      action: 'PAYOUT_REQUESTED',
      target: `Payout #${record.id}`,
      details: `User requested withdrawal of $${numAmount.toFixed(2)} via ${record.method}`,
      timestamp: new Date().toLocaleString()
    });

    const newBalance = (await financialRepository.getWalletBalance(freelancerId)) ?? Number(user.wallet_balance || 0);
    const txs = await financialRepository.getTransactions(freelancerId);
    const transaction = txs.find(t => (t as any).relatedPayoutId === id);

    res.status(201).json({
      success: true,
      newBalance,
      payout: record,
      transaction,
      ...record
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

export const approvePayout = async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = formatPayoutRow(result.rows[0]);
    if (p.status !== 'pending') return res.status(400).json({ error: `Cannot approve payout in status "${p.status}"` });

    p.status = 'approved';
    const updateRes = await pool.query('UPDATE payouts SET status = $1 WHERE id = $2 AND status = $3 RETURNING *', [p.status, p.id, 'pending']);
    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Payout status was modified by another concurrent operation.' });
    }
    payoutAudit(req, 'PAYOUT_APPROVED', p, `Approved payout of $${p.amount} via ${p.method} for freelancer ${p.freelancerId}`);
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const processPayout = async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = formatPayoutRow(result.rows[0]);
    if (p.status !== 'pending' && p.status !== 'approved') {
      return res.status(400).json({ error: `Cannot process payout in status "${p.status}"` });
    }
    if (p.amount >= 500 && p.status !== 'approved') {
      return res.status(400).json({ error: 'Payouts of $500.00 or more require explicit administrative approval before processing.' });
    }
    const { journal } = await financialTransactionService.settlePayout({
      payoutId: p.id,
      actor: adminActor(req),
      providerReference: req.body?.providerReference
    });
    p.status = 'processed';
    payoutAudit(req, 'PAYOUT_PROCESSED', p, `Processed payout of $${p.amount} via ${p.method}`);
    syncUserBalances();
    res.json({ success: true, payout: p, journal, ...p });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const rejectPayout = async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = formatPayoutRow(result.rows[0]);
    if (p.status !== 'pending' && p.status !== 'approved') {
      return res.status(400).json({ error: `Cannot reject payout in status "${p.status}"` });
    }
    await financialTransactionService.cancelPayout({
      payoutId: p.id,
      reason: String(req.body?.reason || 'Administrative rejection'),
      actor: adminActor(req)
    });
    const oldStatus = p.status;
    p.status = 'cancelled';
    const updateRes = await pool.query('UPDATE payouts SET status = $1 WHERE id = $2 AND status = $3 RETURNING *', [p.status, p.id, oldStatus]);
    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Payout status was modified by another concurrent operation.' });
    }
    payoutAudit(req, 'PAYOUT_REJECTED', p, `Rejected payout of $${p.amount}; funds returned to wallet`);
    syncUserBalances();
    res.json({ success: true, payout: p, ...p });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const failPayout = async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = formatPayoutRow(result.rows[0]);
    if (p.status !== 'pending' && p.status !== 'approved') {
      return res.status(400).json({ error: `Cannot fail payout in status "${p.status}"` });
    }
    await financialTransactionService.failPayout({
      payoutId: p.id,
      reason: String(req.body?.reason || 'Gateway reported a transfer failure'),
      actor: adminActor(req)
    });
    const oldStatus = p.status;
    p.status = 'failed';
    const updateRes = await pool.query('UPDATE payouts SET status = $1 WHERE id = $2 AND status = $3 RETURNING *', [p.status, p.id, oldStatus]);
    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Payout status was modified by another concurrent operation.' });
    }
    payoutAudit(req, 'PAYOUT_FAILED', p, `Payout of $${p.amount} failed; funds returned to wallet`);
    syncUserBalances();
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const retryPayout = async (req: Request, res: Response) => {
  try {
    const pool = postgresStore.getPool();
    const result = await pool.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = formatPayoutRow(result.rows[0]);
    if (p.status !== 'failed') return res.status(400).json({ error: 'Only failed payouts can be retried.' });
    await financialTransactionService.retryPayout({ payoutId: p.id, actor: adminActor(req) });
    p.status = 'pending';
    await pool.query('UPDATE payouts SET status = $1 WHERE id = $2', [p.status, p.id]);
    payoutAudit(req, 'PAYOUT_RETRIED', p, `Re-queued failed payout of $${p.amount}`);
    syncUserBalances();
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
