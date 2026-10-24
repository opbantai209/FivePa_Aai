import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  proposals,
  projects,
  orders,
  users,
  workstreamOffers,
  messages,
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
import { financeLedger } from '../../src/server/financeLedger.js';
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
  registerAuditLog
} from '../services/orderService.js';
import { postOfferMessage, viewOffer } from '../services/workstreamService.js';

export const proposalRouter = Router();

export function enrichProposalWithWorkstream(p: Proposal): Proposal {
  let workstreamOrderId = p.workstreamOrderId;
  let offerId = p.offerId;
  if (!workstreamOrderId) {
    const matchedOrder = orders.find(o => o.proposalId === p.id);
    if (matchedOrder) workstreamOrderId = matchedOrder.id;
  }
  if (!offerId && workstreamOrderId) {
    const matchedOffer = workstreamOffers.find(of => of.proposalId === p.id) ||
      workstreamOffers.find(of => of.orderId === workstreamOrderId && of.kind === 'proposal');
    if (matchedOffer) offerId = matchedOffer.id;
  }
  return {
    ...p,
    ...(workstreamOrderId ? { workstreamOrderId } : {}),
    ...(offerId ? { offerId } : {})
  };
}

// Proposals list
proposalRouter.get('/proposals', (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req);
  if (!authUserId) {
    return res.json([]);
  }
  const caller = users.find(u => u.id === authUserId);
  const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';
  const userProposals = proposals.filter(p =>
    isAdmin ||
    p.freelancerId === authUserId ||
    projects.some(pr => pr.id === p.projectId && pr.buyerId === authUserId));
  res.json(userProposals.map(enrichProposalWithWorkstream));
});

// Submit proposal
proposalRouter.post('/proposals', requireAuth, requireActiveStatus, rateLimit(30, 60_000), (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot submit new proposals while your account is restricted.' });

  const proj = projects.find(p => p.id === req.body.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });
  if (!['open', 'published', 'in_progress'].includes(proj.status)) {
    return res.status(400).json({ error: 'This project is completed and closed to new proposals.' });
  }
  if (proj.buyerId === caller.id) {
    return res.status(400).json({ error: 'You cannot submit a proposal to your own project.' });
  }
  const bidAmount = Math.round(Number(req.body.bidAmount) * 100) / 100;
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
    return res.status(400).json({ error: 'Enter a valid USD bid amount.' });
  }
  const deliveryDays = Math.max(1, Math.min(365, Math.round(Number(req.body.deliveryDays) || 7)));

  const newProp: Proposal = {
    id: 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    projectId: req.body.projectId,
    freelancerId: caller.id,
    freelancerName: caller.name,
    freelancerAvatar: caller.avatar,
    freelancerTitle: caller.title || 'Senior Engineer',
    coverLetter: typeof req.body.coverLetter === 'string' ? req.body.coverLetter.trim().slice(0, 5000) : '',
    bidAmount,
    deliveryDays,
    createdAt: new Date().toISOString().split('T')[0],
    status: 'pending'
  };
  proposals.unshift(newProp);
  proj.proposalsCount += 1;
  postgresStore.saveProjects(projects);
  postgresStore.saveProposals(proposals);

  createNotification({
    userId: proj.buyerId,
    type: 'proposal',
    title: 'New Proposal Received',
    message: `${caller.name} submitted a $${bidAmount} proposal for your project "${proj.title}".`,
    link: `/projects/${proj.id}`,
    dedupKey: `proposal_${newProp.id}`,
    actorId: caller.id
  });

  res.json(newProp);
});

// Accept Proposal Handler
export async function processProposalAccept(req: any, res: any) {
  const proposalId = req.params.id;
  const proposal = proposals.find(p => p.id === proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  const proj = projects.find(p => p.id === proposal.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  if (!tryAcquireOrderLock(proposal.id, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || users.find((u: any) => u.id === authUserId);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });
    if (proj.buyerId !== caller.id) return res.status(403).json({ error: 'Forbidden: Only the project buyer can accept proposals.' });
    if (proj.status !== 'open' && proj.status !== 'published' && proj.status !== 'in_progress') {
      return res.status(409).json({ error: `Project is no longer open for proposal acceptance (status: ${proj.status}).` });
    }
    if (proposal.status !== 'pending') {
      if (proposal.status === 'accepted' && proposal.workstreamOrderId) {
        const existingOrder = orders.find(o => o.id === proposal.workstreamOrderId);
        if (existingOrder) {
          const workspace = workspaceService.getWorkspace(existingOrder.workspaceId || '');
          const offer = workstreamOffers.find(of => of.proposalId === proposal.id);
          return res.json({
            success: true,
            proposal: enrichProposalWithWorkstream(proposal),
            order: enrichOrderWithServiceInfo(existingOrder),
            workspace,
            offer: offer ? viewOffer(offer) : undefined
          });
        }
      }
      return res.status(409).json({ error: `Proposal is already ${proposal.status}.` });
    }

    ensureWallet(proj.buyerId);
    ensureWallet(proposal.freelancerId);

    let workspace = Array.from(workspaceService.getWorkspacesForUser(proj.buyerId)).find(w =>
      w.sellerId === proposal.freelancerId &&
      w.originType === 'project' &&
      w.originId === proj.id
    );
    let createdNewWorkspace = false;
    if (!workspace) {
      workspace = workspaceService.createWorkspace({
        buyerId: proj.buyerId,
        sellerId: proposal.freelancerId,
        originType: 'project',
        originId: proj.id
      });
      createdNewWorkspace = true;
    }

    const orderId = 'ord_' + randomUUID().slice(0, 12);
    const today = new Date().toISOString().split('T')[0];
    const protectionDays = siteSettings.getSettings().commission.escrowProtectionDays;
    const deliveryDays = proposal.deliveryDays || 7;
    const dueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString().split('T')[0];

    const order: Order = {
      id: orderId,
      projectOrderId: orderId,
      workspaceId: workspace.workspaceId,
      orderType: 'project',
      title: proj.title,
      buyerId: proj.buyerId,
      sellerId: proposal.freelancerId,
      amount: proposal.bidAmount,
      status: 'payment_pending',
      createdAt: today,
      dueDate,
      escrowProtectionStartDate: today,
      escrowProtectionEndDate: new Date(Date.now() + protectionDays * 86400000).toISOString().split('T')[0],
      projectId: proj.id,
      proposalId: proposal.id,
      feeBreakdown: financeLedger.quoteOrder(proposal.bidAmount)
    };

    const offer: WorkstreamOffer = {
      id: 'off_' + randomUUID().slice(0, 12),
      number: `PRP-${String(workstreamOffers.filter(o => o.kind === 'proposal').length + 1001)}`,
      orderId: order.id,
      proposalId: proposal.id,
      kind: 'proposal',
      title: proj.title,
      amount: proposal.bidAmount,
      deliveryDays: proposal.deliveryDays,
      note: proposal.coverLetter ? proposal.coverLetter.slice(0, 1000) : undefined,
      status: 'pending',
      createdBy: proposal.freelancerId,
      createdAt: new Date().toISOString()
    };
    workstreamOffers.push(offer);
    await postgresStore.saveOffers(workstreamOffers);

    recordOrder(order);
    await postgresStore.saveOrders(orders);
    emitSystemEvent(order.id, 'order_created', `Order placed: ${order.title}. Payment is held in escrow until the work is approved.`);
    postOfferMessage(order, offer, null, `Proposal ${offer.number} was created.`, 'offer_created');

    try {
      fundOrderEscrowWithEvent({
        orderId: order.id,
        orderTitle: order.title,
        amount: order.amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`
      });

      order.status = 'funded_in_escrow';
      await postgresStore.saveOrders(orders);
    } catch (fundingErr: any) {
      const orderIdx = orders.findIndex(o => o.id === order.id);
      if (orderIdx !== -1) orders.splice(orderIdx, 1);
      orderIndex.delete(order.id);

      const offerIdx = workstreamOffers.findIndex(o => o.id === offer.id);
      if (offerIdx !== -1) workstreamOffers.splice(offerIdx, 1);
      postgresStore.saveOffers(workstreamOffers).catch(err => console.error('[OfferRollback] Failed to persist:', err));

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].orderId === order.id) {
          messages.splice(i, 1);
        }
      }

      proposal.status = 'pending';
      delete proposal.workstreamOrderId;
      delete proposal.offerId;

      if (createdNewWorkspace) {
        workspaceService.deleteWorkspace(workspace.workspaceId);
      }

      await postgresStore.saveOrders(orders);
      await postgresStore.saveOffers(workstreamOffers);
      await postgresStore.saveProposals(proposals);
      await postgresStore.saveMessages(messages);

      return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for proposal.' });
    }

    proposal.status = 'accepted';
    proposal.workstreamOrderId = order.id;
    proposal.offerId = offer.id;
    await postgresStore.saveProposals(proposals);

    syncUserBalances();

    offer.status = 'accepted';
    offer.resolvedAt = new Date().toISOString();
    offer.resolvedBy = caller.id;
    await postgresStore.saveOffers(workstreamOffers);

    postOfferMessage(order, offer, null, `Proposal ${offer.number} was accepted and escrow funded ($${order.amount}).`, 'offer_accepted');

    createNotification({
      userId: proposal.freelancerId,
      type: 'proposal_accepted',
      title: 'Proposal accepted',
      message: `Your proposal for "${proj.title}" was accepted and escrow has been funded.`,
      link: `/workstream/${order.id}`,
      metadata: { orderId: order.id, projectId: proj.id, proposalId: proposal.id }
    });

    res.json({ success: true, proposal: enrichProposalWithWorkstream(proposal), order: enrichOrderWithServiceInfo(order), workspace, offer: viewOffer(offer) });
  } finally {
    releaseOrderLock(proposal.id);
  }
}

// Decline Proposal Handler
export async function processProposalDecline(req: any, res: any) {
  const proposalId = req.params.id;
  const proposal = proposals.find(p => p.id === proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  const proj = projects.find(p => p.id === proposal.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  if (!tryAcquireOrderLock(proposal.id, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || users.find((u: any) => u.id === authUserId);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });
    if (proj.buyerId !== caller.id) return res.status(403).json({ error: 'Forbidden: Only the project buyer can decline proposals.' });
    if (proposal.status !== 'pending') return res.status(409).json({ error: `Proposal is already ${proposal.status}.` });

    proposal.status = 'rejected';
    await postgresStore.saveProposals(proposals);

    createNotification({
      userId: proposal.freelancerId,
      type: 'proposal_declined',
      title: 'Proposal declined',
      message: `Your proposal for "${proj.title}" was declined.`,
      link: `/projects/${proj.id}`,
      metadata: { projectId: proj.id, proposalId: proposal.id }
    });

    res.json({ success: true, proposal: enrichProposalWithWorkstream(proposal) });
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
  const p = proposals.find(prop => prop.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Proposal not found' });

  if (req.body.coverLetter !== undefined) p.coverLetter = req.body.coverLetter;
  if (req.body.bidAmount !== undefined) p.bidAmount = Number(req.body.bidAmount);
  if (req.body.deliveryDays !== undefined) p.deliveryDays = Number(req.body.deliveryDays);
  if (req.body.status !== undefined) p.status = req.body.status;

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'PROPOSAL_EDITED',
    target: `Proposal #${p.id}`,
    details: `Updated bid parameters ($${p.bidAmount}), delivery days (${p.deliveryDays}d), or status (${p.status}) for freelancer ${p.freelancerName}`,
    timestamp: new Date().toLocaleString()
  });
  await postgresStore.saveProposals(proposals);
  res.json(p);
});

proposalRouter.patch('/admin/proposals/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const p = proposals.find(prop => prop.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Proposal not found' });

  const oldStatus = p.status;
  p.status = req.body.status;

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: `PROPOSAL_STATUS_${req.body.status.toUpperCase()}`,
    target: `Proposal #${p.id}`,
    details: `Changed proposal status from "${oldStatus}" to "${req.body.status}" for freelancer ${p.freelancerName}`,
    timestamp: new Date().toLocaleString()
  });

  await postgresStore.saveProposals(proposals);
  res.json(p);
});

proposalRouter.delete('/admin/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
  const index = proposals.findIndex(prop => prop.id === req.params.id);
  if (!index === -1) return res.status(404).json({ error: 'Proposal not found' });

  const deleted = proposals[index];
  proposals.splice(index, 1);

  const proj = projects.find(p => p.id === deleted.projectId);
  if (proj && proj.proposalsCount > 0) {
    proj.proposalsCount -= 1;
    await postgresStore.saveProjects(projects);
  }
  await postgresStore.saveProposals(proposals);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: 'PROPOSAL_DELETED',
    target: `Proposal #${deleted.id}`,
    details: `Permanently removed proposal #${deleted.id} by freelancer ${deleted.freelancerName} from project #${deleted.projectId}`,
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, id: deleted.id });
});
