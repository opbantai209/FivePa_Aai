import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import { financeLedger } from '../../src/server/financeLedger.js';
import { randomUUID } from 'crypto';

export class FinancialTransactionService {
  private async assertJournalBalanced(client: any, entries: any[]) {
    const totalDebits = Number(entries.reduce((sum, e) => sum + Number(e.debit), 0).toFixed(2));
    const totalCredits = Number(entries.reduce((sum, e) => sum + Number(e.credit), 0).toFixed(2));
    if (Math.abs(totalDebits - totalCredits) > 0.001) {
      throw new Error(`Journal imbalance: Debits (${totalDebits}) !== Credits (${totalCredits})`);
    }
  }

  async fundEscrow(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    if (!isPostgresEnabled()) {
      return financeLedger.fundEscrow({
        orderId: params.orderId,
        orderTitle: params.orderTitle,
        amount: params.amount,
        buyerId: params.buyerId,
        sellerId: params.sellerId,
        actor: params.actor
      });
    }
    const run = async (client: any) => {
      const idempKey = params.idempotencyKey || `IDEMP-ORD-FUND-${params.orderId}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      const buyerRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.buyerId]);
      if (buyerRes.rows.length === 0) throw new Error('Buyer wallet not found');
      const buyer = buyerRes.rows[0];

      const gigPrice = Number(params.amount.toFixed(2));
      const serviceFee = (params.amount < 200) ? Number((params.amount * 0.01 + 1).toFixed(2)) : 0;
      const clientTotal = Number((gigPrice + serviceFee).toFixed(2));

      if (Number(buyer.available_balance) < clientTotal) throw new Error('Insufficient funds');

      // Update Authoritative Wallet
      await client.query('UPDATE wallets SET available_balance = available_balance - $1, funds_on_hold = funds_on_hold + $2 WHERE user_id = $3', [clientTotal, gigPrice, params.buyerId]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.buyerId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), params.buyerId, -clientTotal, 'escrow_funding', `Funded order #${params.orderId}`]);
      
      // Update Escrow
      await client.query('INSERT INTO escrows (order_id, order_title, buyer_id, seller_id, amount, remaining, status, service_fee) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)',
        [params.orderId, params.orderTitle, params.buyerId, params.sellerId, params.amount, 'held', serviceFee]);
      
      await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['funded_in_escrow', params.orderId]);

      // Balanced Journal
      const jId = randomUUID();
      await client.query('INSERT INTO ledger_journals (id, reference, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5)', [jId, `ORD-${params.orderId}-FUND`, 'ORDER_ESCROW_FUNDED', params.actor, idempKey]);
      const entries = [
        { account_code: '1010', debit: clientTotal, credit: 0, description: 'Debited buyer wallet', user_id: params.buyerId },
        { account_code: '2030', debit: 0, credit: gigPrice, description: 'Escrow hold', order_id: params.orderId },
        { account_code: '4020', debit: 0, credit: serviceFee, description: 'Platform service fee', order_id: params.orderId }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), jId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true };
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempKey, 'fundEscrow', 'completed', JSON.stringify(result)]);
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async releaseOrderFunds(params: { orderId: string; actor: string; reason?: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      const idempotencyKey = params.idempotencyKey || `IDEMP-REL-${params.orderId}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempotencyKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [params.orderId]);
      if (orderRes.rows.length === 0) throw new Error('Order not found');
      const order = orderRes.rows[0];

      if (order.status === 'completed') throw new Error('Order is already completed.');
      if (order.status === 'cancelled') throw new Error('Order is already cancelled.');

      const escrowRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escrowRes.rows.length === 0) throw new Error('No escrow found for order');
      const escrow = escrowRes.rows[0];

      if (escrow.status !== 'held' || Number(escrow.remaining) <= 0) {
        throw new Error(`Escrow for order ${params.orderId} is already ${escrow.status}; nothing left to release.`);
      }

      const buyerRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [order.buyer_id]);
      if (buyerRes.rows.length === 0) throw new Error('Buyer wallet not found');
      const buyerWallet = buyerRes.rows[0];

      const gross = Number(escrow.remaining);
      const commissionRate = Number(escrow.commission_percent || 20.0);
      const platformFee = Number((gross * (commissionRate / 100)).toFixed(2));
      const freelancerNet = Number((gross - platformFee).toFixed(2));

      // Update Escrow
      await client.query(
        'UPDATE escrows SET remaining = 0, released_gross = released_gross + $1, status = CASE WHEN refunded_total > 0 THEN ' + "'split'" + ' ELSE ' + "'released'" + ' END WHERE order_id = $2',
        [gross, params.orderId]
      );

      // Update Wallets (Buyer Hold -> Seller Pending)
      await client.query('UPDATE wallets SET funds_on_hold = funds_on_hold - $1 WHERE user_id = $2', [gross, order.buyer_id]);
      // Note: We don't credit seller wallet YET, we put it in earnings_clearing which is like a ledger credit to 2040.
      
      // Update Order
      await client.query('UPDATE orders SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', params.orderId]);

      // 14-day Earnings Clearing Entry
      const clearingId = 'clr_' + randomUUID().slice(0, 12);
      const clearanceEnd = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      await client.query(
        `INSERT INTO earnings_clearing (id, order_id, seller_id, amount, clearance_end, status, payout_eligible)
         VALUES ($1, $2, $3, $4, $5, 'clearing', FALSE)`,
        [clearingId, params.orderId, order.seller_id, freelancerNet, clearanceEnd]
      );

      // Balanced Journal
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
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempotencyKey, 'releaseOrderFunds', 'completed', JSON.stringify(result)]);
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async refundOrderFunds(params: { orderId: string; amount?: number; reason: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [params.orderId]);
      if (orderRes.rows.length === 0) throw new Error('Order not found');
      const order = orderRes.rows[0];

      const escrowRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escrowRes.rows.length === 0) throw new Error('No escrow found for order');
      const escrow = escrowRes.rows[0];

      const idempotencyKey = params.idempotencyKey || `IDEMP-REF-${params.orderId}-${escrow.refund_seq + 1}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempotencyKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      if (escrow.status !== 'held' || Number(escrow.remaining) <= 0) {
        throw new Error(`Escrow for order ${params.orderId} is already ${escrow.status}; nothing left to refund.`);
      }

      const refundAmount = params.amount === undefined ? Number(escrow.remaining) : Number(params.amount);
      if (refundAmount > Number(escrow.remaining)) {
        throw new Error(`Refund exceeds escrow held.`);
      }

      const completesFullRefund = Number((Number(escrow.refunded_total) + refundAmount).toFixed(2)) === Number(escrow.amount) && Number(escrow.released_gross) === 0;
      const feesBack = completesFullRefund && !escrow.fees_refunded ? Number(escrow.service_fee) + Number(escrow.small_order_fee) : 0;
      const totalRefundToBuyer = Number((refundAmount + feesBack).toFixed(2));

      // Update Escrow
      const newRemaining = Number((Number(escrow.remaining) - refundAmount).toFixed(2));
      const newRefundedTotal = Number((Number(escrow.refunded_total) + refundAmount).toFixed(2));
      const nextSeq = escrow.refund_seq + 1;
      const newStatus = newRemaining === 0 ? 'refunded' : escrow.status;

      await client.query(
        `UPDATE escrows SET remaining = $1, refunded_total = $2, refund_seq = $3, status = $4, fees_refunded = CASE WHEN $5 THEN TRUE ELSE fees_refunded END WHERE order_id = $6`,
        [newRemaining, newRefundedTotal, nextSeq, newStatus, completesFullRefund, params.orderId]
      );

      // Update Wallets (Buyer Hold -> Buyer Available)
      await client.query('UPDATE wallets SET funds_on_hold = funds_on_hold - $1, available_balance = available_balance + $2 WHERE user_id = $3', [refundAmount, totalRefundToBuyer, order.buyer_id]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [order.buyer_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), order.buyer_id, totalRefundToBuyer, 'escrow_refund', `Refund for order #${params.orderId}: ${params.reason}`]
      );

      if (newRemaining === 0) {
        await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', params.orderId]);
      }

      // Balanced Journal
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
      if (feesBack > 0) {
        entries.push({ account_code: '4020', debit: feesBack, credit: 0, description: 'Refund platform service fee', order_id: params.orderId, user_id: null });
      }
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true, refunded: refundAmount, feesRefunded: feesBack, remaining: newRemaining };
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempotencyKey, 'refundOrderFunds', 'completed', JSON.stringify(result)]);
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async requestPayout(params: { payoutId: string; freelancerId: string; amount: number; method: string; accountDetails: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      const idempotencyKey = params.idempotencyKey || `IDEMP-PAYREQ-${params.payoutId}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempotencyKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.freelancerId]);
      if (walletRes.rows.length === 0) throw new Error('Freelancer wallet not found');
      const wallet = walletRes.rows[0];

      const currentBal = Number(wallet.available_balance || 0);
      if (currentBal < params.amount) {
        throw new Error(`Insufficient available balance.`);
      }

      const newBal = Number((currentBal - params.amount).toFixed(2));
      await client.query('UPDATE wallets SET available_balance = $1, pending_withdrawals = pending_withdrawals + $2 WHERE user_id = $3', [newBal, params.amount, params.freelancerId]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.freelancerId]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), params.freelancerId, -params.amount, 'payout_request', `Withdrawal requested via ${params.method}`]
      );

      // Balanced Journal
      const journalId = 'jnl_' + randomUUID().slice(0, 12);
      await client.query(
        `INSERT INTO ledger_journals (id, reference, description, event_type, idempotency_key, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journalId, `PAY-${params.payoutId}-REQUESTED`, `Withdrawal requested #${params.payoutId}`, 'PAYOUT_REQUESTED', idempotencyKey, params.actor]
      );
      const entries = [
        { account_code: '1010', debit: params.amount, credit: 0, description: 'Debit wallet for payout', user_id: params.freelancerId },
        { account_code: '1020', debit: 0, credit: params.amount, description: 'Platform cash outflow (pending)', user_id: null }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id || null]);

      const result = { success: true, payoutId: params.payoutId, amount: params.amount, newBalance: newBal };
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempotencyKey, 'requestPayout', 'completed', JSON.stringify(result)]);
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async processEarningsClearing(params: { clearingId: string; actor: string }, externalClient?: any) {
    const run = async (client: any) => {
      const clrRes = await client.query(
        'SELECT * FROM earnings_clearing WHERE id = $1 AND status = ' + "'clearing'" + ' FOR UPDATE SKIP LOCKED',
        [params.clearingId]
      );
      if (clrRes.rows.length === 0) return { processed: false };
      const clearing = clrRes.rows[0];

      // Mark clearing as processed
      await client.query('UPDATE earnings_clearing SET status = ' + "'completed'" + ', payout_eligible = TRUE WHERE id = $1', [params.clearingId]);

      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [clearing.seller_id]);
      if (walletRes.rows.length === 0) throw new Error('Seller wallet not found');
      const wallet = walletRes.rows[0];

      const amount = Number(clearing.amount);
      const newBal = Number((Number(wallet.available_balance || 0) + amount).toFixed(2));
      await client.query('UPDATE wallets SET available_balance = $1 WHERE user_id = $2', [newBal, clearing.seller_id]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [clearing.seller_id]);

      await client.query(
        'INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), clearing.seller_id, amount, 'earnings_cleared', `14-day clearance completed for order #${clearing.order_id}`]
      );

      // Balanced Journal
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

      return { processed: true, amount, sellerId: clearing.seller_id };
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async topUpEscrow(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; idempotencyKey?: string; }, externalClient?: any) {
    const run = async (client: any) => {
      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [params.orderId]);
      if (escRes.rows.length === 0) return this.fundEscrow(params, client);
      
      const escrow = escRes.rows[0];
      if (!['held', 'released', 'split'].includes(escrow.status)) throw new Error(`Escrow status ${escrow.status} invalid for top-up.`);
      
      const idempKey = params.idempotencyKey || `IDEMP-ORD-TOPUP-${params.orderId}-${Date.now()}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      const buyerRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.buyerId]);
      if (buyerRes.rows.length === 0) throw new Error('Buyer wallet not found');
      const buyer = buyerRes.rows[0];

      const gigPrice = Number(params.amount.toFixed(2));
      const serviceFee = (params.amount < 200) ? Number((params.amount * 0.01 + 1).toFixed(2)) : 0;
      const clientTotal = Number((gigPrice + serviceFee).toFixed(2));

      if (Number(buyer.available_balance) < clientTotal) throw new Error('Insufficient funds');

      // Update Authoritative Wallet
      await client.query('UPDATE wallets SET available_balance = available_balance - $1, funds_on_hold = funds_on_hold + $2 WHERE user_id = $3', [clientTotal, gigPrice, params.buyerId]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.buyerId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), params.buyerId, -clientTotal, 'escrow_topup', `Top-up for order #${params.orderId}`]);
      
      // Update Escrow
      await client.query('UPDATE escrows SET amount = amount + $1, remaining = remaining + $2, service_fee = service_fee + $3 WHERE order_id = $4',
        [params.amount, params.amount, serviceFee, params.orderId]);

      // Balanced Journal
      const jId = randomUUID();
      await client.query('INSERT INTO ledger_journals (id, reference, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5)', [jId, `ORD-${params.orderId}-TOPUP`, 'ORDER_ESCROW_FUNDED', params.actor, idempKey]);
      const entries = [
        { account_code: '1010', debit: clientTotal, credit: 0, description: 'Debited buyer wallet for top-up', user_id: params.buyerId },
        { account_code: '2030', debit: 0, credit: gigPrice, description: 'Escrow hold (top-up)', order_id: params.orderId },
        { account_code: '4020', debit: 0, credit: serviceFee, description: 'Platform service fee (top-up)', order_id: params.orderId }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), jId, e.account_code, e.debit, e.credit, e.description, e.order_id || null, e.user_id || null]);

      const result = { success: true };
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempKey, 'topUpEscrow', 'completed', JSON.stringify(result)]);
      return result;
    };
    if (externalClient) return run(externalClient);
    return postgresStore.executeInTransaction(run);
  }

  async resolveEscrowSplit(params: { orderId: string; refundAmount: number; reason: string; actor: string }, externalClient?: any) {
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

  async creditDeposit(params: { userId: string; amount: number; actor: string; idempotencyKey?: string }, externalClient?: any) {
    if (!isPostgresEnabled()) {
      return financeLedger.creditDeposit({
        userId: params.userId,
        amount: params.amount,
        reference: `DEP-${params.idempotencyKey || randomUUID()}`,
        idempotencyKey: params.idempotencyKey || randomUUID(),
        actor: params.actor,
        source: 'simulated'
      });
    }
    const run = async (client: any) => {
      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [params.userId]);
      if (walletRes.rows.length === 0) throw new Error('User wallet not found');
      
      const idempotencyKey = params.idempotencyKey || `IDEMP-DEP-${params.userId}-${Date.now()}`;
      const existing = await client.query('SELECT result FROM financial_idempotency WHERE key = $1', [idempotencyKey]);
      if (existing.rows.length > 0) return existing.rows[0].result;

      await client.query('UPDATE wallets SET available_balance = available_balance + $1 WHERE user_id = $2', [params.amount, params.userId]);
      // Sync Legacy
      await client.query('UPDATE users SET wallet_balance = (SELECT available_balance FROM wallets WHERE user_id = $1) WHERE id = $1', [params.userId]);

      await client.query('INSERT INTO wallet_movements (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)', 
        [randomUUID(), params.userId, params.amount, 'deposit', 'Simulated deposit']);
      
      const journalId = randomUUID();
      await client.query(`INSERT INTO ledger_journals (id, reference, event_type, actor, idempotency_key) VALUES ($1, $2, $3, $4, $5)`, [journalId, `DEP-${params.userId}-${Date.now()}`, 'DEPOSIT', params.actor, idempotencyKey]);
      const entries = [
        { account_code: '1020', debit: params.amount, credit: 0, description: 'Platform cash inflow (deposit)' },
        { account_code: '1010', debit: 0, credit: params.amount, description: 'Credit user wallet', user_id: params.userId }
      ];
      await this.assertJournalBalanced(client, entries);
      for (const e of entries) await client.query('INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, description, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), journalId, e.account_code, e.debit, e.credit, e.description, e.user_id || null]);

      const result = { success: true };
      await client.query('INSERT INTO financial_idempotency (key, operation, status, result) VALUES ($1, $2, $3, $4)', [idempotencyKey, 'creditDeposit', 'completed', JSON.stringify(result)]);
      return result;
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


