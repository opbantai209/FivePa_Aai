import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { store, type Message, type Notification } from './store.js';
import { verifyToken, getUserActiveSessions, canAccessOrderWorkstream, isStaffUser } from './middleware/auth.js';
import { recordMessage } from './services/messagingService.js';
import { postgresStore } from './db/postgresStore.js';
import { diagnosticService } from './services/diagnosticService.js';

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

  wss.on('connection', async (ws, request: any) => {
    try {
      clients.add(ws);
      (ws as any).isAuthenticated = false;

      // Check if token was passed in query parameter (e.g. ws://host?token=...)
      const urlStr = request?.url || '';
      const queryIdx = urlStr.indexOf('?');
      let authTimeout: any = undefined;

      if (queryIdx !== -1) {
        const queryParams = new URLSearchParams(urlStr.slice(queryIdx));
        const queryToken = queryParams.get('token');
        if (queryToken) {
          diagnosticService.log('security', 'websocket', 'connection', 'server/websocket.ts', 'query_token_usage', 'INFO', {}, 'WebSocket connection established using token in URL query parameter. This may lead to token leakage in logs.');
          const payload = verifyToken(queryToken);
          if (!payload || !payload.id) {
            try { ws.close(1008, 'Invalid token in query'); } catch {}
            return;
          }
          const userRes = await postgresStore.getPool().query('SELECT * FROM users WHERE id = $1', [payload.id]);
          const dbUser = userRes.rows[0];
          if (!dbUser || dbUser.status !== 'active') {
            try { ws.close(1008, 'Account inactive or suspended'); } catch {}
            return;
          }
          (ws as any).authenticatedUserId = dbUser.id;
          (ws as any).sessionVersion = payload.sessionVersion !== undefined ? payload.sessionVersion : Number(dbUser.session_version || 1);
          (ws as any).isAuthenticated = true;
        }
      }

      if (!(ws as any).isAuthenticated) {
        // Set a timeout to authenticate via AUTHENTICATE message
        const timeoutMs = process.env.NODE_ENV === 'test' ? 1000 : 10000;
        authTimeout = setTimeout(() => {
          if (!(ws as any).isAuthenticated) {
            try { ws.close(1008, 'Authentication timeout'); } catch {}
          }
        }, timeoutMs);
      }

      setupWebSocketHandlers(ws, authTimeout);
    } catch (err) {
      console.error('WS Connection error:', err);
      try { ws.close(1011, 'Server error during connection'); } catch {}
    }
  });

  return wss;
}

export async function broadcastMessage(message: Message, orderId: string) {
  const payload = JSON.stringify({ type: 'MESSAGE_RECEIVED', message });
  const updatePayload = JSON.stringify({
    type: 'WORKSTREAM_UPDATED',
    orderId,
    lastMessage: message.text,
    lastMessageTime: message.timestamp
  });

  const order = await store.getOrder(orderId);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && (client as any).isAuthenticated) {
      const clientUserId = (client as any).authenticatedUserId;
      if (!clientUserId) continue;
      const clientUser = await store.getUser(clientUserId);
      const isAuthorized = !!order && !!clientUser && canAccessOrderWorkstream(clientUser, order);

      if (isAuthorized) {
        try {
          client.send(payload);
          client.send(updatePayload);
        } catch {}
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

function setupWebSocketHandlers(ws: WebSocket, authTimeout?: NodeJS.Timeout) {
  let messageCount = 0;
  let resetTime = Date.now() + 10000;
  let authAttempts = 0;

  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        ws.send(JSON.stringify({ error: 'Binary messages not supported' }));
        return;
      }

      const rawStr = data.toString();
      if (rawStr.length > 10240) {
        diagnosticService.log('security', 'websocket', 'onMessage', 'server/websocket.ts', 'payload_size_check', 'INTERCEPTED', { length: rawStr.length }, 'Oversized WebSocket message payload rejected (> 10KB)');
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
          diagnosticService.log('warning', 'websocket', 'onMessage', 'server/websocket.ts', 'rate_limit', 'INTERCEPTED', { messageCount }, 'WebSocket message rate limit exceeded');
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
          diagnosticService.log('security', 'websocket', 'authenticate', 'server/websocket.ts', 'auth_attempts', 'INTERCEPTED', { authAttempts }, 'Too many authentication attempts');
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
          const userRes = await postgresStore.getPool().query('SELECT * FROM users WHERE id = $1', [payload.id]);
          const dbUser = userRes.rows[0];
          if (dbUser && dbUser.status === 'active') {
            (ws as any).authenticatedUserId = dbUser.id;
            (ws as any).sessionVersion = payload.sessionVersion !== undefined ? payload.sessionVersion : Number(dbUser.session_version || 1);
            (ws as any).isAuthenticated = true;
            if (authTimeout) clearTimeout(authTimeout);

            if (!(ws as any).hasSentConnected) {
              (ws as any).hasSentConnected = true;
              ws.send(JSON.stringify({
                type: 'CONNECTED',
                userId: dbUser.id,
                serverTime: new Date().toISOString()
              }));
            }
            return;
          }
        }

        diagnosticService.log('security', 'websocket', 'authenticate', 'server/websocket.ts', 'verify_token', 'INTERCEPTED', {}, 'Invalid token or inactive account on WebSocket authenticate');
        ws.send(JSON.stringify({ error: 'Invalid token' }));
        try { ws.close(1008, 'Authentication failed'); } catch {}
        return;
      }

      if (!(ws as any).isAuthenticated) {
        ws.send(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      const currentDbUser = await store.getUser((ws as any).authenticatedUserId);
      const wsSessionVer = (ws as any).sessionVersion;
      if (!currentDbUser || currentDbUser.status !== 'active') {
        diagnosticService.log('security', 'websocket', 'checkSession', 'server/websocket.ts', 'account_status', 'INTERCEPTED', { userId: (ws as any).authenticatedUserId }, 'Session invalidated or account inactive on message');
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

      if (parsed.type === 'NEW_MESSAGE') {
        const orderId = parsed.orderId;
        const text = parsed.text;
        if (!orderId) {
          ws.send(JSON.stringify({ error: 'Order ID is required' }));
          return;
        }

        const order = await store.getOrder(orderId);
        if (!order) {
          diagnosticService.log('warning', 'websocket', 'onNewMessage', 'server/websocket.ts', 'order_lookup', 'FAILED', { orderId }, 'Order not found for WebSocket message');
          ws.send(JSON.stringify({ error: 'Order not found' }));
          return;
        }
        if (!canAccessOrderWorkstream(currentDbUser, order)) {
          diagnosticService.log('security', 'websocket', 'onNewMessage', 'server/websocket.ts', 'order_authorization', 'INTERCEPTED', { orderId, userId: currentDbUser.id }, 'Unauthorized user attempted to message on order');
          ws.send(JSON.stringify({ error: 'Unauthorized to send messages in this order' }));
          return;
        }
        if (order.isMuted && !isStaffUser(currentDbUser)) {
          diagnosticService.log('warning', 'websocket', 'onNewMessage', 'server/websocket.ts', 'mute_check', 'INTERCEPTED', { orderId }, 'Chat is currently muted by Administrator');
          ws.send(JSON.stringify({ error: 'Chat is currently muted by Administrator.' }));
          return;
        }

        const newMsg: Message = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          orderId: order.id,
          senderId: currentDbUser.id,
          senderName: currentDbUser.name,
          text: String(text || '').slice(0, 5000),
          timestamp: new Date().toISOString(),
          type: 'message'
        };

        // Persist to PostgreSQL database FIRST before client broadcast
        await store.addMessage(newMsg);
        recordMessage(newMsg);
        await broadcastMessage(newMsg, order.id);

        diagnosticService.log('info', 'websocket', 'onNewMessage', 'server/websocket.ts', 'send_message', 'SUCCESS', { orderId: order.id, messageId: newMsg.id });
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
