/**
 * Meta Messenger - Cloudflare Worker
 * Мессенджер с хранением данных в Cloudflare KV
 */

// Генерация уникальных ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Хеширование пароля
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'meta-messenger-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Генерация токена сессии
function generateSessionToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Проверка авторизации
async function getAuthenticatedUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const session = await env.SESSIONS_KV.get(token);

  if (!session) {
    return null;
  }

  try {
    const sessionData = JSON.parse(session);
    if (sessionData.expiresAt < Date.now()) {
      await env.SESSIONS_KV.delete(token);
      return null;
    }
    return sessionData.user;
  } catch {
    return null;
  }
}

// Получение IP адреса клиента
function getClientIP(request) {
  const cfConnectingIP = request.headers.get('CF-Connecting-IP');
  const xRealIP = request.headers.get('X-Real-IP');
  const xForwardedFor = request.headers.get('X-Forwarded-For');
  
  if (cfConnectingIP) return cfConnectingIP;
  if (xRealIP) return xRealIP;
  if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
  return 'unknown';
}

// Проверка, забанен ли IP
async function isIPBanned(ip, env) {
  if (!ip || ip === 'unknown') return false;
  const bannedIPs = await env.USERS_KV.get('banned_ips');
  if (!bannedIPs) return false;
  
  try {
    const banned = JSON.parse(bannedIPs);
    return banned.includes(ip);
  } catch {
    return false;
  }
}

// Добавление IP в бан-лист
async function banIP(ip, reason, duration, env) {
  if (!ip || ip === 'unknown') return false;
  
  const bannedIPs = await env.USERS_KV.get('banned_ips');
  const banned = bannedIPs ? JSON.parse(bannedIPs) : [];
  
  if (!banned.includes(ip)) {
    banned.push(ip);
    await env.USERS_KV.put('banned_ips', JSON.stringify(banned));
  }
  
  // Сохраняем информацию о бане
  const banInfo = {
    ip,
    reason: reason || 'No reason',
    bannedAt: Date.now(),
    duration: duration || 'permanent',
    expiresAt: duration ? Date.now() + (duration * 1000) : null
  };
  await env.USERS_KV.put(`ban:${ip}`, JSON.stringify(banInfo));
  
  return true;
}

// Разбан IP
async function unbanIP(ip, env) {
  if (!ip || ip === 'unknown') return false;
  
  const bannedIPs = await env.USERS_KV.get('banned_ips');
  if (!bannedIPs) return false;
  
  const banned = JSON.parse(bannedIPs);
  const newBanned = banned.filter(bannedIP => bannedIP !== ip);
  await env.USERS_KV.put('banned_ips', JSON.stringify(newBanned));
  await env.USERS_KV.delete(`ban:${ip}`);
  
  return true;
}

// JSON response helper
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

// CORS preflight
function handleCorsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  });
}

// API Handlers
const apiHandlers = {
  'POST /api/register': async (request, env) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    const { username, password, displayName } = body;

    if (!username || !password) {
      return jsonResponse({ error: 'Username и password обязательны' }, 400);
    }
    
    const existingUser = await env.USERS_KV.get(`user:${username}`);
    if (existingUser) {
      return jsonResponse({ error: 'Пользователь уже существует' }, 409);
    }
    
    const user = {
      id: generateId(),
      username,
      displayName: displayName || username,
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName || username)}&background=random`
    };

    await env.USERS_KV.put(`user:${username}`, JSON.stringify(user));
    await env.USERS_KV.put(`userId:${user.id}`, username);
    await env.USERS_KV.put(`contacts:${user.id}`, JSON.stringify([]));

    return jsonResponse({ user: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar } }, 201);
  },

  'POST /api/login': async (request, env) => {
    const { username, password } = await request.json();
    
    if (!username || !password) {
      return jsonResponse({ error: 'Username и password обязательны' }, 400);
    }
    
    const userStr = await env.USERS_KV.get(`user:${username}`);
    if (!userStr) {
      return jsonResponse({ error: 'Неверный username или password' }, 401);
    }
    
    const user = JSON.parse(userStr);
    const passwordHash = await hashPassword(password);
    
    if (user.passwordHash !== passwordHash) {
      return jsonResponse({ error: 'Неверный username или password' }, 401);
    }
    
    const token = generateSessionToken();
    const sessionData = {
      user: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar },
      expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000)
    };
    
    await env.SESSIONS_KV.put(token, JSON.stringify(sessionData), { expirationTtl: 30 * 24 * 60 * 60 });
    
    return jsonResponse({ token, user: sessionData.user, expiresAt: sessionData.expiresAt });
  },

  'POST /api/logout': async (request, env, user) => {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      await env.SESSIONS_KV.delete(token);
    }
    return jsonResponse({ success: true });
  },

  'GET /api/me': async (request, env, user) => {
    return jsonResponse({ user });
  },

  'GET /api/users/search': async (request, env, user) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';

    if (!query) {
      return jsonResponse({ users: [] });
    }

    const keys = await env.USERS_KV.list({ prefix: 'user:' });
    const users = [];

    for (const key of keys.keys) {
      // Ключи вида 'user:username', проверяем что это не 'user:id' или 'contacts:id'
      if (key.name.startsWith('user:') && !key.name.includes(':', 5)) {
        const userStr = await env.USERS_KV.get(key.name);
        if (userStr) {
          const u = JSON.parse(userStr);
          if (u.username !== user.username &&
              (u.username.toLowerCase().includes(query.toLowerCase()) ||
               u.displayName.toLowerCase().includes(query.toLowerCase()))) {
            users.push({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar });
          }
        }
      }
    }

    return jsonResponse({ users: users.slice(0, 20) });
  },

  'GET /api/chats': async (request, env, user) => {
    const contactsStr = await env.USERS_KV.get(`contacts:${user.id}`);
    const contacts = contactsStr ? JSON.parse(contactsStr) : [];
    
    const chats = [];
    for (const contactId of contacts) {
      const contactUsername = await env.USERS_KV.get(`userId:${contactId}`);
      if (contactUsername) {
        const contactStr = await env.USERS_KV.get(`user:${contactUsername}`);
        if (contactStr) {
          const contact = JSON.parse(contactStr);
          const messagesStr = await env.MESSAGES_KV.get(`chat:${[user.id, contact.id].sort().join('_')}`);
          const messages = messagesStr ? JSON.parse(messagesStr) : [];
          const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
          
          chats.push({
            user: { id: contact.id, username: contact.username, displayName: contact.displayName, avatar: contact.avatar },
            lastMessage,
            unreadCount: 0
          });
        }
      }
    }
    
    chats.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
    return jsonResponse({ chats });
  },

  'POST /api/contacts/:userId': async (request, env, user, urlParams) => {
    const targetUserId = urlParams[0];
    console.log('Adding contact:', targetUserId, 'urlParams:', urlParams);
    const targetUsername = await env.USERS_KV.get(`userId:${targetUserId}`);
    console.log('Found username:', targetUsername);
    if (!targetUsername) {
      return jsonResponse({ error: 'Пользователь не найден' }, 404);
    }
    
    const contactsStr = await env.USERS_KV.get(`contacts:${user.id}`);
    const contacts = contactsStr ? JSON.parse(contactsStr) : [];
    
    if (!contacts.includes(targetUserId)) {
      contacts.push(targetUserId);
      await env.USERS_KV.put(`contacts:${user.id}`, JSON.stringify(contacts));
    }
    
    const targetContactsStr = await env.USERS_KV.get(`contacts:${targetUserId}`);
    const targetContacts = targetContactsStr ? JSON.parse(targetContactsStr) : [];
    if (!targetContacts.includes(user.id)) {
      targetContacts.push(user.id);
      await env.USERS_KV.put(`contacts:${targetUserId}`, JSON.stringify(targetContacts));
    }
    
    return jsonResponse({ success: true });
  },

  'GET /api/messages/:userId': async (request, env, user, urlParams) => {
    const targetUserId = urlParams[0];
    const chatId = [user.id, targetUserId].sort().join('_');
    const messagesStr = await env.MESSAGES_KV.get(`chat:${chatId}`);
    const messages = messagesStr ? JSON.parse(messagesStr) : [];
    return jsonResponse({ messages });
  },

  'POST /api/messages/:userId': async (request, env, user, urlParams) => {
    const targetUserId = urlParams[0];
    const { text } = await request.json();

    if (!text || !text.trim()) {
      return jsonResponse({ error: 'Сообщение не может быть пустым' }, 400);
    }

    if (text.length > 2000) {
      return jsonResponse({ error: 'Сообщение слишком длинное (максимум 2000 символов)' }, 400);
    }

    const targetUsername = await env.USERS_KV.get(`userId:${targetUserId}`);
    if (!targetUsername) {
      return jsonResponse({ error: 'Пользователь не найден' }, 404);
    }

    const chatId = [user.id, targetUserId].sort().join('_');
    const messagesStr = await env.MESSAGES_KV.get(`chat:${chatId}`);
    const messages = messagesStr ? JSON.parse(messagesStr) : [];

    const message = {
      id: generateId(),
      text: text.trim(),
      senderId: user.id,
      senderName: user.displayName,
      senderAvatar: user.avatar,
      timestamp: Date.now(),
      read: false
    };

    messages.push(message);
    if (messages.length > 1000) messages.shift();

    await env.MESSAGES_KV.put(`chat:${chatId}`, JSON.stringify(messages));
    return jsonResponse({ message }, 201);
  },

  'POST /api/messages/:userId/read': async (request, env, user, urlParams) => {
    const targetUserId = urlParams[0];
    const chatId = [user.id, targetUserId].sort().join('_');
    const messagesStr = await env.MESSAGES_KV.get(`chat:${chatId}`);
    if (messagesStr) {
      const messages = JSON.parse(messagesStr);
      let changed = false;
      for (const msg of messages) {
        if (msg.senderId === targetUserId && !msg.read) {
          msg.read = true;
          changed = true;
        }
      }
      if (changed) await env.MESSAGES_KV.put(`chat:${chatId}`, JSON.stringify(messages));
    }
    return jsonResponse({ success: true });
  },

  'DELETE /api/messages/:messageId': async (request, env, user, urlParams) => {
    const messageId = urlParams[0];
    const contactsStr = await env.USERS_KV.get(`contacts:${user.id}`);
    const contacts = contactsStr ? JSON.parse(contactsStr) : [];
    
    for (const contactId of contacts) {
      const chatId = [user.id, contactId].sort().join('_');
      const messagesStr = await env.MESSAGES_KV.get(`chat:${chatId}`);
      if (messagesStr) {
        const messages = JSON.parse(messagesStr);
        const msgIndex = messages.findIndex(m => m.id === messageId && m.senderId === user.id);
        if (msgIndex !== -1) {
          messages.splice(msgIndex, 1);
          await env.MESSAGES_KV.put(`chat:${chatId}`, JSON.stringify(messages));
          return jsonResponse({ success: true });
        }
      }
    }
    return jsonResponse({ error: 'Сообщение не найдено' }, 404);
  },

  // Admin: Ban IP
  'POST /api/admin/ban': async (request, env, user) => {
    // Проверка на админа (можно добавить проверку роли)
    const adminUsernames = ['admin']; // Замените на username админа
    if (!adminUsernames.includes(user.username)) {
      return jsonResponse({ error: 'Доступ запрещён' }, 403);
    }

    const { ip, reason, duration } = await request.json();

    if (!ip) {
      return jsonResponse({ error: 'IP адрес обязателен' }, 400);
    }

    const success = await banIP(ip, reason, duration, env);
    return jsonResponse({ success, message: `IP ${ip} забанен` });
  },

  // Admin: Unban IP
  'POST /api/admin/unban': async (request, env, user) => {
    const adminUsernames = ['admin'];
    if (!adminUsernames.includes(user.username)) {
      return jsonResponse({ error: 'Доступ запрещён' }, 403);
    }

    const { ip } = await request.json();

    if (!ip) {
      return jsonResponse({ error: 'IP адрес обязателен' }, 400);
    }

    const success = await unbanIP(ip, env);
    return jsonResponse({ success, message: `IP ${ip} разбанен` });
  },

  // Admin: List banned IPs
  'GET /api/admin/bans': async (request, env, user) => {
    const adminUsernames = ['admin'];
    if (!adminUsernames.includes(user.username)) {
      return jsonResponse({ error: 'Доступ запрещён' }, 403);
    }

    const bannedIPs = await env.USERS_KV.get('banned_ips');
    const banned = bannedIPs ? JSON.parse(bannedIPs) : [];

    const banDetails = [];
    for (const ip of banned) {
      const banInfo = await env.USERS_KV.get(`ban:${ip}`);
      if (banInfo) {
        banDetails.push(JSON.parse(banInfo));
      }
    }

    return jsonResponse({ banned: banDetails });
  }
};

// Основной обработчик
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // API routes
    if (path.startsWith('/api/')) {
      // Проверка забаненного IP (кроме публичных эндпоинтов)
      const clientIP = getClientIP(request);
      const isPublicRoute = path === '/api/register' || path === '/api/login';
      
      if (!isPublicRoute && await isIPBanned(clientIP, env)) {
        return jsonResponse({ 
          error: 'Ваш IP адрес заблокирован',
          code: 'IP_BANNED'
        }, 403);
      }

      try {
        let handler = null;
        let urlParams = [];

        for (const [route, handlerFunc] of Object.entries(apiHandlers)) {
          const [handlerMethod, handlerPath] = route.split(' ');
          if (handlerMethod !== method) continue;

          // Убираем начальный '/' и разбиваем на части
          const routeParts = handlerPath.slice(1).split('/');
          const pathParts = path.slice(1).split('/');

          if (routeParts.length !== pathParts.length) continue;

          let matches = true;
          urlParams = [];

          for (let i = 0; i < routeParts.length; i++) {
            if (routeParts[i].startsWith(':')) {
              urlParams.push(pathParts[i]);
            } else if (routeParts[i] !== pathParts[i]) {
              matches = false;
              break;
            }
          }

          if (matches) {
            handler = handlerFunc;
            break;
          }
        }

        if (!handler) {
          console.log('Handler not found for:', method, path);
          return jsonResponse({ error: 'Not Found' }, 404);
        }

        let user = null;
        const isPublicRoute = path === '/api/register' || path === '/api/login';

        if (!isPublicRoute) {
          user = await getAuthenticatedUser(request, env);
          if (!user) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
        }

        return await handler(request, env, user, urlParams);
      } catch (error) {
        console.error('API Error:', method, path, error);
        return jsonResponse({ error: error.message || 'Internal Server Error' }, 500);
      }
    }

    // Static assets
    if (path === '/' || path === '/index.html' || path === '/styles.css' || path === '/app.js') {
      try {
        const assetPath = path === '/' ? '/index.html' : path;
        const assetUrl = new URL(assetPath, 'http://assets.local');
        const assetResponse = await env.ASSETS.fetch(assetUrl);
        if (assetResponse.ok) return assetResponse;
      } catch (e) {
        console.error('Asset error:', e);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
