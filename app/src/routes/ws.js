const { verifyAccessToken, getSession } = require('../services/auth');

// Connected clients: sessionId -> Set<WebSocket>
const _clients = new Map();

// Fix #5: use proper cookie parsing instead of fragile manual split
// Cookie values can contain '=' (e.g. base64), so only split on the first '='
function _getToken(req) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 'access_token') return val;
  }
  return null;
}

async function wsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const token = _getToken(req);

    if (!token) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    let sessionId;
    try {
      sessionId = await verifyAccessToken(token);
      const session = getSession(sessionId);
      if (!session) throw new Error('Session revoked');
    } catch {
      socket.close(4001, 'Unauthorized');
      return;
    }

    if (!_clients.has(sessionId)) _clients.set(sessionId, new Set());
    _clients.get(sessionId).add(socket);

    socket.on('close', () => {
      const set = _clients.get(sessionId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) _clients.delete(sessionId);
      }
      clearInterval(ping);
    });

    socket.on('error', () => socket.close());

    // Ping to keep connection alive
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      } else {
        clearInterval(ping);
      }
    }, 25000);
  });
}

// Broadcast to all connected clients
function broadcast(type, data = {}) {
  const msg = JSON.stringify({ type, ...data });
  for (const set of _clients.values()) {
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) {
        socket.send(msg);
      }
    }
  }
}

module.exports = { wsRoutes, broadcast };
