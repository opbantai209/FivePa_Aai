import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  store,
  type Proposal,
  type Order,
  type WorkstreamOffer
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  resolveAuthenticatedUserId,
  adminActor,
  rateLimit
} from '../middleware/auth.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { calculateOrderFees, DEFAULT_FEE_CONFIG } from '../../src/shared/fees.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { emitSystemEvent } from '../services/messagingService.js';
import { createNotification } from '../services/notificationService.js';
import {
  ensureWallet,
  recordOrder,
  orderIndex,
  tryAcquireOrderLock,
  releaseOrderLock,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  enrichOrderWithServiceInfo,
  registerAuditLog,
  hasCommittedFinancialState
} from '../services/orderService.js';
import { financialTransactionService } from '../services/financialService.js';
import { postOfferMessage, viewOffer } from '../services/workstreamService.js';

export const proposalRouter = Router();

export async function enrichProposalWithWorkstream(p: Proposal): Promise<Proposal> {
  let workstreamOrderId = p.workstreamOrderId;
  let offerId = p.offerId;
  if (!workstreamOrderId) {
    const ordRes = await postgresStore.getPool().query("SELECT id FROM orders WHERE fee_breakdown->>'proposalId' = $1 OR requirements LIKE $2", [p.id, `%${p.id}%`]);
    if (ordRes.rows.length > 0) workstreamOrderId = ordRes.rows[0].id;
  }
  if (!offerId && workstreamOrderId) {
    const offRes = await postgresStore.getPool().query(
      "SELECT id FROM workstream_offers WHERE metadata->>'proposalId' = $1 OR (order_id = $2 AND kind = 'proposal')",
      [p.id, workstreamOrderId]
    );
    if (offRes.rows.length > 0) offerId = offRes.rows[0].id;
  }
  return {
    ...p,
    ...(workstreamOrderId ? { workstreamOrderId } : {}),
    ...(offerId ? { offerId } : {})
  };
}

// Proposals list
proposalRouter.get('/proposals', async (req: Request, res: Response) => {
  try {
    const authUserId = resolveAuthenticatedUserId(req);
    if (!authUserId) {
      return res.json([]);
    }
    const userRes = await postgresStore.getPool().query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const callerRole = userRes.rows[0]?.role;
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin' || callerRole === 'support';

    let queryText = 'SELECT * FROM proposals ORDER BY created_at DESC';
    let queryParams: any[] = [];
    if (!isAdmin) {
      queryText = `
        SELECT p.* FROM proposals p
        LEFT JOIN projects pr ON p.project_id = pr.id
        WHERE p.freelancer_id = $1 OR pr.buyer_id = $1
        ORDER BY p.created_at DESC
      `;
      queryParams = [authUserId];
    }

    const propRes = await postgresStore.getPool().query(queryText, queryParams);
    const userProposals: Proposal[] = propRes.rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      freelancerId: r.freelancer_id,
      freelancerName: r.freelancer_name,
      freelancerAvatar: r.freelancer_avatar || '',
      freelancerTitle: r.freelancer_title || '',
      coverLetter: r.cover_letter || '',
      bidAmount: Number(r.bid_amount),
      deliveryDays: Number(r.delivery_days),
      createdAt: r.created_at,
      status: r.status,
      workstreamOrderId: r.workstream_order_id || undefined,
      offerId: r.offer_id || undefined
    }));

    const enriched = await Promise.all(userProposals.map(enrichProposalWithWorkstream));
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list proposals' });
  }
});

// Submit proposal
proposalRouter.post('/proposals', requireAuth, requireActiveStatus, rateLimit(30, 60_000), async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot submit new proposals while your account is restricted.' });

    const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [req.body.projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found.' });
    const proj = projRes.rows[0];

    if (!['open', 'published', 'in_progress'].includes(proj.status)) {
      return res.status(400).json({ error: 'This project is completed and closed to new proposals.' });
    }
    if (proj.buyer_id === caller.id) {
      return res.status(400).json({ error: 'You cannot submit a proposal to your own project.' });
    }
    const bidAmount = Math.round(Number(req.body.bidAmount) * 100) / 100;
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid USD bid amount.' });
    }
    const deliveryDays = Math.max(1, Math.min(365, Math.round(Number(req.body.deliveryDays) || 7)));

    const newPropId = 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const createdAt = new Date().toISOString().split('T')[0];
    const coverLetter = typeof req.body.coverLetter === 'string' ? req.body.coverLetter.trim().slice(0, 5000) : '';

    await postgresStore.getPool().query(
      `INSERT INTO proposals (
        id, project_id, freelancer_id, freelancer_name, freelancer_avatar, 
        freelancer_title, cover_letter, bid_amount, delivery_days, created_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
      [newPropId, req.body.projectId, caller.id, caller.name, caller.avatar || null, caller.title || 'Senior Engineer', coverLetter, bidAmount, deliveryDays, createdAt]
    );

    await postgresStore.getPool().query(
      'UPDATE projects SET proposals_count = proposals_count + 1 WHERE id = $1',
      [req.body.projectId]
    );

    const newProp: Proposal = {
      id: newPropId,
      projectId: req.body.projectId,
      freelancerId: caller.id,
      freelancerName: caller.name,
      freelancerAvatar: caller.avatar,
      freelancerTitle: caller.title || 'Senior Engineer',
      coverLetter,
      bidAmount,
      deliveryDays,
      createdAt,
      status: 'pending'
    };

    createNotification({
      userId: proj.buyer_id,
      type: 'proposal',
      title: 'New Proposal Received',
      message: `${caller.name} submitted a $${bidAmount} proposal for your project "${proj.title}".`,
      link: `/projects/${proj.id}`,
      dedupKey: `proposal_${newProp.id}`,
      actorId: caller.id
    });

    res.json(newProp);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to submit proposal' });
  }
});

// Accept Proposal Handler
export async function processProposalAccept(req: any, res: any) {
  const proposalId = req.params.id;
  const authUserId = (req as any).authenticatedUserId;
  const caller = (req as any).authenticatedUser || (await store.getUser(authUserId));
  if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });

  if (!tryAcquireOrderLock(proposalId, res)) return;
  try {
    const result = await postgresStore.executeInTransaction(async (client) => {
      // 1. Lock and validate the proposal
      const propRes = await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);
      if (propRes.rows.length === 0) {
        throw new Error('Proposal not found');
      }
      const r = propRes.rows[0];
      if (r.status !== 'pending') {
        throw new Error(`Proposal is already ${r.status}.`);
      }

      // 2. Lock and validate the project
      const projRes = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [r.project_id]);
      if (projRes.rows.length === 0) {
        throw new Error('Project not found');
      }
      const proj = projRes.rows[0];
      if (proj.buyer_id !== caller.id) {
        throw new Error('Forbidden: Only the project buyer can accept proposals.');
      }
      if (proj.status !== 'open' && proj.status !== 'published' && proj.status !== 'in_progress') {
        throw new Error(`Project is no longer open for proposal acceptance (status: ${proj.status}).`);
      }

      const proposal: Proposal = {
        id: r.id,
        projectId: r.project_id,
        freelancerId: r.freelancer_id,
        freelancerName: r.freelancer_name,
        freelancerAvatar: r.freelancer_avatar || '',
        freelancerTitle: r.freelancer_title || '',
        coverLetter: r.cover_letter || '',
        bidAmount: Number(r.bid_amount),
        deliveryDays: Number(r.delivery_days),
        createdAt: r.created_at,
        status: r.status
      };

      // 3. Create or associate Workspace
      const workspaceId = 'ws_' + randomUUID().slice(0, 12);
      const today = new Date().toISOString().split('T')[0];
      const nowIso = new Date().toISOString();
      await client.query(
        `INSERT INTO workspaces (workspace_id, buyer_id, seller_id, order_ids, title, created_at, updated_at, last_activity_at, metadata)
         VALUES ($1, $2, $3, '[]', $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [
          workspaceId,
          proj.buyer_id,
          proposal.freelancerId,
          proj.title || 'Project Workspace',
          today,
          nowIso,
          nowIso,
          JSON.stringify({ originType: 'project', originId: proj.id, status: 'active' })
        ]
      );

      const workspace = {
        workspaceId,
        buyerId: proj.buyer_id,
        sellerId: proposal.freelancerId,
        originType: 'project' as const,
        originId: proj.id,
        createdAt: today,
        updatedAt: nowIso,
        status: 'active' as const,
        title: proj.title || 'Project Workspace'
      };

      // 4. Create Order row
      const orderId = 'ord_' + randomUUID().slice(0, 12);
      const protectionDays = siteSettings.getSettings().commission.escrowProtectionDays;
      const deliveryDays = proposal.deliveryDays || 7;
      const dueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString().split('T')[0];
      const feeBreakdown = calculateOrderFees(proposal.bidAmount, DEFAULT_FEE_CONFIG);

      const order: Order = {
        id: orderId,
        projectOrderId: orderId,
        workspaceId: workspace.workspaceId,
        orderType: 'project',
        type: 'project',
        title: proj.title,
        buyerId: proj.buyer_id,
        sellerId: proposal.freelancerId,
        amount: proposal.bidAmount,
        status: 'payment_pending',
        createdAt: today,
        dueDate,
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: new Date(Date.now() + protectionDays * 86400000).toISOString().split('T')[0],
        projectId: proj.id,
        proposalId: proposal.id,
        feeBreakdown
      };

      await client.query(
        `INSERT INTO orders (
          id, title, buyer_id, seller_id, amount, status, created_at, due_date,
          workspace_id, project_id, proposal_id, order_type, project_order_id, fee_breakdown
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          order.id, order.title, order.buyerId, order.sellerId, order.amount, 'payment_pending',
          order.createdAt, order.dueDate, order.workspaceId, proj.id, proposal.id, 'project',
          order.id, JSON.stringify(feeBreakdown)
        ]
      );

      // 5. Create WorkstreamOffer
      const offerId = 'off_' + randomUUID().slice(0, 12);
      const offerNum = `PRP-${Date.now().toString().slice(-4)}`;
      const offer: WorkstreamOffer = {
        id: offerId,
        number: offerNum,
        orderId: order.id,
        workspaceId: workspace.workspaceId,
        proposalId: proposal.id,
        kind: 'proposal',
        title: proj.title,
        amount: proposal.bidAmount,
        deliveryDays: proposal.deliveryDays,
        note: proposal.coverLetter ? proposal.coverLetter.slice(0, 1000) : undefined,
        status: 'accepted',
        createdBy: proposal.freelancerId,
        createdAt: nowIso,
        resolvedAt: nowIso,
        resolvedBy: caller.id
      };

      await client.query(
        `INSERT INTO workstream_offers (id, number, order_id, workspace_id, kind, title, amount, delivery_days, status, created_by, created_at, resolved_at, resolved_by, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          offer.id, offer.number, offer.orderId, offer.workspaceId, offer.kind, offer.title,
          offer.amount, offer.deliveryDays, 'accepted', offer.createdBy, offer.createdAt,
          offer.resolvedAt, offer.resolvedBy, JSON.stringify({ proposalId: proposal.id })
        ]
      );

      // 6. Fund Escrow inside this exact PostgreSQL transaction
      await financialTransactionService.fundEscrow({
        orderId: order.id,
        orderTitle: order.title,
        amount: order.amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`,
        idempotencyKey: `IDEMP-ORD-FUND-${order.id}`
      }, client);

      // 7. Update status of order, proposal, and project
      await client.query("UPDATE orders SET status = 'funded_in_escrow' WHERE id = $1", [order.id]);
      order.status = 'funded_in_escrow';

      await client.query(
        'UPDATE proposals SET status = $1, workstream_order_id = $2, offer_id = $3 WHERE id = $4',
        ['accepted', order.id, offer.id, proposal.id]
      );
      proposal.status = 'accepted';
      proposal.workstreamOrderId = order.id;
      proposal.offerId = offer.id;

      await client.query('UPDATE projects SET status = $1 WHERE id = $2', ['in_progress', proj.id]);

      return { proposal, order, workspace, offer, proj };
    });

    // In-memory cache & event emission after transaction commits cleanly
    workspaceService.workspaces.set(result.workspace.workspaceId, result.workspace as any);
    recordOrder(result.order);
    orderIndex.set(result.order.id, result.order);

    emitSystemEvent(result.order.id, 'order_created', `Order placed: ${result.order.title}. Payment is held in escrow until the work is approved.`);
    await postOfferMessage(result.order, result.offer, null, `Proposal ${result.offer.number} was accepted and escrow funded ($${result.order.amount}).`, 'offer_accepted');

    await syncUserBalances();

    createNotification({
      userId: result.proposal.freelancerId,
      type: 'proposal_accepted',
      title: 'Proposal accepted',
      message: `Your proposal for "${result.proj.title}" was accepted and escrow has been funded.`,
      link: `/workstream/${result.order.id}`,
      metadata: { orderId: result.order.id, projectId: result.proj.id, proposalId: result.proposal.id }
    });

    res.json({
      success: true,
      proposal: await enrichProposalWithWorkstream(result.proposal),
      order: enrichOrderWithServiceInfo(result.order),
      workspace: result.workspace,
      offer: await viewOffer(result.offer)
    });
  } catch (err: any) {
    console.error('[ProposalAccept] Transaction failed and rolled back cleanly:', err.message);
    const statusCode = err.message?.includes('not found') ? 404 : (err.message?.includes('Forbidden') ? 403 : 400);
    return res.status(statusCode).json({ error: err.message || 'Failed to accept proposal.' });
  } finally {
    releaseOrderLock(proposalId);
  }
}
  }
}

// Decline Proposal Handler
export async function processProposalDecline(req: any, res: any) {
  const proposalId = req.params.id;
  const propRes = await postgresStore.getPool().query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
  if (propRes.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
  const r = propRes.rows[0];
  const proposal: Proposal = {
    id: r.id,
    projectId: r.project_id,
    freelancerId: r.freelancer_id,
    freelancerName: r.freelancer_name,
    freelancerAvatar: r.freelancer_avatar || '',
    freelancerTitle: r.freelancer_title || '',
    coverLetter: r.cover_letter || '',
    bidAmount: Number(r.bid_amount),
    deliveryDays: Number(r.delivery_days),
    createdAt: r.created_at,
    status: r.status
  };

  const projRes = await postgresStore.getPool().query('SELECT * FROM projects WHERE id = $1', [proposal.projectId]);
  if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
  const proj = projRes.rows[0];

  if (!tryAcquireOrderLock(proposal.id, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (await store.getUser(authUserId));
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });
    if (proj.buyer_id !== caller.id) return res.status(403).json({ error: 'Forbidden: Only the project buyer can decline proposals.' });
    if (proposal.status !== 'pending') return res.status(409).json({ error: `Proposal is already ${proposal.status}.` });

    proposal.status = 'rejected';
    await postgresStore.getPool().query('UPDATE proposals SET status = $1 WHERE id = $2', ['rejected', proposal.id]);

    createNotification({
      userId: proposal.freelancerId,
      type: 'proposal_declined',
      title: 'Proposal declined',
      message: `Your proposal for "${proj.title}" was declined.`,
      link: `/projects/${proj.id}`,
      metadata: { projectId: proj.id, proposalId: proposal.id }
    });

    res.json({ success: true, proposal: await enrichProposalWithWorkstream(proposal) });
  } finally {
    releaseOrderLock(proposal.id);
  }
}

proposalRouter.post('/proposals/:id/accept', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  await processProposalAccept(req, res);
});

proposalRouter.post('/proposals/:id/decline', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  await processProposalDecline(req, res);
});

proposalRouter.post('/proposals/:id/:action(accept|decline)', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  if (req.params.action === 'accept') {
    return await processProposalAccept(req, res);
  } else {
    return await processProposalDecline(req, res);
  }
});

// Admin Proposals Management
proposalRouter.patch('/admin/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const propRes = await postgresStore.getPool().query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    if (propRes.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    const p = propRes.rows[0];

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.coverLetter !== undefined) {
      updates.push(`cover_letter = $${idx++}`);
      values.push(req.body.coverLetter);
    }
    if (req.body.bidAmount !== undefined) {
      updates.push(`bid_amount = $${idx++}`);
      values.push(Number(req.body.bidAmount));
    }
    if (req.body.deliveryDays !== undefined) {
      updates.push(`delivery_days = $${idx++}`);
      values.push(Number(req.body.deliveryDays));
    }
    if (req.body.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(req.body.status);
    }

    if (updates.length > 0) {
      values.push(req.params.id);
      await postgresStore.getPool().query(
        `UPDATE proposals SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: 'PROPOSAL_EDITED',
      target: `Proposal #${p.id}`,
      details: `Updated bid parameters ($${req.body.bidAmount || p.bid_amount}) for freelancer ${p.freelancer_name}`,
      timestamp: new Date().toLocaleString()
    });

    const updated = await postgresStore.getPool().query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update proposal' });
  }
});

proposalRouter.patch('/admin/proposals/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const propRes = await postgresStore.getPool().query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    if (propRes.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    const p = propRes.rows[0];

    const oldStatus = p.status;
    await postgresStore.getPool().query('UPDATE proposals SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: `PROPOSAL_STATUS_${req.body.status.toUpperCase()}`,
      target: `Proposal #${p.id}`,
      details: `Changed proposal status from "${oldStatus}" to "${req.body.status}" for freelancer ${p.freelancer_name}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ ...p, status: req.body.status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update status' });
  }
});

proposalRouter.delete('/admin/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const propRes = await postgresStore.getPool().query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    if (propRes.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    const deleted = propRes.rows[0];

    await postgresStore.getPool().query('DELETE FROM proposals WHERE id = $1', [req.params.id]);
    await postgresStore.getPool().query('UPDATE projects SET proposals_count = GREATEST(0, proposals_count - 1) WHERE id = $1', [deleted.project_id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: 'PROPOSAL_DELETED',
      target: `Proposal #${deleted.id}`,
      details: `Permanently removed proposal #${deleted.id} by freelancer ${deleted.freelancer_name} from project #${deleted.project_id}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, id: deleted.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete proposal' });
  }
});
