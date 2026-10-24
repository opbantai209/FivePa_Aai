import { randomUUID } from 'node:crypto';
import { Workspace, Order } from '../types.js';
import { postgresStore } from '../../server/db/postgresStore.js';

class WorkspaceService {
  private workspaces: Map<string, Workspace> = new Map();

  public loadFromList(list: any[]) {
    if (Array.isArray(list)) {
      this.workspaces.clear();
      for (const w of list) {
        if (w?.workspaceId) this.workspaces.set(w.workspaceId, w);
      }
    }
  }

  public async hydrateFromPostgres(): Promise<void> {
    try {
      const list = await postgresStore.listWorkspaces();
      this.loadFromList(list);
    } catch (err) {
      console.error('[WorkspaceService] Failed to hydrate workspaces from PostgreSQL:', err);
    }
  }

  public listAll(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  public async listAllAsync(): Promise<Workspace[]> {
    const dbList = await postgresStore.listWorkspaces();
    this.loadFromList(dbList);
    return Array.from(this.workspaces.values());
  }

  public async persistWorkspace(workspace: Workspace): Promise<void> {
    try {
      await postgresStore.saveWorkspace(workspace);
    } catch (err) {
      console.error(`[WorkspaceService] Failed to persist workspace ${workspace.workspaceId} to PostgreSQL:`, err);
      throw err;
    }
  }

  public saveToDisk() {
    const list = Array.from(this.workspaces.values());
    postgresStore.saveWorkspaces(list).catch(err => {
      console.error('[WorkspaceService] Failed to persist workspaces to PostgreSQL:', err);
    });
  }

  public async createWorkspaceAsync(params: {
    buyerId: string;
    sellerId: string;
    originType: 'gig' | 'project';
    originId: string;
    activeOrderId?: string;
    title?: string;
  }): Promise<Workspace> {
    const workspaceId = 'ws_' + randomUUID().slice(0, 12);
    const createdAt = new Date().toISOString().split('T')[0];
    const workspace: Workspace & { title?: string; updatedAt?: string } = {
      workspaceId,
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      originType: params.originType,
      originId: params.originId,
      createdAt,
      updatedAt: new Date().toISOString(),
      status: 'active',
      activeOrderId: params.activeOrderId,
      title: params.title || params.originId
    };
    this.workspaces.set(workspaceId, workspace);
    await this.persistWorkspace(workspace);
    return workspace;
  }

  public createWorkspace(params: {
    buyerId: string;
    sellerId: string;
    originType: 'gig' | 'project';
    originId: string;
    activeOrderId?: string;
    title?: string;
  }): Workspace {
    const workspaceId = 'ws_' + randomUUID().slice(0, 12);
    const createdAt = new Date().toISOString().split('T')[0];
    const workspace: Workspace & { title?: string; updatedAt?: string } = {
      workspaceId,
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      originType: params.originType,
      originId: params.originId,
      createdAt,
      updatedAt: new Date().toISOString(),
      status: 'active',
      activeOrderId: params.activeOrderId,
      title: params.title || params.originId
    };
    this.workspaces.set(workspaceId, workspace);
    this.persistWorkspace(workspace).catch(() => {});
    return workspace;
  }

  public getWorkspace(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  public async getWorkspaceAsync(workspaceId: string): Promise<Workspace | undefined> {
    const dbList = await postgresStore.listWorkspaces();
    this.loadFromList(dbList);
    return this.workspaces.get(workspaceId);
  }

  public getWorkspacesForUser(userId: string): Workspace[] {
    return Array.from(this.workspaces.values()).filter(w => w.buyerId === userId || w.sellerId === userId);
  }

  public async getWorkspacesForUserAsync(userId: string): Promise<Workspace[]> {
    await this.hydrateFromPostgres();
    return this.getWorkspacesForUser(userId);
  }

  public findWorkspaceByOrder(orderId: string, orders: Order[]): Workspace | undefined {
    const order = orders.find(o => o.id === orderId);
    if (!order) return undefined;
    // Authoritative relationship: Order.workspaceId -> Workspace
    if (order.workspaceId) {
      return this.workspaces.get(order.workspaceId);
    }
    return undefined;
  }

  public async ensureWorkspaceForOrderAsync(order: Order): Promise<Workspace> {
    let ws: (Workspace & { title?: string; updatedAt?: string }) | undefined;

    if (order.workspaceId && this.workspaces.has(order.workspaceId)) {
      ws = this.workspaces.get(order.workspaceId)!;
    } else if (order.workspaceId) {
      const dbWsList = await postgresStore.listWorkspaces();
      this.loadFromList(dbWsList);
      ws = this.workspaces.get(order.workspaceId);
    }

    if (ws) {
      if (!ws.activeOrderId) ws.activeOrderId = order.id;
      ws.updatedAt = new Date().toISOString();
      await this.persistWorkspace(ws);
      order.workspaceId = ws.workspaceId;
      return ws;
    }

    const originType = order.projectId ? 'project' : 'gig';
    const originId = order.projectId || order.gigId || order.id;

    ws = await this.createWorkspaceAsync({
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      originType,
      originId,
      activeOrderId: order.id,
      title: order.title || originId
    });

    order.workspaceId = ws.workspaceId;
    return ws;
  }

  public ensureWorkspaceForOrder(order: Order): Workspace {
    let ws: (Workspace & { title?: string; updatedAt?: string }) | undefined;

    if (order.workspaceId && this.workspaces.has(order.workspaceId)) {
      ws = this.workspaces.get(order.workspaceId)!;
    }

    if (ws) {
      if (!ws.activeOrderId) ws.activeOrderId = order.id;
      ws.updatedAt = new Date().toISOString();
      this.persistWorkspace(ws).catch(() => {});
      order.workspaceId = ws.workspaceId;
      return ws;
    }

    const originType = order.projectId ? 'project' : 'gig';
    const originId = order.projectId || order.gigId || order.id;

    ws = this.createWorkspace({
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      originType,
      originId,
      activeOrderId: order.id,
      title: order.title || originId
    });

    order.workspaceId = ws.workspaceId;
    return ws;
  }
      originType,
      originId,
      activeOrderId: order.id,
      title: order.title || originId
    });

    order.workspaceId = ws.workspaceId;
    return ws;
  }

  public migrateLegacyOrders(orders: Order[], dryRun: boolean = false): { migratedCount: number; dryRun: boolean; details: string[] } {
    let migratedCount = 0;
    const details: string[] = [];
    for (const o of orders) {
      if (!o.workspaceId || !this.workspaces.has(o.workspaceId)) {
        migratedCount++;
        if (!dryRun) {
          const ws = this.ensureWorkspaceForOrder(o);
          details.push(`Migrated order ${o.id} to dedicated workspace ${ws.workspaceId}`);
        } else {
          details.push(`[DryRun] Would migrate order ${o.id} to dedicated workspace`);
        }
      }
    }
    return { migratedCount, dryRun, details };
  }

  public deleteWorkspace(workspaceId: string) {
    if (this.workspaces.delete(workspaceId)) {
      postgresStore.deleteWorkspace(workspaceId).catch(err => {
        console.error(`[WorkspaceService] Failed to delete workspace ${workspaceId} from PostgreSQL:`, err);
      });
    }
  }
}

export const workspaceService = new WorkspaceService();

