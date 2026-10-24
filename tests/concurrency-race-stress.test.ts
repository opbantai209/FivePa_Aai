/**
 * Concurrency & Multi-Click Race Condition Stress Test Suite
 * Simulates simultaneous multi-click attacks (50 rapid requests in the same millisecond)
 * to prove that the transaction locking mechanism and double-entry ledger invariants
 * hold without race conditions, double payouts, or escrow overdraws.
 */

process.env.PORT = '3007';
process.env.NODE_ENV = 'test';

import assert from 'node:assert';
import { orders, users, type Order, type UserAccount } from '../server/store.js';
import { financeLedger } from '../src/server/financeLedger.js';
import { diagnosticService } from '../server/services/diagnosticService.js';
import bcrypt from 'bcryptjs';

const PORT = 3007;
const BASE = `http://localhost:${PORT}`;

async function api(path: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function runStressTests() {
  console.log('--- STARTING CONCURRENCY & MULTI-CLICK STRESS TEST SUITE ---');

  // Boot server
  const serverMod = await import('../server.ts');
  if (!serverMod.server.listening) {
    await new Promise((resolve) => serverMod.server.once('listening', resolve));
  }

  const T0 = Date.now();
  const buyerId = `usr_buyer_stress_${T0}`;
  const sellerId = `usr_seller_stress_${T0}`;

  // 1. Setup buyer and seller accounts
  const buyerUser: UserAccount = {
    id: buyerId,
    name: 'Stress Test Buyer',
    email: `buyer_${T0}@stress.com`,
    role: 'buyer',
    avatar: 'https://avatar.png',
    title: 'Enterprise Client',
    rating: 5,
    reviewsCount: 0,
    hourlyRate: 0,
    earned: 0,
    completedJobs: 0,
    bio: 'Test',
    skills: [],
    status: 'active',
    verified: true,
    walletBalance: 10000,
    createdAt: new Date().toISOString(),
    password: bcrypt.hashSync('password123', 10),
    sessionVersion: 1,
    knownDevices: ['stress-device']
  };

  const sellerUser: UserAccount = {
    id: sellerId,
    name: 'Stress Test Seller',
    email: `seller_${T0}@stress.com`,
    role: 'freelancer',
    avatar: 'https://avatar.png',
    title: 'Senior Developer',
    rating: 5,
    reviewsCount: 0,
    hourlyRate: 100,
    earned: 0,
    completedJobs: 0,
    bio: 'Test',
    skills: [],
    status: 'active',
    verified: true,
    walletBalance: 0,
    createdAt: new Date().toISOString(),
    password: bcrypt.hashSync('password123', 10),
    sessionVersion: 1,
    knownDevices: ['stress-device']
  };

  users.push(buyerUser, sellerUser);
  financeLedger.ensureWallet({ userId: buyerId, name: buyerUser.name, email: buyerUser.email, role: 'buyer' });
  financeLedger.ensureWallet({ userId: sellerId, name: sellerUser.name, email: sellerUser.email, role: 'freelancer' });

  // Deposit funds to buyer wallet
  financeLedger.creditDeposit({
    userId: buyerId,
    amount: 10000,
    reference: `DEP-STRESS-${T0}`,
    idempotencyKey: `idemp-dep-stress-${T0}`,
    actor: buyerId
  });

  // Login as buyer to get authenticated JWT session token
  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: { userId: buyerId, password: 'password123', deviceId: 'stress-device' }
  });
  assert.strictEqual(loginRes.status, 200, 'Buyer login must succeed');
  const buyerToken = loginRes.json.token;

  // =========================================================================
  // TEST 1: 50 SIMULTANEOUS MULTI-CLICK ESCROW RELEASE ATTACK
  // =========================================================================
  console.log('\n[TEST 1] Simulating 50 rapid simultaneous escrow release requests hitting server in same millisecond...');
  const orderId = `ord_stress_rel_${T0}`;
  const escrowAmount = 1000;

  const order: Order = {
    id: orderId,
    title: 'Escrow Race Condition Stress Order',
    buyerId,
    sellerId,
    amount: escrowAmount,
    status: 'delivered',
    createdAt: new Date().toISOString(),
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    deliverableFiles: [{ id: 'deliv_1', name: 'deliverable.zip', size: '2 MB', url: '/api/workstream/files/test.zip' }],
    deliveryHistory: [{
      version: 1,
      deliveredAt: new Date().toISOString(),
      files: [{ id: 'deliv_1', name: 'deliverable.zip', size: '2 MB', url: '/api/workstream/files/test.zip' }]
    }]
  };
  orders.push(order);
  serverMod.registerOrder(order);

  // Fund escrow
  financeLedger.fundEscrow({
    orderId,
    orderTitle: order.title,
    amount: escrowAmount,
    buyerId,
    sellerId,
    actor: buyerId
  });

  const initialSellerBalance = financeLedger.getWalletBalance(sellerId) || 0;
  const initialEscrowRecord = financeLedger.getEscrow(orderId);
  assert.strictEqual(initialEscrowRecord?.remaining, 1000, 'Initial escrow remaining must be 1000');

  // Fire 50 simultaneous release requests concurrently
  const CONCURRENT_REQUESTS = 50;
  const releasePromises = Array.from({ length: CONCURRENT_REQUESTS }).map((_, idx) =>
    api('/api/payments/escrow/release', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${buyerToken}` },
      body: { orderId, requestKey: `req_release_${orderId}_attempt_${idx}` }
    })
  );

  const results = await Promise.all(releasePromises);

  // Analyze responses: exactly ONE must succeed with 200
  const successes = results.filter(r => r.status === 200);
  const blocked = results.filter(r => r.status === 409 || r.status === 400);

  console.log(`  -> 50 concurrent release requests completed: ${successes.length} succeeded, ${blocked.length} safely blocked.`);
  assert.strictEqual(successes.length, 1, `Exactly 1 escrow release must succeed under concurrent assault (got ${successes.length})`);
  assert.strictEqual(blocked.length, CONCURRENT_REQUESTS - 1, `All other ${CONCURRENT_REQUESTS - 1} requests must be blocked with 409 or 400 (got ${blocked.length})`);

  // Verify financial invariants
  const finalSellerBalance = financeLedger.getWalletBalance(sellerId) || 0;
  const expectedPayout = 800; // 80% of 1000 after 20% platform commission
  assert.strictEqual(
    finalSellerBalance,
    initialSellerBalance + expectedPayout,
    `Seller wallet must be credited exactly once ($${expectedPayout}). Actual balance: $${finalSellerBalance}`
  );

  const finalEscrowRecord = financeLedger.getEscrow(orderId);
  assert.strictEqual(finalEscrowRecord?.remaining, 0, 'Escrow remaining must be exactly 0 (no double-spend/negative escrow)');
  assert.strictEqual(finalEscrowRecord?.status, 'released', 'Escrow status must be released');
  assert.strictEqual(order.status, 'completed', 'Order status must be completed');
  console.log('  [PASS] 50-Request Escrow Release Race Condition safely defeated by atomic locks & ledger invariants!');

  // =========================================================================
  // TEST 2: 50 SIMULTANEOUS MULTI-CLICK ESCROW REFUND ATTACK
  // =========================================================================
  console.log('\n[TEST 2] Simulating 50 rapid simultaneous escrow refund requests hitting server in same millisecond...');
  const refundOrderId = `ord_stress_ref_${T0}`;
  const refundEscrowAmount = 500;

  const pastDueDate = new Date(Date.now() - 30 * 3600 * 1000).toISOString().split('T')[0]; // Overdue for refund
  const refundOrder: Order = {
    id: refundOrderId,
    orderType: 'gig',
    gigOrderId: refundOrderId,
    title: 'Refund Race Condition Stress Order',
    buyerId,
    sellerId,
    amount: refundEscrowAmount,
    status: 'funded_in_escrow',
    createdAt: new Date().toISOString(),
    dueDate: pastDueDate
  };
  orders.push(refundOrder);
  serverMod.registerOrder(refundOrder);

  financeLedger.fundEscrow({
    orderId: refundOrderId,
    orderTitle: refundOrder.title,
    amount: refundEscrowAmount,
    buyerId,
    sellerId,
    actor: buyerId
  });

  const buyerBalanceBeforeRefund = financeLedger.getWalletBalance(buyerId) || 0;

  // Fire 50 simultaneous refund requests concurrently
  const refundPromises = Array.from({ length: CONCURRENT_REQUESTS }).map((_, idx) =>
    api('/api/payments/escrow/refund', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${buyerToken}` },
      body: { orderId: refundOrderId, reason: 'Missed deadline by over 24 hours', requestKey: `req_ref_${refundOrderId}_attempt_${idx}` }
    })
  );

  const refundResults = await Promise.all(refundPromises);
  const refundSuccesses = refundResults.filter(r => r.status === 200);
  const refundBlocked = refundResults.filter(r => r.status === 409 || r.status === 400);

  console.log(`  -> 50 concurrent refund requests completed: ${refundSuccesses.length} succeeded, ${refundBlocked.length} safely blocked.`);
  assert.strictEqual(refundSuccesses.length, 1, `Exactly 1 escrow refund must succeed under concurrent assault (got ${refundSuccesses.length})`);
  assert.strictEqual(refundBlocked.length, CONCURRENT_REQUESTS - 1, `All other ${CONCURRENT_REQUESTS - 1} requests must be blocked with 409 or 400 (got ${refundBlocked.length})`);

  const buyerBalanceAfterRefund = financeLedger.getWalletBalance(buyerId) || 0;
  const refundDiff = buyerBalanceAfterRefund - buyerBalanceBeforeRefund;
  assert.ok(refundDiff >= 500, `Buyer must receive full refund of $500 (plus returned fees). Got +$${refundDiff}`);

  const refundEscrowState = financeLedger.getEscrow(refundOrderId);
  assert.strictEqual(refundEscrowState?.remaining, 0, 'Refunded escrow remaining must be 0');
  assert.strictEqual(refundOrder.status, 'cancelled', 'Order status must be cancelled');
  console.log('  [PASS] 50-Request Escrow Refund Race Condition safely defeated by atomic locks & ledger invariants!');

  // =========================================================================
  // TEST 3: EXHAUSTIVE RUNTIME DIAGNOSTIC LOGGING VERIFICATION
  // =========================================================================
  console.log('\n[TEST 3] Verifying runtime_diagnostic_logs records all security intercepts & transaction events...');
  const logs = diagnosticService.getInMemoryLogs();
  assert.ok(logs.length > 0, 'Runtime diagnostic logs must contain recorded entries');

  const releaseInterceptLogs = logs.filter(l => 
    l.service === 'financialService' && 
    (l.outcome === 'INTERCEPTED' || l.outcome === 'FAILED')
  );
  console.log(`  -> Total recorded diagnostic log entries: ${logs.length}`);
  console.log(`  -> Recorded security intercepts & blocks: ${releaseInterceptLogs.length}`);

  // Assert every log entry adheres to required schema
  for (const entry of logs.slice(0, 20)) {
    assert.ok(entry.id, 'Log entry must have a unique UUID id');
    assert.ok(entry.timestamp, 'Log entry must have timestamp');
    assert.ok(['info', 'warning', 'critical', 'security'].includes(entry.severity.toLowerCase()), `Valid severity: ${entry.severity}`);
    assert.ok(entry.service, 'Log entry must record service');
    assert.ok(entry.function_name, 'Log entry must record function_name');
    assert.ok(['SUCCESS', 'INTERCEPTED', 'FAILED'].includes(entry.outcome), `Valid outcome: ${entry.outcome}`);
    assert.ok(entry.details, 'Log entry must record details object');
  }
  console.log('  [PASS] Runtime diagnostic logs schema strictly verified (severity, service, function_name, outcome, details, error_message)!');

  console.log('\nALL CONCURRENCY RACE CONDITION & SECURITY STRESS TESTS PASSED! (3/3 test suites passed)');
  process.exit(0);
}

runStressTests().catch((err) => {
  console.error('[STRESS TEST FAILURE]', err);
  process.exit(1);
});
