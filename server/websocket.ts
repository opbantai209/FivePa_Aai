import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { users, orders, type Message, type Notification } from './store.js';
import { verifyToken, getUserActiveSessions, canAccessOrderWorkstream } from './middleware/auth.js';

export const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

const wsConnectionBuckets = new Map<string, { count: number; resetAt: number }>();
function checkWsIpRateLimit(ip: string, max = 50, windowMs = 60000): boolean {
  const now = Date.now();
  const record = wsConnectionBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count++;
  wsConnectionBuckets.set(ip, record);
  return record.count <= max;
}

export function initWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const xff = request.headers['x-forwarded-for'];
    const parts = (Array.isArray(xff) ? xff.join(',') : (xff || '')).split(',').map(s => s.trim()).filter(Boolean);
    const ip = parts.length ? parts[parts.length - 1] : (request.socket.remoteAddress || 'unknown');
    if (!checkWsIpRateLimit(ip)) {
      console.warn(`[Security] WebSocket connection attempt from ${ip} rejected: rate limit exceeded.`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    
    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('error', (err) => {
    console.error('WSS Server error:', err);
  });

  wss.on('connection', (ws) => {
    try {
      clients.add(ws);
      (ws as any).isAuthenticated = false;

      // Set a timeout to authenticate. If no valid AUTHENTICATE message is received within 10 seconds, close.
      const authTimeout = setTimeout(() => {
        if (!(ws as any).isAuthenticated) {
          try { ws.close(1008, 'Authentication timeout'); } catch {}
        }
      }, 10000);

      setupWebSocketHandlers(ws, authTimeout);
    } catch (err) {
      console.error('WS Connection error:', err);
      try { ws.close(1011, 'Server error during connection'); } catch {}
    }
  });

  return wss;
}

export function broadcastMessage(message: Message, orderId: string) {
  const payload = JSON.stringify({ type: 'MESSAGE_RECEIVED', message });
  const updatePayload = JSON.stringify({
    type: 'WORKSTREAM_UPDATED',
    orderId,
    lastMessage: message.text,
    lastMessageTime: message.timestamp
  });

  const order = orders.find(o => o.id === orderId);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && (client as any).isAuthenticated) {
      const clientUserId = (client as any).authenticatedUserId;
      if (!clientUserId) continue;
      const clientUser = users.find(u => u.id === clientUserId);
      const isAuthorized = !!order && canAccessOrderWorkstream(clientUser, order);

      if (isAuthorized) {
        client.send(payload);
        client.send(updatePayload);
      }
    }
  }
}

export function broadcastNotificationToUser(userId: string, notification: Notification) {
  for (const client of clients) {
    if ((client as any).isAuthenticated && (client as any).authenticatedUserId === userId && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'NOTIFICATION', notification }));
      } catch {}
    }
  }
}

export function disconnectUserSockets(userId: string, reason = 'Session invalidated') {
  for (const client of clients) {
    if ((client as any).authenticatedUserId === userId) {
      try { client.close(4401, reason); } catch {}
    }
  }
}

export function disconnectUserSessionSocket(userId: string, sessionVersion: number, reason = 'Session expired (max 3 devices)') {
  for (const client of clients) {
    if ((client as any).authenticatedUserId === userId && (client as any).sessionVersion === sessionVersion) {
      try { client.close(4401, reason); } catch {}
    }
  }
}

function setupWebSocketHandlers(ws: WebSocket, authTimeout: NodeJS.Timeout) {
  let messageCount = 0;
  let resetTime = Date.now() + 10000;
  let authAttempts = 0;

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        ws.send(JSON.stringify({ error: 'Binary messages not supported' }));
        return;
      }

      const rawStr = data.toString();
      if (rawStr.length > 51200) {
        ws.send(JSON.stringify({ error: 'Message payload exceeds maximum allowed size' }));
        return;
      }

      const now = Date.now();
      if (now > resetTime) {
        messageCount = 1;
        resetTime = now + 10000;
      } else {
        messageCount++;
        if (messageCount > 30) {
          ws.send(JSON.stringify({ error: 'Rate limit exceeded. Please slow down.' }));
          return;
        }
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      if (parsed.type === 'AUTHENTICATE') {
        authAttempts++;
        if (authAttempts > 3) {
          ws.send(JSON.stringify({ error: 'Too many authentication attempts' }));
          try { ws.close(1008, 'Too many auth attempts'); } catch {}
          return;
        }

        const token = parsed.token;
        if (!token) {
          ws.send(JSON.stringify({ error: 'Token is required' }));
          return;
        }

        const payload = verifyToken(token);
        if (payload && payload.id) {
          const dbUser = users.find(u => u.id === payload.id);
          if (dbUser && dbUser.status === 'active') {
            (ws as any).authenticatedUserId = dbUser.id;
            (ws as any).sessionVersion = payload.sessionVersion !== undefined ? payload.sessionVersion : dbUser.sessionVersion;
            (ws as any).isAuthenticated = true;
            clearTimeout(authTimeout);

            ws.send(JSON.stringify({
              type: 'CONNECTED',
              userId: dbUser.id,
              serverTime: new Date().toISOString()
            }));
            return;
          }
        }

        ws.send(JSON.stringify({ error: 'Invalid token' }));
        try { ws.close(1008, 'Authentication failed'); } catch {}
        return;
      }

      if (!(ws as any).isAuthenticated) {
        ws.send(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      const currentDbUser = users.find(u => u.id === (ws as any).authenticatedUserId);
      const wsSessionVer = (ws as any).sessionVersion;
      if (!currentDbUser || currentDbUser.status !== 'active') {
        try { ws.close(1008, 'Session invalidated or account inactive'); } catch {}
        return;
      }
      if (wsSessionVer !== undefined) {
        const activeSessions = getUserActiveSessions(currentDbUser);
        if (!activeSessions.includes(wsSessionVer) && wsSessionVer !== currentDbUser.sessionVersion) {
          try { ws.close(1008, 'Session invalidated or evicted (max 3 devices)'); } catch {}
          return;
        }
      }

      if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
        return;
      }
    } catch (e) {
      console.error('WS message processing error:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
}
