import { postgresStore } from '../db/postgresStore.js';
import { diagnosticService } from './diagnosticService.js';
import { calculateOrderFees, DEFAULT_FEE_CONFIG, type FeeConfig, toCents, fromCents } from '../../src/shared/fees.js';
import { randomUUID } from 'crypto';
import type { UserWallet, EscrowRecord, FinancialTransaction } from '../../src/server/financeLedger.js';

export interface FinancialOverview {
  totalWallets: number;
  totalAvailable: number;
  totalFundsOnHold: number;
  totalPendingWithdrawals: number;
  totalEscrowsHeld: number;
  countEscrowsHeld: number;
  totalPlatformRevenue: number;
  totalServiceFees: number;
  totalSmallOrderFees: number;
  totalEarningsClearing: number;
  totalTransactions: number;
  totalJournals: number;
}

export function assertValidFinancialAmount(amount: any, fieldName = 'Amount', allowZero = true): number {
  if (typeof amount !== 'number' || Number.isNaN(amount) || !Number.isFinite(amount)) {
    throw new Error(`Invalid financial amount for ${fieldName}: must be a finite number.`);
  }
  if (amount < 0) {
    throw new Error(`Invalid financial amount for ${fieldName}: cannot be negative.`);
  }
  if (!allowZero && amount === 0) {
    throw new Error(`Invalid financial amount for ${fieldName}: must be greater than zero.`);
  }
  return amount;
}

export class FinancialRepository {
  public setEscrowCache(orderId: string, escrow: EscrowRecord | null) {}
  public setWalletCache(userId: string, wallet: UserWallet) {}

  public formatEscrowRow(r: any): EscrowRecord {
    return {
      orderId: r.order_id,
      orderTitle: r.order_title,
      buyerId: r.buyer_id,
      sellerId: r.seller_id,
      amount: Number(r.amount),
      remaining: Number(r.remaining),
      refundedTotal: Number(r.refunded_total || 0),
      releasedGross: Number(r.released_gross || 0),
      refundSeq: Number(r.refund_seq || 0),
      releaseSeq: Number(r.release_seq || 0),
      status: r.status,
      fundedAt: r.funded_at ? new Date(r.funded_at).toISOString() : new Date().toISOString(),
      commissionPercent: Number(r.commission_percent || 20),
      serviceFee: Number(r.service_fee || 0),
      smallOrderFee: Number(r.small_order_fee || 0),
      feesRefunded: Boolean(r.fees_refunded)
    };
  }

  public formatWalletRow(r: any): UserWallet {
    return {
      id: r.user_id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      userRole: r.user_role || 'buyer',
      currency: 'USD',
      availableBalance: Number(r.available_balance || 0),
      fundsOnHold: Number(r.funds_on_hold || 0),
      pendingWithdrawals: Number(r.pending_withdrawals || 0),
      pendingIncoming: 0,
      status: r.status || 'active',
      restrictionReason: r.restriction_reason || undefined,
      lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : new Date().toISOString(),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
    };
  }

  async hydrateFromPostgres() {
    // No-op: Direct live database queries used exclusively.
  }

  async getWallet(userId: string): Promise<UserWallet | null> {
    const res = await postgresStore.getPool().query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return null;
    return this.formatWalletRow(res.rows[0]);
  }

  async getWalletById(userId: string): Promise<{ wallet: UserWallet; movements: any[] } | null> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return null;
    let movements: any[] = [];
    try {
      const res = await postgresStore.getPool().query('SELECT * FROM wallet_movements WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      movements = res.rows;
    } catch {}
    return { wallet, movements };
  }

  async getWalletBalance(userId: string): Promise<number> {
    const res = await postgresStore.getPool().query('SELECT available_balance FROM wallets WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return 0;
    return Number(res.rows[0].available_balance);
  }

  getWalletBalanceSync(userId: string): number {
    return 0;
  }

  async getWallets(): Promise<UserWallet[]> {
    const res = await postgresStore.getPool().query('SELECT * FROM wallets ORDER BY user_id ASC');
    return res.rows.map(r => this.formatWalletRow(r));
  }

  async getEscrow(orderId: string): Promise<EscrowRecord | null> {
    const res = await postgresStore.getPool().query('SELECT * FROM escrows WHERE order_id = $1', [orderId]);
    if (res.rows.length === 0) return null;
    return this.formatEscrowRow(res.rows[0]);
  }

  getEscrowSync(orderId: string): EscrowRecord | null {
    return null;
  }

  async getEscrows(): Promise<EscrowRecord[]> {
    const res = await postgresStore.getPool().query('SELECT * FROM escrows ORDER BY funded_at DESC');
    return res.rows.map(r => this.formatEscrowRow(r));
  }

  hasEscrowSync(orderId: string): boolean {
    return false;
  }

  async getBuyerHeldEscrowTotal(buyerId: string): Promise<number> {
    const res = await postgresStore.getPool().query(
      "SELECT COALESCE(SUM(remaining), 0) AS total FROM escrows WHERE buyer_id = $1 AND status = 'held'",
      [buyerId]
    );
    return Number(res.rows[0]?.total || 0);
  }

  async getFreelancerHeldEscrowTotal(sellerId: string): Promise<number> {
    const res = await postgresStore.getPool().query(
      "SELECT COALESCE(SUM(remaining), 0) AS total FROM escrows WHERE seller_id = $1 AND status = 'held'",
      [sellerId]
    );
    return Number(res.rows[0]?.total || 0);
  }

  async getTransactions(userId?: string): Promise<FinancialTransaction[]> {
    const params: any[] = [];
    let sql = `
      SELECT wm.*, w.user_name, w.user_role
      FROM wallet_movements wm
      LEFT JOIN wallets w ON w.user_id = wm.user_id
    `;
    if (userId) {
      sql += ' WHERE wm.user_id = $1';
      params.push(userId);
    }
    sql += ' ORDER BY wm.created_at DESC LIMIT 500';

    const res = await postgresStore.getPool().query(sql, params);
    return res.rows.map(r => ({
      id: r.id,
      type: r.type,
      amount: Math.abs(Number(r.amount)),
      currency: 'USD',
      timestamp: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : new Date().toISOString(),
      status: 'completed',
      userId: r.user_id,
      userName: r.user_name || 'User',
      userRole: r.user_role || 'buyer',
      description: r.description || ''
    }));
  }

  async getTransactionById(id: string): Promise<any | null> {
    const res = await postgresStore.getPool().query(
      `SELECT wm.*, w.user_name, w.user_role FROM wallet_movements wm LEFT JOIN wallets w ON w.user_id = wm.user_id WHERE wm.id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      type: r.type,
      amount: Math.abs(Number(r.amount)),
      currency: 'USD',
      timestamp: r.created_at,
      status: 'completed',
      userId: r.user_id,
      userName: r.user_name,
      userRole: r.user_role,
      description: r.description
    };
  }

  async getJournals(): Promise<any[]> {
    const jRes = await postgresStore.getPool().query('SELECT * FROM ledger_journals ORDER BY created_at DESC LIMIT 200');
    if (jRes.rows.length === 0) return [];
    const jIds = jRes.rows.map(r => r.id);
    const eRes = await postgresStore.getPool().query('SELECT * FROM ledger_entries WHERE journal_id = ANY($1)', [jIds]);
    const entriesByJ = new Map<string, any[]>();
    for (const e of eRes.rows) {
      const list = entriesByJ.get(e.journal_id) || [];
      list.push({
        id: e.id,
        journalId: e.journal_id,
        accountCode: e.account_code,
        accountName: e.description || '',
        debit: Number(e.debit),
        credit: Number(e.credit),
        currency: e.currency || 'USD',
        description: e.description,
        userId: e.user_id,
        orderId: e.order_id
      });
      entriesByJ.set(e.journal_id, list);
    }
    return jRes.rows.map(j => {
      const ents = entriesByJ.get(j.id) || [];
      const totalDebit = ents.reduce((sum, e) => sum + e.debit, 0);
      const totalCredit = ents.reduce((sum, e) => sum + e.credit, 0);
      return {
        id: j.id,
        reference: j.reference,
        postingDate: j.created_at ? new Date(j.created_at).toISOString().split('T')[0] : '',
        timestamp: j.created_at ? new Date(j.created_at).toISOString() : '',
        description: j.description || '',
        eventType: j.event_type,
        idempotencyKey: j.idempotency_key || '',
        entries: ents,
        totalDebit,
        totalCredit,
        status: 'posted',
        actor: j.actor || 'system'
      };
    });
  }

  async getJournalById(id: string): Promise<any | null> {
    const jRes = await postgresStore.getPool().query('SELECT * FROM ledger_journals WHERE id = $1', [id]);
    if (jRes.rows.length === 0) return null;
    const j = jRes.rows[0];
    const eRes = await postgresStore.getPool().query('SELECT * FROM ledger_entries WHERE journal_id = $1', [id]);
    const ents = eRes.rows.map(e => ({
      id: e.id,
      journalId: e.journal_id,
      accountCode: e.account_code,
      accountName: e.description || '',
      debit: Number(e.debit),
      credit: Number(e.credit),
      currency: e.currency || 'USD',
      description: e.description,
      userId: e.user_id,
      orderId: e.order_id
    }));
    return {
      id: j.id,
      reference: j.reference,
      postingDate: j.created_at ? new Date(j.created_at).toISOString().split('T')[0] : '',
      timestamp: j.created_at ? new Date(j.created_at).toISOString() : '',
      description: j.description || '',
      eventType: j.event_type,
      idempotencyKey: j.idempotency_key || '',
      entries: ents,
      totalDebit: ents.reduce((sum, e) => sum + e.debit, 0),
      totalCredit: ents.reduce((sum, e) => sum + e.credit, 0),
      status: 'posted',
      actor: j.actor || 'system'
    };
  }

  async getFinancialOverview(): Promise<FinancialOverview> {
    const pool = postgresStore.getPool();
    const [walletsRes, escrowsRes, commRes, servRes, smRes, clrRes, movRes, jnlRes] = await Promise.all([
      pool.query('SELECT COUNT(*) as count, COALESCE(SUM(available_balance), 0) AS total_available, COALESCE(SUM(funds_on_hold), 0) AS total_on_hold, COALESCE(SUM(pending_withdrawals), 0) AS total_pending FROM wallets'),
      pool.query("SELECT COUNT(*) as count, COALESCE(SUM(remaining), 0) AS total_held FROM escrows WHERE status = 'held'"),
      pool.query("SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total FROM ledger_entries WHERE account_code = '4010'"),
      pool.query("SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total FROM ledger_entries WHERE account_code = '4020'"),
      pool.query("SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total FROM ledger_entries WHERE account_code = '4030'"),
      pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM earnings_clearing WHERE status = 'clearing'"),
      pool.query('SELECT COUNT(*) as count FROM wallet_movements'),
      pool.query('SELECT COUNT(*) as count FROM ledger_journals')
    ]);

    return {
      totalWallets: Number(walletsRes.rows[0]?.count || 0),
      totalAvailable: Number(walletsRes.rows[0]?.total_available || 0),
      totalFundsOnHold: Number(walletsRes.rows[0]?.total_on_hold || 0),
      totalPendingWithdrawals: Number(walletsRes.rows[0]?.total_pending || 0),
      totalEscrowsHeld: Number(escrowsRes.rows[0]?.total_held || 0),
      countEscrowsHeld: Number(escrowsRes.rows[0]?.count || 0),
      totalPlatformRevenue: Number(commRes.rows[0]?.total || 0),
      totalServiceFees: Number(servRes.rows[0]?.total || 0),
      totalSmallOrderFees: Number(smRes.rows[0]?.total || 0),
      totalEarningsClearing: Number(clrRes.rows[0]?.total || 0),
      totalTransactions: Number(movRes.rows[0]?.count || 0),
      totalJournals: Number(jnlRes.rows[0]?.count || 0)
    };
  }

  async getReconciliationSummary(): Promise<any> {
    const pool = postgresStore.getPool();
    const trialRes = await pool.query(`
      SELECT account_code, COALESCE(SUM(debit), 0) AS debits, COALESCE(SUM(credit), 0) AS credits
      FROM ledger_entries
      GROUP BY account_code
    `);
    let totalDebits = 0;
    let totalCredits = 0;
    for (const r of trialRes.rows) {
      totalDebits += Number(r.debits);
      totalCredits += Number(r.credits);
    }
    totalDebits = Number(totalDebits.toFixed(2));
    totalCredits = Number(totalCredits.toFixed(2));
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

    if (!isBalanced) {
      diagnosticService.log(
        'critical',
        'FinancialRepository',
        'getReconciliationSummary',
        'server/services/financialService.ts',
        'reconciliation_check',
        'FAILED',
        { variance: Number(Math.abs(totalDebits - totalCredits).toFixed(2)) },
        'Financial reconciliation mismatch detected.'
      );
    }

    return {
      trialBalance: {
        totalDebits,
        totalCredits,
        isBalanced,
        variance: Number(Math.abs(totalDebits - totalCredits).toFixed(2))
      },
      auditDate: new Date().toISOString(),
      accountBalances: trialRes.rows.map(r => ({
        accountCode: r.account_code,
        debit: Number(r.debits),
        credit: Number(r.credits)
      }))
    };
  }

  async hasOutstandingFunds(userId: string): Promise<boolean> {
    const pool = postgresStore.getPool();
    const [wRes, eRes] = await Promise.all([
      pool.query('SELECT available_balance, funds_on_hold, pending_withdrawals FROM wallets WHERE user_id = $1', [userId]),
      pool.query("SELECT COUNT(*) as count FROM escrows WHERE (buyer_id = $1 OR seller_id = $1) AND status = 'held' AND remaining > 0", [userId])
    ]);
    if (wRes.rows.length > 0) {
      const w = wRes.rows[0];
      if (Number(w.available_balance) > 0 || Number(w.funds_on_hold) > 0 || Number(w.pending_withdrawals) > 0) {
        return true;
      }
    }
    if (Number(eRes.rows[0]?.count || 0) > 0) {
      return true;
    }
    return false;
  }

  async previewAdjustment(params: { userId: string; amount: number; direction: 'credit_user' | 'debit_user'; category: string; reason: string }): Promise<any> {
    assertValidFinancialAmount(params.amount, 'Adjustment amount', true);
    const curBal = await this.getWalletBalance(params.userId);
    const delta = params.direction === 'credit_user' ? params.amount : -params.amount;
    const projectedBalance = Number((curBal + delta).toFixed(2));
    return {
      userId: params.userId,
      currentBalance: curBal,
      adjustmentAmount: params.amount,
      direction: params.direction,
      projectedBalance,
      allowed: projectedBalance >= 0,
      requiresOverride: projectedBalance < 0
    };
  }

  async generateCsvExport(type: string, query: any): Promise<{ filename: string; content: string }> {
    const pool = postgresStore.getPool();
    const now = new Date().toISOString().split('T')[0];
    if (type === 'wallets') {
      const res = await pool.query('SELECT * FROM wallets ORDER BY user_id');
      const headers = ['User ID', 'Name', 'Email', 'Role', 'Available Balance', 'Funds On Hold', 'Pending Withdrawals', 'Status'];
      const rows = res.rows.map(r => [r.user_id, `"${r.user_name}"`, r.user_email, r.user_role, r.available_balance, r.funds_on_hold, r.pending_withdrawals, r.status]);
      return { filename: `wallets_${now}.csv`, content: [headers.join(','), ...rows.map(r => r.join(','))].join('\n') };
    }
    if (type === 'escrows') {
      const res = await pool.query('SELECT * FROM escrows ORDER BY funded_at DESC');
      const headers = ['Order ID', 'Order Title', 'Buyer ID', 'Seller ID', 'Amount', 'Remaining', 'Status', 'Funded At'];
      const rows = res.rows.map(r => [r.order_id, `"${r.order_title}"`, r.buyer_id, r.seller_id, r.amount, r.remaining, r.status, r.funded_at]);
      return { filename: `escrows_${now}.csv`, content: [headers.join(','), ...rows.map(r => r.join(','))].join('\n') };
    }
    const res = await pool.query('SELECT * FROM wallet_movements ORDER BY created_at DESC LIMIT 1000');
    const headers = ['Movement ID', 'User ID', 'Amount', 'Type', 'Description', 'Created At'];
    const rows = res.rows.map(r => [r.id, r.user_id, r.amount, r.type, `"${r.description || ''}"`, r.created_at]);
    return { filename: `transactions_${now}.csv`, content: [headers.join(','), ...rows.map(r => r.join(','))].join('\n') };
  }
}

export const financialRepository = new FinancialRepository();

export class FinancialTransactionService {
  private async ensureFinancialTables(client: any) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        user_id VARCHAR(64) PRIMARY KEY,
        user_name VARCHAR(255) NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        user_role VARCHAR(64) NOT NULL,
        available_balance NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        funds_on_hold NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        pending_withdrawals NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        status VARCHAR(32) DEFAULT 'active' NOT NULL,
        restriction_reason TEXT,
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallet_movements (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        type VARCHAR(32) NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ledger_journals (
        id VARCHAR(64) PRIMARY KEY,
        reference VARCHAR(128) NOT NULL,
        description TEXT,
        event_type VARCHAR(64) NOT NULL,
        idempotency_key VARCHAR(255) UNIQUE,
        actor VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id VARCHAR(64) PRIMARY KEY,
        journal_id VARCHAR(64) NOT NULL,
        account_code VARCHAR(32) NOT NULL,
        debit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        credit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD' NOT NULL,
        description TEXT,
        user_id VARCHAR(64),
        order_id VARCHAR(64),
        payout_id VARCHAR(64)
      );

      CREATE TABLE IF NOT EXISTS escrows (
        order_id VARCHAR(64) PRIMARY KEY,
        order_title TEXT NOT NULL,
        buyer_id VARCHAR(64) NOT NULL,
        seller_id VARCHAR(64) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        remaining NUMERIC(14,2) NOT NULL,
        refunded_total NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        released_gross NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        refund_seq INT DEFAULT 0 NOT NULL,
        release_seq INT DEFAULT 0 NOT NULL,
        status VARCHAR(32) DEFAULT 'held' NOT NULL,
        funded_at TIMESTAMPTZ DEFAULT NOW(),
        commission_percent NUMERIC(5,2) DEFAULT 20.00 NOT NULL,
        service_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        small_order_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
        fees_refunded BOOLEAN DEFAULT FALSE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS earnings_clearing (
        id VARCHAR(64) PRIMARY KEY,
        order_id VARCHAR(64) NOT NULL,
        seller_id VARCHAR(64) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        clearance_start TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        clearance_end TIMESTAMPTZ NOT NULL,
        status VARCHAR(32) DEFAULT 'clearing' NOT NULL,
        payout_eligible BOOLEAN DEFAULT FALSE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS financial_idempotency (
        key TEXT PRIMARY KEY,
        operation TEXT,
        request_params JSONB,
        status TEXT,
        result JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE financial_idempotency ADD COLUMN IF NOT EXISTS request_params JSONB;

      CREATE TABLE IF NOT EXISTS payouts (
        id VARCHAR(64) PRIMARY KEY,
        freelancer_id VARCHAR(64) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        method VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        account_details TEXT
      );
    `);
  }

  public async checkIdempotency(client: any, key: string, operation: string, params: any): Promise<any | null> {
    const existing = await client.query('SELECT operation, request_params, result FROM financial_idempotency WHERE key = $1', [key]);
    if (existing.rows.length === 0) return null;
    const row = existing.rows[0];
    if (row.operation && row.operation !== operation) {
      throw new Error(`Idempotency conflict: key "${key}" was previously used for a different operation ("${row.operation}" vs "${operation}").`);
    }
    if (row.request_params) {
      const stored = typeof row.request_params === 'string' ? JSON.parse(row.request_params) : row.request_params;
      for (const [k, v] of Object.entries(params)) {
        if (['actor', 'reference', 'reason', 'evidenceReference', 'orderTitle', 'gigTitle', 'source'].includes(k)) continue;
        if (stored[k] !== undefined && v !== undefined) {
          const storedVal = typeof stored[k] === 'number' ? Number(Number(stored[k]).toFixed(2)) : String(stored[k]);
          const currentVal = typeof v === 'number' ? Number(Number(v).toFixed(2)) : String(v);
          if (storedVal !== currentVal) {
            throw new Error(`Idempotency conflict: key "${key}" was previously used with conflicting parameter "${k}" (${storedVal} vs ${currentVal}).`);
          }
        }
      }
    }
    const res = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    return { ...res, replayed: true };
  }

  public async recordIdempotency(client: any, key: string, operation: string, params: any, result: any): Promise<void> {
    const safeParams: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        safeParams[k] = v;
      }
    }
    // Fix 4: Financial idempotency records are immutable. Never overwrite an existing record.
    await client.query(
      `INSERT INTO financial_idempotency (key, operation, request_params, status, result, created_at, updated_at)
       VALUES ($1, $2, $3, 'completed', $4, NOW(), NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key, operation, JSON.stringify(safeParams), JSON.stringify(result)]
    );
  }

  private async assertJournalBalanced(client: any, entries: any[]) {
    const totalDebits = Number(entries.reduce((sum, e) => sum + Number(e.debit), 0).toFixed(2));
    const totalCredits = Number(entries.reduce((sum, e) => sum + Number(e.credit), 0).toFixed(2));
    if (Math.abs(totalDebits - totalCredits) > 0.001) {
      throw new Error(`Journal imbalance: Debits (${totalDebits}) !== Credits (${totalCredits})`);
    }
  }

  async ensureWallet(
    paramsOrUserId: { userId: string; name?: string; email?: string; role?: string; initialBalance?: number } | string,
    maybeNameOrClient?: any,
    maybeEmail?: string,
    maybeRole?: string
  ) {
    let params: { userId: string; name?: string; email?: string; role?: string; initialBalance?: number };
    let externalClient: any = undefined;

    if (typeof paramsOrUserId === 'string') {
      params = {
        userId: paramsOrUserId,
        name: typeof maybeNameOrClient === 'string' ? maybeNameOrClient : undefined,
        email: maybeEmail,
        role: maybeRole
      };
    } else {
      params = paramsOrUserId;
      externalClient = maybeNameOrClient;
    }

    const run = async (client: any) => {
      await this.ensureFinancialTables(client);

      const existing = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.userId]);
      if (existing.rows.length === 0) {
        const initBal = Number(params.initialBalance || 0);
        await client.query(
          `INSERT INTO wallets (user_id, user_name, user_email, user_role, available_balance, funds_on_hold, pending_withdrawals, status)
           VALUES ($1, $2, $3, $4, $5, 0.00, 0.00, 'active')
           ON CONFLICT (user_id) DO NOTHING`,
          [params.userId, params.name || `User ${params.userId}`, params.email || `${params.userId}@example.com`, params.role || 'buyer', initBal]
        );
        if (initBal > 0) {
          await client.query(
            `INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, 'opening_balance', 'Initial wallet balance')`,
            [randomUUID(), params.userId, initBal]
          );
        }
      } else {
        if (params.name || params.email || params.role) {
          await client.query(
            `UPDATE wallets SET
               user_name = COALESCE($1, user_name),
               user_email = COALESCE($2, user_email),
               user_role = CASE WHEN $3 = 'freelancer' THEN 'freelancer' ELSE user_role END
             WHERE user_id = $4`,
            [params.name || null, params.email || null, params.role || null, params.userId]
          );
        }
      }
      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [params.userId]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(params.userId, financialRepository.formatWalletRow(updated.rows[0]));
      }
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async fundEscrow(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      assertValidFinancialAmount(params.amount, 'Escrow funding amount', false);

      const idempKey = params.idempotencyKey || `IDEMP-ORD-FUND-${params.orderId}`;
      const cached = await this.checkIdempotency(client, idempKey, 'fundEscrow', {
        orderId: params.orderId,
        amount: params.amount,
        buyerId: params.buyerId,
        sellerId: params.sellerId
      });
      if (cached) return cached;

      // Lock/retrieve authoritative order and escrow state inside existing database transaction (FIX 5)
      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [params.orderId]);
      const escrowRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);

      const orderRow = orderRes.rows[0];
      const escrowRow = escrowRes.rows[0];

      const isEscrowAlreadyFunded = escrowRow && ['held', 'released', 'refunded', 'split', 'disputed'].includes(escrowRow.status);
      const isOrderAlreadyFunded = orderRow && ['funded_in_escrow', 'in_progress', 'delivered', 'completed', 'disputed', 'cancelled'].includes(orderRow.status);

      if (isEscrowAlreadyFunded || isOrderAlreadyFunded) {
        // Escrow has already been funded!
        // Do not debit the buyer again.
        // Do not create another independent escrow funding transaction.
        // Preserve legitimate idempotent retry behavior.
        const result = { success: true, alreadyFunded: true, replayed: true, orderId: params.orderId };
        await this.recordIdempotency(client, idempKey, 'fundEscrow', {
          orderId: params.orderId,
          amount: params.amount,
          buyerId: params.buyerId,
          sellerId: params.sellerId
        }, result);
        return result;
      }

      let feeConfig: FeeConfig = DEFAULT_FEE_CONFIG;
      try {
        const settingsRes = await client.query("SELECT value FROM site_settings WHERE key = 'primary'");
        if (settingsRes.rows.length > 0 && settingsRes.rows[0].value?.commission) {
          const comm = settingsRes.rows[0].value.commission;
          feeConfig = {
            commissionPercent: typeof comm.commissionPercent === 'number' ? comm.commissionPercent : DEFAULT_FEE_CONFIG.commissionPercent,
            buyerFeePercent: typeof comm.buyerFeePercent === 'number' ? comm.buyerFeePercent : (typeof comm.buyerProcessingFeePercent === 'number' ? comm.buyerProcessingFeePercent : DEFAULT_FEE_CONFIG.buyerFeePercent),
            smallOrderFee: typeof comm.smallOrderFee === 'number' ? comm.smallOrderFee : (typeof comm.smallOrderFeeAmount === 'number' ? comm.smallOrderFeeAmount : DEFAULT_FEE_CONFIG.smallOrderFee),
            smallOrderThreshold: typeof comm.smallOrderThreshold === 'number' ? comm.smallOrderThreshold : (typeof comm.smallOrderFeeThreshold === 'number' ? comm.smallOrderFeeThreshold : DEFAULT_FEE_CONFIG.smallOrderThreshold)
          };
        }
      } catch {}

      const fees = calculateOrderFees(params.amount, feeConfig);
      const gigPrice = fees.gigPrice;
      const serviceFee = fees.serviceFee;
      const smallOrderFee = fees.smallOrderFee;
      const clientTotal = fees.clientTotal;

      await this.ensureWallet({ userId: params.buyerId, role: 'buyer' }, client);
      await this.ensureWallet({ userId: params.sellerId, role: 'freelancer' }, client);

      const buyerRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.buyerId]);
      if (buyerRes.rows.length === 0) throw new Error('Buyer wallet not found');
      const buyer = buyerRes.rows[0];

      if (Number(buyer.available_balance) < clientTotal) throw new Error('Insufficient funds');

      await client.query('UPDATE wallets SET available_balance = available_balance - $1, funds_on_hold = funds_on_hold + $2 WHERE user_id = $3', [clientTotal, gigPrice, params.buyerId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.buyerId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), params.buyerId, -clientTotal, 'escrow_funding', `Funded order #${params.orderId}`]);
      
      await client.query(
        `INSERT INTO escrows (order_id, order_title, buyer_id, seller_id, amount, remaining, status, service_fee, small_order_fee, commission_percent)
         VALUES ($1, $2, $3, $4, $5, $5, 'held', $6, $7, $8)
         ON CONFLICT (order_id) DO UPDATE SET
           order_title = EXCLUDED.order_title,
           amount = EXCLUDED.amount,
           remaining = EXCLUDED.remaining,
           status = 'held',
           service_fee = EXCLUDED.service_fee,
           small_order_fee = EXCLUDED.small_order_fee,
           commission_percent = EXCLUDED.commission_percent`,
        [params.orderId, params.orderTitle, params.buyerId, params.sellerId, gigPrice, serviceFee, smallOrderFee, feeConfig.commissionPercent]
      );
      
      await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['funded_in_escrow', params.orderId]);

      const jId = randomUUID();
      await client.query('INSERT INTO ledger_journals (id, reference, description, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)', [jId, `ORD-${params.orderId}-FUND`, `Escrow funding for Order #${params.orderId}`, 'ORDER_ESCROW_FUNDED', params.actor, idempKey]);
      const entries = [
        { account_code: '1010', debit: clientTotal, credit: 0, description: 'Debited buyer wallet', user_id: params.buyerId },
        { account_code: '2030', debit: 0, credit: gigPrice, description: 'Escrow hold', order_id: params.orderId }
      ];
      if (serviceFee > 0) {
        entries.push({ account_code: '4020', debit: 0, credit: serviceFee, description: 'Platform service fee', order_id: params.orderId });
      }
      if (smallOrderFee > 0) {
        entries.push({ account_code: '4030', debit: 0, credit: smallOrderFee, description: 'Small-order fee', order_id: params.orderId });
      }
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), jId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true };
      await this.recordIdempotency(client, idempKey, 'fundEscrow', {
        orderId: params.orderId,
        amount: params.amount,
        buyerId: params.buyerId,
        sellerId: params.sellerId
      }, result);
      
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async releaseOrderFunds(params: { orderId: string; actor: string; reason?: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      const idempotencyKey = params.idempotencyKey || `IDEMP-REL-${params.orderId}`;
      const cached = await this.checkIdempotency(client, idempotencyKey, 'releaseOrderFunds', {
        orderId: params.orderId
      });
      if (cached) {
        diagnosticService.log('info', 'financialService', 'releaseOrderFunds', 'postgres', 'release_escrow', 'SUCCESS', { orderId: params.orderId, idempotencyKey, replayed: true });
        return cached;
      }

      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [params.orderId]);
      if (orderRes.rows.length === 0) {
        diagnosticService.log('warning', 'financialService', 'releaseOrderFunds', 'postgres', 'release_escrow', 'FAILED', { orderId: params.orderId }, 'Data integrity error: Order not found in database');
        throw new Error(`Data integrity error: Order #${params.orderId} not found in PostgreSQL database.`);
      }
      const order = orderRes.rows[0];

      if (order.status === 'completed') {
        throw new Error('Order is already completed.');
      }
      if (order.status === 'cancelled') {
        throw new Error('Order is already cancelled.');
      }

      const escrowRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escrowRes.rows.length === 0) {
        diagnosticService.log('warning', 'financialService', 'releaseOrderFunds', 'postgres', 'release_escrow', 'FAILED', { orderId: params.orderId }, 'Data integrity error: No escrow found for order in database');
        throw new Error(`Data integrity error: Escrow for order #${params.orderId} not found in PostgreSQL database.`);
      }
      const escrow = escrowRes.rows[0];

      if (escrow.status !== 'held' || Number(escrow.remaining) <= 0) {
        throw new Error(`Escrow for order ${params.orderId} is already ${escrow.status}; nothing left to release.`);
      }

      await this.ensureWallet({ userId: order.buyer_id, role: 'buyer' }, client);
      await this.ensureWallet({ userId: order.seller_id, role: 'freelancer' }, client);

      const gross = Number(escrow.remaining);
      const commissionRate = Number(escrow.commission_percent || 20.0);
      const platformFee = Number((gross * (commissionRate / 100)).toFixed(2));
      const freelancerNet = fromCents(toCents(gross) - toCents(platformFee));

      await client.query(
        'UPDATE escrows SET remaining = 0, released_gross = released_gross + $1, status = CASE WHEN refunded_total > 0 THEN \'split\' ELSE \'released\' END WHERE order_id = $2',
        [gross, params.orderId]
      );

      await client.query('UPDATE wallets SET funds_on_hold = funds_on_hold - $1 WHERE user_id = $2', [gross, order.buyer_id]);
      await client.query('UPDATE orders SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', params.orderId]);

      const clearingId = 'clr_' + randomUUID().slice(0, 12);
      const clearanceEnd = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      await client.query(
        `INSERT INTO earnings_clearing (id, order_id, seller_id, amount, clearance_end, status, payout_eligible)
         VALUES ($1, $2, $3, $4, $5, 'clearing', FALSE)`,
        [clearingId, params.orderId, order.seller_id, freelancerNet, clearanceEnd]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `ORD-${params.orderId}-RELEASE`, `Escrow release for Order #${params.orderId}`, 'ESCROW_RELEASED_TO_FREELANCER', idempotencyKey, params.actor]
      );

      const entries = [
        { account_code: '2030', debit: gross, credit: 0, description: 'Release from escrow', order_id: params.orderId },
        { account_code: '2040', debit: 0, credit: freelancerNet, description: 'Seller pending earnings', user_id: order.seller_id, order_id: params.orderId },
        { account_code: '4010', debit: 0, credit: platformFee, description: 'Platform commission', order_id: params.orderId }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true, freelancerNet, platformFee };
      await this.recordIdempotency(client, idempotencyKey, 'releaseOrderFunds', {
        orderId: params.orderId
      }, result);
      
      const escRow = await client.query('SELECT * FROM escrows WHERE order_id = $1', [params.orderId]);
      if (escRow.rows.length > 0) {
        financialRepository.setEscrowCache(params.orderId, financialRepository.formatEscrowRow(escRow.rows[0]));
      }
      diagnosticService.log('INFO', 'FinancialTransactionService', 'releaseOrderFunds', 'postgres', 'release_escrow', 'SUCCESS', { orderId: params.orderId });
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async refundOrderFunds(params: { orderId: string; amount?: number; reason: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      // Validate refund amount if explicitly provided (FIX 1 & FIX 7)
      if (params.amount !== undefined) {
        assertValidFinancialAmount(params.amount, 'Refund amount', true);
      }

      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [params.orderId]);
      if (orderRes.rows.length === 0) {
        diagnosticService.log('warning', 'financialService', 'refundOrderFunds', 'postgres', 'refund_escrow', 'FAILED', { orderId: params.orderId }, 'Order not found');
        throw new Error(`Data integrity error: Order #${params.orderId} not found in PostgreSQL database.`);
      }
      const order = orderRes.rows[0];

      const escrowRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escrowRes.rows.length === 0) {
        diagnosticService.log('warning', 'financialService', 'refundOrderFunds', 'postgres', 'refund_escrow', 'FAILED', { orderId: params.orderId }, 'No escrow found for order');
        throw new Error(`Data integrity error: Escrow for order #${params.orderId} not found in PostgreSQL database.`);
      }
      const escrow = escrowRes.rows[0];

      const refundAmount = params.amount === undefined ? Number(escrow.remaining) : Number(params.amount);
      assertValidFinancialAmount(refundAmount, 'Refund amount', true);

      // FIX 8 & FIX 9: Idempotency with parameter validation and safe retry
      const nextSeq = Number(escrow.refund_seq || 0) + 1;
      const idempotencyKey = params.idempotencyKey || `IDEMP-REF-${params.orderId}-${nextSeq}`;
      const cached = await this.checkIdempotency(client, idempotencyKey, 'refundOrderFunds', {
        orderId: params.orderId,
        amount: refundAmount
      });
      if (cached) {
        diagnosticService.log('info', 'financialService', 'refundOrderFunds', 'postgres', 'refund_escrow', 'SUCCESS', { orderId: params.orderId, idempotencyKey, replayed: true });
        return cached;
      }

      if (Number(escrow.remaining) <= 0 || escrow.status === 'refunded') {
        const existingJnl = await client.query(
          'SELECT * FROM ledger_journals WHERE idempotency_key = $1 OR reference = $2',
          [idempotencyKey, `ORD-${params.orderId}-REFUND-${Number(escrow.refund_seq || 0)}`]
        );
        if (existingJnl.rows.length > 0) {
          const replayRes = { success: true, refunded: Number(escrow.refunded_total), remaining: 0, replayed: true };
          await this.recordIdempotency(client, idempotencyKey, 'refundOrderFunds', { orderId: params.orderId, amount: refundAmount }, replayRes);
          return replayRes;
        }
        throw new Error(`Escrow for order ${params.orderId} is already ${escrow.status}; nothing left to refund.`);
      }

      if (refundAmount > Number(escrow.remaining)) {
        throw new Error(`Refund amount ($${refundAmount.toFixed(2)}) exceeds escrow held ($${Number(escrow.remaining).toFixed(2)}).`);
      }

      await this.ensureWallet({ userId: order.buyer_id, role: 'buyer' }, client);

      const completesFullRefund = (toCents(Number(escrow.refunded_total)) + toCents(refundAmount)) === toCents(Number(escrow.amount)) && Number(escrow.released_gross) === 0;
      const feesBack = completesFullRefund && !escrow.fees_refunded ? fromCents(toCents(Number(escrow.service_fee)) + toCents(Number(escrow.small_order_fee))) : 0;
      const totalRefundToBuyer = fromCents(toCents(refundAmount) + toCents(feesBack));

      const newRemaining = fromCents(toCents(Number(escrow.remaining)) - toCents(refundAmount));
      const newRefundedTotal = fromCents(toCents(Number(escrow.refunded_total)) + toCents(refundAmount));
      const newStatus = newRemaining === 0 ? 'refunded' : escrow.status;

      await client.query(
        `UPDATE escrows SET remaining = $1, refunded_total = $2, refund_seq = $3, status = $4, fees_refunded = CASE WHEN $5 THEN TRUE ELSE fees_refunded END WHERE order_id = $6`,
        [newRemaining, newRefundedTotal, nextSeq, newStatus, completesFullRefund, params.orderId]
      );

      await client.query('UPDATE wallets SET funds_on_hold = funds_on_hold - $1, available_balance = available_balance + $2 WHERE user_id = $3', [refundAmount, totalRefundToBuyer, order.buyer_id]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [order.buyer_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), order.buyer_id, totalRefundToBuyer, 'escrow_refund', `Refund for order #${params.orderId}: ${params.reason}`]
      );

      if (newRemaining === 0) {
        await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', params.orderId]);
      }

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `ORD-${params.orderId}-REFUND-${nextSeq}`, `Escrow refund to Buyer for Order #${params.orderId}: ${params.reason}`, 'ESCROW_REFUNDED_TO_BUYER', idempotencyKey, params.actor]
      );

      const entries = [
        { account_code: '2030', debit: refundAmount, credit: 0, description: 'Refund from escrow', order_id: params.orderId },
        { account_code: '1010', debit: 0, credit: totalRefundToBuyer, description: 'Refund to buyer wallet', user_id: order.buyer_id, order_id: params.orderId }
      ];
      if (completesFullRefund && !escrow.fees_refunded) {
        const serviceFee = Number(escrow.service_fee);
        const smallOrderFee = Number(escrow.small_order_fee);
        if (serviceFee > 0) {
          entries.push({ account_code: '4020', debit: serviceFee, credit: 0, description: 'Refund platform service fee', order_id: params.orderId, user_id: null });
        }
        if (smallOrderFee > 0) {
          entries.push({ account_code: '4030', debit: smallOrderFee, credit: 0, description: 'Refund small-order fee', order_id: params.orderId, user_id: null });
        }
      }
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true, refunded: refundAmount, feesRefunded: feesBack, remaining: newRemaining };
      await this.recordIdempotency(client, idempotencyKey, 'refundOrderFunds', {
        orderId: params.orderId,
        amount: refundAmount
      }, result);
      
      const escRow = await client.query('SELECT * FROM escrows WHERE order_id = $1', [params.orderId]);
      if (escRow.rows.length > 0) {
        financialRepository.setEscrowCache(params.orderId, financialRepository.formatEscrowRow(escRow.rows[0]));
      }
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async topUpEscrow(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      assertValidFinancialAmount(params.amount, 'Escrow top-up amount', false);

      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escRes.rows.length === 0) return this.fundEscrow(params, client);
      
      const escrow = escRes.rows[0];
      if (escrow.status !== 'held') {
        throw new Error(`Cannot top up escrow in status '${escrow.status}'. Top-up is only allowed while escrow is actively held.`);
      }
      
      const idempKey = params.idempotencyKey || `IDEMP-ORD-TOPUP-${params.orderId}`;
      const cached = await this.checkIdempotency(client, idempKey, 'topUpEscrow', {
        orderId: params.orderId,
        amount: params.amount,
        buyerId: params.buyerId
      });
      if (cached) return cached;

      await this.ensureWallet({ userId: params.buyerId, role: 'buyer' }, client);

      const buyerRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.buyerId]);
      if (buyerRes.rows.length === 0) throw new Error('Buyer wallet not found');
      const buyer = buyerRes.rows[0];

      // Fix 6: Use authoritative Order commercial context / snapshot fee rates
      let clientFeeRate = DEFAULT_FEE_CONFIG.buyerFeePercent;
      let commissionPercent = DEFAULT_FEE_CONFIG.commissionPercent;
      const ordRes = await client.query('SELECT fee_breakdown FROM orders WHERE id = $1', [params.orderId]);
      if (ordRes.rows.length > 0 && ordRes.rows[0].fee_breakdown) {
        const bd = ordRes.rows[0].fee_breakdown;
        if (typeof bd.clientFeePercent === 'number') clientFeeRate = bd.clientFeePercent;
        if (typeof bd.commissionPercent === 'number') commissionPercent = bd.commissionPercent;
      }

      const gigPrice = Math.round(params.amount * 100) / 100;
      const serviceFee = Math.round((gigPrice * clientFeeRate / 100 + Number.EPSILON) * 100) / 100;
      const smallOrderFee = 0; // Incremental top-up does not recharge base small-order fee
      const clientTotal = Math.round((gigPrice + serviceFee) * 100) / 100;

      if (Number(buyer.available_balance) < clientTotal) throw new Error('Insufficient funds');

      await client.query('UPDATE wallets SET available_balance = available_balance - $1, funds_on_hold = funds_on_hold + $2 WHERE user_id = $3', [clientTotal, gigPrice, params.buyerId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.buyerId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), params.buyerId, -clientTotal, 'escrow_topup', `Top-up for order #${params.orderId}`]);
      
      await client.query('UPDATE escrows SET amount = amount + $1, remaining = remaining + $2, service_fee = service_fee + $3, small_order_fee = small_order_fee + $4, status = \'held\' WHERE order_id = $5',
        [gigPrice, gigPrice, serviceFee, smallOrderFee, params.orderId]);

      const jId = randomUUID();
      await client.query('INSERT INTO ledger_journals (id, reference, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5)', [jId, `ORD-${params.orderId}-TOPUP`, 'ORDER_ESCROW_FUNDED', params.actor, idempKey]);
      const entries = [
        { account_code: '1010', debit: clientTotal, credit: 0, description: 'Debited buyer wallet for top-up', user_id: params.buyerId },
        { account_code: '2030', debit: 0, credit: gigPrice, description: 'Escrow hold (top-up)', order_id: params.orderId }
      ];
      if (serviceFee > 0) {
        entries.push({ account_code: '4020', debit: 0, credit: serviceFee, description: 'Platform service fee (top-up)', order_id: params.orderId });
      }
      if (smallOrderFee > 0) {
        entries.push({ account_code: '4030', debit: 0, credit: smallOrderFee, description: 'Small-order fee (top-up)', order_id: params.orderId });
      }
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), jId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true };
      await this.recordIdempotency(client, idempKey, 'topUpEscrow', {
        orderId: params.orderId,
        amount: params.amount,
        buyerId: params.buyerId
      }, result);

      const escRow = await client.query('SELECT * FROM escrows WHERE order_id = $1', [params.orderId]);
      if (escRow.rows.length > 0) {
        financialRepository.setEscrowCache(params.orderId, financialRepository.formatEscrowRow(escRow.rows[0]));
      }
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async resolveEscrowSplit(params: { orderId: string; refundAmount: number; reason: string; actor: string }, externalClient?: any) {
    assertValidFinancialAmount(params.refundAmount, 'Split refund amount', true);
    const run = async (client: any) => {
      const refund = await this.refundOrderFunds({
        orderId: params.orderId,
        amount: params.refundAmount,
        reason: params.reason,
        actor: params.actor
      }, client);

      const release = await this.releaseOrderFunds({
        orderId: params.orderId,
        actor: params.actor,
        reason: `Remaining balance released after split refund: ${params.reason}`
      }, client);

      return { refund, release };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async creditDeposit(params: { userId: string; amount: number; actor: string; reference?: string; idempotencyKey?: string; source?: string }, externalClient?: any) {
    const run = async (client: any) => {
      assertValidFinancialAmount(params.amount, 'Deposit amount', false);

      await this.ensureWallet({ userId: params.userId }, client);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.userId]);
      if (walletRes.rows.length === 0) throw new Error('User wallet not found');
      
      if (!params.idempotencyKey) throw new Error('Idempotency key required');
      const idempotencyKey = params.idempotencyKey;
      const cached = await this.checkIdempotency(client, idempotencyKey, 'creditDeposit', {
        userId: params.userId,
        amount: params.amount
      });
      if (cached) return cached;

      await client.query('UPDATE wallets SET available_balance = available_balance + $1 WHERE user_id = $2', [params.amount, params.userId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.userId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', 
        [randomUUID(), params.userId, params.amount, 'deposit', params.reference || 'Deposit']);
      
      const journalId = randomUUID();
      await client.query(`INSERT INTO ledger_journals (id, reference, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5)`, [journalId, params.reference || `DEP-${params.userId}-${Date.now()}`, 'DEPOSIT', params.actor, idempotencyKey]);
      const entries = [
        { account_code: '1020', debit: params.amount, credit: 0, description: 'Platform cash inflow (deposit)' },
        { account_code: '1010', debit: 0, credit: params.amount, description: 'Credit user wallet', user_id: params.userId }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id || null]);

      const result = { success: true };
      await this.recordIdempotency(client, idempotencyKey, 'creditDeposit', {
        userId: params.userId,
        amount: params.amount
      }, result);
      
      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [params.userId]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(params.userId, financialRepository.formatWalletRow(updated.rows[0]));
      }
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async chargePromotionFee(params: { userId: string; gigId: string; gigTitle: string; amount?: number; fee?: number; actor: string; idempotencyKey?: string }, externalClient?: any) {
    const rawFee = params.amount ?? params.fee ?? 0;
    const feeAmt = assertValidFinancialAmount(rawFee, 'Promotion fee amount', true);
    const run = async (client: any) => {
      const idempKey = params.idempotencyKey || `IDEMP-FEAT-${params.gigId}-${Date.now()}`;
      const cached = await this.checkIdempotency(client, idempKey, 'chargePromotionFee', {
        userId: params.userId,
        gigId: params.gigId,
        fee: feeAmt
      });
      if (cached) return cached;

      await this.ensureWallet({ userId: params.userId, role: 'freelancer' }, client);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.userId]);
      if (walletRes.rows.length === 0) throw new Error('Freelancer wallet not found');
      const wallet = walletRes.rows[0];

      const currentBal = Number(wallet.available_balance || 0);
      if (currentBal < feeAmt) {
        throw new Error(`Insufficient wallet balance to feature gig ($${currentBal.toFixed(2)} available, $${feeAmt.toFixed(2)} required).`);
      }

      const newBal = fromCents(toCents(currentBal) - toCents(feeAmt));
      await client.query('UPDATE wallets SET available_balance = $1 WHERE user_id = $2', [newBal, params.userId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.userId]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), params.userId, -feeAmt, 'promotion_fee', `Feature fee for gig: ${params.gigTitle}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `FEAT-${params.gigId}`, `Featured gig promotion fee: ${params.gigTitle}`, 'ADMIN_ADJUSTMENT_DEBIT', idempKey, params.actor]
      );

      const entries = [
        { account_code: '2020', debit: feeAmt, credit: 0, description: 'Featured gig fee', user_id: params.userId },
        { account_code: '4010', debit: 0, credit: feeAmt, description: `Platform revenue: Featured gig ${params.gigTitle}`, user_id: null }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }

      const result = { success: true, newBalance: newBal };
      await this.recordIdempotency(client, idempKey, 'chargePromotionFee', {
        userId: params.userId,
        gigId: params.gigId,
        fee: feeAmt
      }, result);

      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [params.userId]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(params.userId, financialRepository.formatWalletRow(updated.rows[0]));
      }
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async requestPayout(params: { payoutId: string; freelancerId: string; amount: number; method: string; accountDetails: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      assertValidFinancialAmount(params.amount, 'Payout amount', false);

      const idempotencyKey = params.idempotencyKey || `IDEMP-PAYREQ-${params.payoutId}`;
      const cached = await this.checkIdempotency(client, idempotencyKey, 'requestPayout', {
        payoutId: params.payoutId,
        freelancerId: params.freelancerId,
        amount: params.amount
      });
      if (cached) return cached;

      await this.ensureWallet({ userId: params.freelancerId, role: 'freelancer' }, client);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.freelancerId]);
      if (walletRes.rows.length === 0) throw new Error('Freelancer wallet not found');
      const wallet = walletRes.rows[0];

      const currentBal = Number(wallet.available_balance || 0);
      if (currentBal < params.amount) {
        throw new Error(`Insufficient available balance.`);
      }

      const newBal = fromCents(toCents(currentBal) - toCents(params.amount));
      await client.query('UPDATE wallets SET available_balance = $1, pending_withdrawals = pending_withdrawals + $2 WHERE user_id = $3', [newBal, params.amount, params.freelancerId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.freelancerId]);

      await client.query(
        `INSERT INTO payouts (id, freelancer_id, amount, method, status, account_details, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, account_details = EXCLUDED.account_details`,
        [params.payoutId, params.freelancerId, params.amount, params.method, params.accountDetails]
      );

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), params.freelancerId, -params.amount, 'payout_request', `Withdrawal requested via ${params.method}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `PAY-${params.payoutId}-REQUESTED`, `Withdrawal requested #${params.payoutId}`, 'PAYOUT_REQUESTED', idempotencyKey, params.actor]
      );
      const entries = [
        { account_code: '1010', debit: params.amount, credit: 0, description: 'Debit wallet for payout', user_id: params.freelancerId },
        { account_code: '1030', debit: 0, credit: params.amount, description: 'Payout gateway transit hold', user_id: null }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id || null]);

      const result = { success: true, payoutId: params.payoutId, amount: params.amount, newBalance: newBal };
      await this.recordIdempotency(client, idempotencyKey, 'requestPayout', {
        payoutId: params.payoutId,
        freelancerId: params.freelancerId,
        amount: params.amount
      }, result);

      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [params.freelancerId]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(params.freelancerId, financialRepository.formatWalletRow(updated.rows[0]));
      }
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async chargeFeaturedGigFee(params: {
    gigId: string;
    sellerId: string;
    feeAmount: number;
    featuredUntil: string;
    actor: string;
    idempotencyKey?: string;
  }, externalClient?: any) {
    const run = async (client: any) => {
      assertValidFinancialAmount(params.feeAmount, 'Featured gig fee amount', true);

      const idempKey = params.idempotencyKey || `IDEMP-FEATGIG-${params.gigId}-${params.sellerId}`;
      const cached = await this.checkIdempotency(client, idempKey, 'chargeFeaturedGigFee', {
        gigId: params.gigId,
        sellerId: params.sellerId,
        feeAmount: params.feeAmount
      });
      if (cached) return cached;

      const gigRes = await client.query('SELECT * FROM gigs WHERE id = $1 FOR UPDATE', [params.gigId]);
      if (gigRes.rows.length === 0) throw new Error('Gig not found');
      const gig = gigRes.rows[0];

      if (gig.freelancer_id !== params.sellerId) {
        throw new Error('Forbidden: You can only feature your own gigs.');
      }

      if (gig.featured && gig.featured_until && new Date(gig.featured_until) > new Date()) {
        throw new Error('Gig is already actively featured.');
      }

      await this.ensureWallet({ userId: params.sellerId, role: 'freelancer' }, client);
      const walletRes = await client.query('SELECT available_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [params.sellerId]);
      if (walletRes.rows.length === 0 || Number(walletRes.rows[0].available_balance) < params.feeAmount) {
        throw new Error('Insufficient funds in wallet.');
      }

      await client.query('UPDATE wallets SET available_balance = available_balance - $1 WHERE user_id = $2', [params.feeAmount, params.sellerId]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.sellerId]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), params.sellerId, -params.feeAmount, 'fee', `Featured Gig Fee for #${params.gigId}`]
      );

      await client.query('UPDATE gigs SET featured = TRUE, featured_until = $1 WHERE id = $2', [params.featuredUntil, params.gigId]);

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `FEAT-${params.gigId}`, `Featured gig fee for #${params.gigId}`, 'FEATURED_GIG_FEE_PAID', idempKey, params.actor]
      );

      const entries = [
        { account_code: '1010', debit: params.feeAmount, credit: 0, description: 'Debit user wallet for featured gig', user_id: params.sellerId },
        { account_code: '4010', debit: 0, credit: params.feeAmount, description: 'Platform fee revenue for featured gig', user_id: null }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id || null]
        );
      }

      const result = { success: true, featured: true, featuredUntil: params.featuredUntil };
      await this.recordIdempotency(client, idempKey, 'chargeFeaturedGigFee', {
        gigId: params.gigId,
        sellerId: params.sellerId,
        feeAmount: params.feeAmount
      }, result);

      return result;
    };

    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async settlePayout(params: { payoutId: string; actor: string; providerReference?: string; idempotencyKey?: string }, externalClient?: any) {
    const run = async (client: any) => {
      const payRes = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [params.payoutId]);
      if (payRes.rows.length === 0) throw new Error('Payout not found');
      const p = payRes.rows[0];
      if (p.status !== 'pending' && p.status !== 'approved') throw new Error(`Cannot process payout in status "${p.status}"`);

      if (params.providerReference) {
        const provCheck = await client.query('SELECT id FROM payouts WHERE provider_reference = $1 AND id <> $2', [params.providerReference, params.payoutId]);
        if (provCheck.rows.length > 0) {
          throw new Error(`Provider reference "${params.providerReference}" is already bound to payout ${provCheck.rows[0].id}`);
        }
      }

      const amount = Number(p.amount);
      const updateRes = await client.query(
        "UPDATE payouts SET status = 'processed', provider_reference = COALESCE($1, provider_reference) WHERE id = $2 AND status = $3 RETURNING *",
        [params.providerReference || null, params.payoutId, p.status]
      );
      if (updateRes.rows.length === 0) {
        throw new Error('Payout settlement conflict: status was modified concurrently');
      }
      await client.query("UPDATE wallets SET pending_withdrawals = GREATEST(0, pending_withdrawals - $1) WHERE user_id = $2", [amount, p.freelancer_id]);

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalId, `PAY-${p.id}-SETTLED`, `Payout processed: ${p.method}`, 'PAYOUT_SETTLED', params.actor]
      );
      const entries = [
        { account_code: '1030', debit: amount, credit: 0, description: 'Clear transit liability', user_id: p.freelancer_id },
        { account_code: '1020', debit: 0, credit: amount, description: 'Platform bank outflow', user_id: null }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }
      return { success: true, journal: { id: journalId, reference: `PAY-${p.id}-SETTLED` } };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async cancelPayout(params: { payoutId: string; reason: string; actor: string }, externalClient?: any) {
    const run = async (client: any) => {
      const payRes = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [params.payoutId]);
      if (payRes.rows.length === 0) throw new Error('Payout not found');
      const p = payRes.rows[0];
      if (p.status !== 'pending' && p.status !== 'approved') throw new Error(`Cannot reject payout in status "${p.status}"`);

      const amount = Number(p.amount);
      const updateRes = await client.query("UPDATE payouts SET status = 'cancelled' WHERE id = $1 AND status = $2 RETURNING *", [params.payoutId, p.status]);
      if (updateRes.rows.length === 0) throw new Error('Payout rejection conflict: status modified concurrently');
      await client.query(
        "UPDATE wallets SET available_balance = available_balance + $1, pending_withdrawals = GREATEST(0, pending_withdrawals - $1) WHERE user_id = $2",
        [amount, p.freelancer_id]
      );
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [p.freelancer_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), p.freelancer_id, amount, 'payout_cancelled', `Payout #${p.id} cancelled: ${params.reason}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalId, `PAY-${p.id}-CANCELLED`, `Payout cancelled: ${params.reason}`, 'PAYOUT_CANCELLED', params.actor]
      );
      const entries = [
        { account_code: '1030', debit: amount, credit: 0, description: 'Cancel transit liability', user_id: p.freelancer_id },
        { account_code: '1010', debit: 0, credit: amount, description: 'Return funds to wallet', user_id: p.freelancer_id }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }
      return { success: true };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async failPayout(params: { payoutId: string; reason: string; actor: string }, externalClient?: any) {
    const run = async (client: any) => {
      const payRes = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [params.payoutId]);
      if (payRes.rows.length === 0) throw new Error('Payout not found');
      const p = payRes.rows[0];
      if (p.status !== 'pending' && p.status !== 'approved') throw new Error(`Cannot fail payout in status "${p.status}"`);

      const amount = Number(p.amount);
      const updateRes = await client.query("UPDATE payouts SET status = 'failed' WHERE id = $1 AND status = $2 RETURNING *", [params.payoutId, p.status]);
      if (updateRes.rows.length === 0) throw new Error('Payout failure conflict: status modified concurrently');
      await client.query(
        "UPDATE wallets SET available_balance = available_balance + $1, pending_withdrawals = GREATEST(0, pending_withdrawals - $1) WHERE user_id = $2",
        [amount, p.freelancer_id]
      );
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [p.freelancer_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), p.freelancer_id, amount, 'payout_failed', `Payout #${p.id} failed: ${params.reason}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalId, `PAY-${p.id}-FAILED`, `Payout failed: ${params.reason}`, 'PAYOUT_FAILED', params.actor]
      );
      const entries = [
        { account_code: '1030', debit: amount, credit: 0, description: 'Failed transit', user_id: p.freelancer_id },
        { account_code: '1010', debit: 0, credit: amount, description: 'Return failed payout to wallet', user_id: p.freelancer_id }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }
      return { success: true };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async retryPayout(params: { payoutId: string; actor: string }, externalClient?: any) {
    const run = async (client: any) => {
      const payRes = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [params.payoutId]);
      if (payRes.rows.length === 0) throw new Error('Payout not found');
      const p = payRes.rows[0];
      if (p.status !== 'failed') throw new Error('Only failed payouts can be retried.');

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [p.freelancer_id]);
      const wallet = walletRes.rows[0];
      const amount = Number(p.amount);
      if (Number(wallet.available_balance || 0) < amount) {
        throw new Error(`Insufficient wallet balance to retry payout.`);
      }

      await client.query("UPDATE payouts SET status = 'pending' WHERE id = $1", [params.payoutId]);
      await client.query(
        "UPDATE wallets SET available_balance = available_balance - $1, pending_withdrawals = pending_withdrawals + $1 WHERE user_id = $2",
        [amount, p.freelancer_id]
      );
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [p.freelancer_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), p.freelancer_id, -amount, 'payout_retry', `Retried payout #${p.id}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalId, `PAY-${p.id}-RETRIED`, `Retried payout #${p.id}`, 'PAYOUT_REQUESTED', params.actor]
      );
      const entries = [
        { account_code: '1010', debit: amount, credit: 0, description: 'Debit wallet for payout retry', user_id: p.freelancer_id },
        { account_code: '1030', debit: 0, credit: amount, description: 'Transit hold for retry', user_id: p.freelancer_id }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }
      return { success: true };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async freezeWallet(userId: string, reason: string, actor: string) {
    return postgresStore.executeInTransaction(async (client) => {
      const res = await client.query(
        "UPDATE wallets SET status = 'frozen', restriction_reason = $1 WHERE user_id = $2 RETURNING *",
        [reason, userId]
      );
      if (res.rows.length === 0) throw new Error('Wallet not found');
      const w = financialRepository.formatWalletRow(res.rows[0]);
      financialRepository.setWalletCache(userId, w);
      return w;
    });
  }

  async unfreezeWallet(userId: string, reason: string, actor: string) {
    return postgresStore.executeInTransaction(async (client) => {
      const res = await client.query(
        "UPDATE wallets SET status = 'active', restriction_reason = NULL WHERE user_id = $1 RETURNING *",
        [userId]
      );
      if (res.rows.length === 0) throw new Error('Wallet not found');
      const w = financialRepository.formatWalletRow(res.rows[0]);
      financialRepository.setWalletCache(userId, w);
      return w;
    });
  }

  async restrictWallet(userId: string, reason: string, actor: string) {
    return postgresStore.executeInTransaction(async (client) => {
      const res = await client.query(
        "UPDATE wallets SET status = 'restricted', restriction_reason = $1 WHERE user_id = $2 RETURNING *",
        [reason, userId]
      );
      if (res.rows.length === 0) throw new Error('Wallet not found');
      const w = financialRepository.formatWalletRow(res.rows[0]);
      financialRepository.setWalletCache(userId, w);
      return w;
    });
  }

  async executeAdjustment(params: {
    userId: string;
    amount: number;
    direction: 'credit_user' | 'debit_user';
    category: string;
    reason: string;
    evidenceReference?: string;
    actor: string;
    requestKey?: string;
  }) {
    assertValidFinancialAmount(params.amount, 'Adjustment amount', true);
    return postgresStore.executeInTransaction(async (client) => {
      const idempKey = params.requestKey || `IDEMP-ADJ-${params.userId}-${params.amount}-${params.direction}-${params.category}`;
      const cached = await this.checkIdempotency(client, idempKey, 'executeAdjustment', {
        userId: params.userId,
        amount: params.amount,
        direction: params.direction,
        category: params.category
      });
      if (cached) return cached;

      await this.ensureWallet({ userId: params.userId }, client);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.userId]);
      if (walletRes.rows.length === 0) throw new Error('User wallet not found');
      const wallet = walletRes.rows[0];

      const currentBal = Number(wallet.available_balance || 0);
      const adjAmount = Number(params.amount.toFixed(2));
      let newBal: number;

      if (params.direction === 'debit_user') {
        if (currentBal < adjAmount) {
          throw new Error(`Insufficient available balance ($${currentBal.toFixed(2)}) for administrative debit of $${adjAmount.toFixed(2)}.`);
        }
        newBal = fromCents(toCents(currentBal) - toCents(adjAmount));
        await client.query('UPDATE wallets SET available_balance = $1 WHERE user_id = $2', [newBal, params.userId]);
      } else {
        newBal = fromCents(toCents(currentBal) + toCents(adjAmount));
        await client.query('UPDATE wallets SET available_balance = $1 WHERE user_id = $2', [newBal, params.userId]);
      }

      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.userId]);

      const movementType = params.direction === 'credit_user' ? 'admin_credit' : 'admin_debit';
      const movementAmount = params.direction === 'credit_user' ? adjAmount : -adjAmount;
      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), params.userId, movementAmount, movementType, `Admin adjustment (${params.category}): ${params.reason}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      const eventType = params.direction === 'credit_user' ? 'ADMIN_ADJUSTMENT_CREDIT' : 'ADMIN_ADJUSTMENT_DEBIT';
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `ADJ-${params.userId}-${Date.now()}`, `Admin adjustment: ${params.reason}`, eventType, idempKey, params.actor]
      );

      const entries = params.direction === 'credit_user'
        ? [
            { account_code: '5020', debit: adjAmount, credit: 0, description: `Admin adjustment expense: ${params.reason}`, user_id: null },
            { account_code: '1010', debit: 0, credit: adjAmount, description: `Credit user wallet: ${params.reason}`, user_id: params.userId }
          ]
        : [
            { account_code: '1010', debit: adjAmount, credit: 0, description: `Debit user wallet: ${params.reason}`, user_id: params.userId },
            { account_code: '4010', debit: 0, credit: adjAmount, description: `Admin adjustment recovery: ${params.reason}`, user_id: null }
          ];

      await this.assertJournalBalanced(client, entries);
      for (const e of entries) {
        await client.query(
          'INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id]
        );
      }

      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [params.userId]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(params.userId, financialRepository.formatWalletRow(updated.rows[0]));
      }

      const result = {
        success: true,
        journal: { id: journalId, reference: `ADJ-${params.userId}` },
        wallet: {
          userId: params.userId,
          availableBalance: newBal,
          previousBalance: currentBal
        }
      };

      await this.recordIdempotency(client, idempKey, 'executeAdjustment', {
        userId: params.userId,
        amount: params.amount,
        direction: params.direction,
        category: params.category
      }, result);

      return result;
    });
  }

  async reverseJournal(journalId: string, reason: string, actor: string) {
    return postgresStore.executeInTransaction(async (client) => {
      const jRes = await client.query('SELECT * FROM ledger_journals WHERE id = $1 FOR UPDATE', [journalId]);
      if (jRes.rows.length === 0) throw new Error('Journal not found');
      const origJournal = jRes.rows[0];

      const operationalEventTypes = [
        'ORDER_ESCROW_FUNDED',
        'ESCROW_RELEASED_TO_FREELANCER',
        'ESCROW_REFUNDED_TO_BUYER',
        'PAYOUT_REQUESTED',
        'PAYOUT_SETTLED',
        'PAYOUT_CANCELLED',
        'PAYOUT_FAILED',
        'DEPOSIT',
        'FEATURED_GIG_FEE_PAID',
        'EARNINGS_CLEARED'
      ];
      if (operationalEventTypes.includes(origJournal.event_type)) {
        throw new Error(`Operational transaction journals (event type: ${origJournal.event_type}) cannot be reversed via generic journal reversal. They must be reversed through their dedicated business workflow.`);
      }

      const revRef = `REV-${origJournal.reference}`;
      const existingRev = await client.query('SELECT id FROM ledger_journals WHERE reference = $1', [revRef]);
      if (existingRev.rows.length > 0) {
        throw new Error(`Journal ${journalId} (${origJournal.reference}) has already been reversed by journal ${existingRev.rows[0].id}.`);
      }

      const entriesRes = await client.query('SELECT * FROM ledger_entries WHERE journal_id = $1', [journalId]);
      if (entriesRes.rows.length === 0) throw new Error('Journal has no entries');

      const revJournalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, 'REVERSAL', $4)`,
        [revJournalId, revRef, `Reversal of ${origJournal.reference}: ${reason}`, actor]
      );

      const revEntries = entriesRes.rows.map(e => ({
        account_code: e.account_code,
        debit: Number(e.credit),
        credit: Number(e.debit),
        description: `Reversal: ${e.description || ''}`,
        user_id: e.user_id,
        order_id: e.order_id,
        payout_id: e.payout_id
      }));

      await this.assertJournalBalanced(client, revEntries);
      for (const re of revEntries) {
        await client.query(
          `INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id, order_id, payout_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), revJournalId, re.account_code, re.debit, re.credit, re.description, re.user_id, re.order_id, re.payout_id]
        );

        if (re.user_id && ['1010', '2010', '2020'].includes(re.account_code)) {
          const netDiff = re.credit - re.debit;
          if (netDiff !== 0) {
            await client.query('UPDATE wallets SET available_balance = available_balance + $1 WHERE user_id = $2', [netDiff, re.user_id]);
            await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [re.user_id]);
          }
        }
      }

      return { success: true, reversalJournalId: revJournalId };
    });
  }

  async processEarningsClearing(params: { clearingId: string; actor: string }, externalClient?: any) {
    const run = async (client: any) => {
      const clrRes = await client.query(
        'SELECT * FROM earnings_clearing WHERE id = $1 AND status = \'clearing\' FOR UPDATE SKIP LOCKED',
        [params.clearingId]
      );
      if (clrRes.rows.length === 0) return { processed: false };
      const clearing = clrRes.rows[0];

      await client.query('UPDATE earnings_clearing SET status = \'completed\', payout_eligible = TRUE WHERE id = $1', [params.clearingId]);

      await this.ensureWallet({ userId: clearing.seller_id, role: 'freelancer' }, client);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [clearing.seller_id]);
      if (walletRes.rows.length === 0) throw new Error('Seller wallet not found');
      const wallet = walletRes.rows[0];

      const amount = Number(clearing.amount);
      const newBal = Number((Number(wallet.available_balance || 0) + amount).toFixed(2));
      await client.query('UPDATE wallets SET available_balance = $1 WHERE user_id = $2', [newBal, clearing.seller_id]);
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [clearing.seller_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), clearing.seller_id, amount, 'earnings_cleared', `14-day clearance completed for order #${clearing.order_id}`]
      );

      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalId, `CLR-${clearing.id}`, `Earnings clearing for Order #${clearing.order_id}`, 'EARNINGS_CLEARED', params.actor]
      );
      const entries = [
        { account_code: '2040', debit: amount, credit: 0, description: 'Debit pending earnings', user_id: clearing.seller_id, order_id: clearing.order_id },
        { account_code: '1010', debit: 0, credit: amount, description: 'Credit available wallet', user_id: clearing.seller_id, order_id: clearing.order_id }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const updated = await client.query('SELECT * FROM wallets WHERE user_id = $1', [clearing.seller_id]);
      if (updated.rows.length > 0) {
        financialRepository.setWalletCache(clearing.seller_id, financialRepository.formatWalletRow(updated.rows[0]));
      }

      return { processed: true, amount, sellerId: clearing.seller_id };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async getClearableEarnings() {
    return postgresStore.executeInTransaction(async (client) => {
      const res = await client.query(
        "SELECT id FROM earnings_clearing WHERE status = 'clearing' AND clearance_end <= NOW() FOR UPDATE SKIP LOCKED"
      );
      return res.rows.map(r => r.id);
    });
  }
}

export const financialTransactionService = new FinancialTransactionService();
