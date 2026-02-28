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
    
    // Обновляем статус админа из KV (может измениться)
    const username = await env.USERS_KV.get(`userId:${sessionData.user.id}`);
    if (username) {
      const userData = await env.USERS_KV.get(`user:${username}`);
      if (userData) {
        const userFull = JSON.parse(userData);
        sessionData.user.isAdmin = userFull.isAdmin || false;
        sessionData.user.superAdmin = userFull.superAdmin || false;
      }
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
  const bannedIPs = await env.BANNED_KV.get('banned_ips');
  if (!bannedIPs) return false;
  
  try {
    const banned = JSON.parse(bannedIPs);
    return banned.includes(ip);
  } catch {
    return false;
  }
}

// Проверка, забанен ли пользователь
async function isUserBanned(userId, env) {
  if (!userId) return false;
  const banInfo = await env.BANNED_KV.get(`user:${userId}`);
  return banInfo !== null;
}

// Добавление IP в бан-лист
async function banIP(ip, reason, duration, env) {
  if (!ip || ip === 'unknown') return false;

  const bannedIPs = await env.BANNED_KV.get('banned_ips');
  const banned = bannedIPs ? JSON.parse(bannedIPs) : [];

  if (!banned.includes(ip)) {
    banned.push(ip);
    await env.BANNED_KV.put('banned_ips', JSON.stringify(banned));
  }

  // Сохраняем информацию о бане
  const banInfo = {
    ip,
    reason: reason || 'No reason',
    bannedAt: Date.now(),
    duration: duration || 'permanent',
    expiresAt: duration ? Date.now() + (duration * 1000) : null
  };
  await env.BANNED_KV.put(`ban:${ip}`, JSON.stringify(banInfo));

  return true;
}

// Проверка, является ли пользователь администратором
async function isAdmin(user, env) {
  if (!user || !user.id) return false;
  
  // Получаем данные пользователя из KV
  const username = await env.USERS_KV.get(`userId:${user.id}`);
  if (!username) return false;
  
  const userData = await env.USERS_KV.get(`user:${username}`);
  if (!userData) return false;
  
  try {
    const userFull = JSON.parse(userData);
    // Проверяем поле isAdmin (должно быть true)
    return userFull.isAdmin === true;
  } catch {
    return false;
  }
}

// Назначение/снятие статуса администратора (только для супер-админа)
async function setAdminStatus(userId, isAdminStatus, env) {
  const username = await env.USERS_KV.get(`userId:${userId}`);
  if (!username) return false;
  
  const userData = await env.USERS_KV.get(`user:${username}`);
  if (!userData) return false;
  
  try {
    const userFull = JSON.parse(userData);
    userFull.isAdmin = isAdminStatus === true;
    await env.USERS_KV.put(`user:${username}`, JSON.stringify(userFull));
    return true;
  } catch {
    return false;
  }
}

// Логирование IP адреса пользователя
async function logUserIP(username, ip, env) {
  if (!username || !ip || ip === 'unknown') return;
  
  const now = Date.now();
  const logKey = `ip:${username}`;
  
  // Получаем существующие логи
  const existingLogs = await env.IP_LOGS_KV.get(logKey);
  let logs = existingLogs ? JSON.parse(existingLogs) : [];
  
  // Добавляем новую запись
  logs.push({ ip, timestamp: now });
  
  // Храним последние 100 записей
  if (logs.length > 100) logs = logs.slice(-100);
  
  // Сохраняем с TTL 30 дней
  await env.IP_LOGS_KV.put(logKey, JSON.stringify(logs), { expirationTtl: 30 * 24 * 60 * 60 });
  
  // Также сохраняем обратный индекс IP -> username для поиска
  const ipKey = `ip_rev:${ip}`;
  await env.IP_LOGS_KV.put(ipKey, username, { expirationTtl: 30 * 24 * 60 * 60 });
}

// Получение истории IP пользователя
async function getUserIPLogs(username, env) {
  const logKey = `ip:${username}`;
  const logs = await env.IP_LOGS_KV.get(logKey);
  return logs ? JSON.parse(logs) : [];
}

// Разбан IP
async function unbanIP(ip, env) {
  if (!ip || ip === 'unknown') return false;

  const bannedIPs = await env.BANNED_KV.get('banned_ips');
  if (!bannedIPs) return false;

  const banned = JSON.parse(bannedIPs);
  const newBanned = banned.filter(bannedIP => bannedIP !== ip);
  await env.BANNED_KV.put('banned_ips', JSON.stringify(newBanned));
  await env.BANNED_KV.delete(`ban:${ip}`);

  return true;
}

// Бан пользователя по ID
async function banUser(userId, username, reason, duration, env) {
  if (!userId) return false;

  const banInfo = {
    userId,
    username,
    reason: reason || 'No reason',
    bannedAt: Date.now(),
    duration: duration || 'permanent',
    expiresAt: duration ? Date.now() + (duration * 1000) : null
  };
  await env.BANNED_KV.put(`user:${userId}`, JSON.stringify(banInfo));

  return true;
}

// Разбан пользователя
async function unbanUser(userId, env) {
  if (!userId) return false;
  await env.BANNED_KV.delete(`user:${userId}`);
  return true;
}

// Rate limiting - проверка лимита запросов
async function checkRateLimit(key, limit, window, env) {
  const now = Date.now();
  const windowStart = now - window;
  
  const rateData = await env.USERS_KV.get(`rate:${key}`);
  let requests = rateData ? JSON.parse(rateData) : [];
  
  // Удаляем старые запросы за пределами окна
  requests = requests.filter(timestamp => timestamp > windowStart);
  
  if (requests.length >= limit) {
    return { allowed: false, remaining: 0, resetIn: Math.ceil((requests[0] + window - now) / 1000) };
  }
  
  // Добавляем текущий запрос
  requests.push(now);
  await env.USERS_KV.put(`rate:${key}`, JSON.stringify(requests), { expirationTtl: Math.ceil(window / 1000) + 60 });
  
  return { allowed: true, remaining: limit - requests.length, resetIn: Math.ceil(window / 1000) };
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
    const clientIP = getClientIP(request);
    
    // Rate limit: 5 регистраций в час с одного IP
    const rateLimit = await checkRateLimit(`register:${clientIP}`, 5, 3600000, env);
    if (!rateLimit.allowed) {
      return jsonResponse({ 
        error: `Слишком много попыток регистрации. Попробуйте через ${rateLimit.resetIn} сек` 
      }, 429);
    }
    
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

    // Первый пользователь становится супер-админом
    const isFirstUser = !existingUser && (await env.USERS_KV.list({ prefix: 'user:' })).keys.length === 0;

    const user = {
      id: generateId(),
      username,
      displayName: displayName || username,
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName || username)}&background=random`,
      isAdmin: isFirstUser,
      superAdmin: isFirstUser
    };

    await env.USERS_KV.put(`user:${username}`, JSON.stringify(user));
    await env.USERS_KV.put(`userId:${user.id}`, username);
    await env.USERS_KV.put(`contacts:${user.id}`, JSON.stringify([]));
    
    // Логируем IP при регистрации
    await logUserIP(username, clientIP, env);

    return jsonResponse({ user: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar } }, 201);
  },

  'POST /api/login': async (request, env) => {
    const clientIP = getClientIP(request);
    
    // Rate limit: 10 логинов в час с одного IP
    const rateLimit = await checkRateLimit(`login:${clientIP}`, 10, 3600000, env);
    if (!rateLimit.allowed) {
      return jsonResponse({ 
        error: `Слишком много попыток входа. Попробуйте через ${rateLimit.resetIn} сек` 
      }, 429);
    }
    
    const { username, password } = await request.json();

    if (!username || !password) {
      return jsonResponse({ error: 'Username и password обязательны' }, 400);
    }

    const userStr = await env.USERS_KV.get(`user:${username}`);
    if (!userStr) {
      return jsonResponse({ error: 'Неверный username или password' }, 401);
    }

    const user = JSON.parse(userStr);
    
    // Проверка на бан пользователя
    if (await isUserBanned(user.id, env)) {
      const banInfo = await env.BANNED_KV.get(`user:${user.id}`);
      const banDetails = banInfo ? JSON.parse(banInfo) : {};
      return jsonResponse({ 
        error: 'Ваш аккаунт заблокирован',
        reason: banDetails.reason || 'Неизвестно',
        bannedAt: banDetails.bannedAt
      }, 403);
    }
    
    const passwordHash = await hashPassword(password);

    if (user.passwordHash !== passwordHash) {
      return jsonResponse({ error: 'Неверный username или password' }, 401);
    }

    const token = generateSessionToken();
    const sessionData = {
      user: { 
        id: user.id, 
        username: user.username, 
        displayName: user.displayName, 
        avatar: user.avatar,
        isAdmin: user.isAdmin || false,
        superAdmin: user.superAdmin || false
      },
      expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000)
    };

    await env.SESSIONS_KV.put(token, JSON.stringify(sessionData), { expirationTtl: 30 * 24 * 60 * 60 });

    // Логируем IP при логине
    await logUserIP(username, clientIP, env);

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
    let maxTimestamp = 0;

    for (const contactId of contacts) {
      const contactUsername = await env.USERS_KV.get(`userId:${contactId}`);
      if (contactUsername) {
        const contactStr = await env.USERS_KV.get(`user:${contactUsername}`);
        if (contactStr) {
          const contact = JSON.parse(contactStr);
          const messagesStr = await env.MESSAGES_KV.get(`chat:${[user.id, contact.id].sort().join('_')}`);
          const messages = messagesStr ? JSON.parse(messagesStr) : [];
          const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

          if (lastMessage && lastMessage.timestamp > maxTimestamp) {
            maxTimestamp = lastMessage.timestamp;
          }

          chats.push({
            user: { id: contact.id, username: contact.username, displayName: contact.displayName, avatar: contact.avatar },
            lastMessage,
            unreadCount: 0
          });
        }
      }
    }

    chats.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));

    // ETag для кэширования
    const etag = `"${maxTimestamp}-${chats.length}"`;
    const ifNoneMatch = request.headers.get('If-None-Match');

    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    const response = jsonResponse({ chats });
    response.headers.set('ETag', etag);
    response.headers.set('Cache-Control', 'private, max-age=5');
    return response;
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

    // ETag для кэширования — хэш последнего сообщения
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const etag = lastMsg ? `"${lastMsg.id}-${lastMsg.timestamp}"` : '"empty"';
    const ifNoneMatch = request.headers.get('If-None-Match');

    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    const response = jsonResponse({ messages });
    response.headers.set('ETag', etag);
    response.headers.set('Cache-Control', 'private, max-age=5');
    return response;
  },

  'POST /api/messages/:userId': async (request, env, user, urlParams) => {
    const clientIP = getClientIP(request);
    const userId = user.id;
    
    // Rate limit: 30 сообщений в минуту и 100 в час на пользователя
    const rateLimitMinute = await checkRateLimit(`msg:${userId}:min`, 30, 60000, env);
    if (!rateLimitMinute.allowed) {
      return jsonResponse({ 
        error: `Слишком много сообщений. Попробуйте через ${rateLimitMinute.resetIn} сек` 
      }, 429);
    }
    
    const rateLimitHour = await checkRateLimit(`msg:${userId}:hour`, 100, 3600000, env);
    if (!rateLimitHour.allowed) {
      return jsonResponse({ 
        error: `Превышен лимит сообщений в час. Попробуйте через ${rateLimitHour.resetIn} сек` 
      }, 429);
    }
    
    const targetUserId = urlParams[0];
    const { text } = await request.json();

    if (!text || !text.trim()) {
      return jsonResponse({ error: 'Сообщение не может быть пустым' }, 400);
    }

    if (text.length > 2000) {
      return jsonResponse({ error: 'Сообщение слишком длинное (максимум 2000 символов)' }, 400);
    }

    // Проверка на одинаковые сообщения (спам)
    const chatId = [user.id, targetUserId].sort().join('_');
    const messagesStr = await env.MESSAGES_KV.get(`chat:${chatId}`);
    const messages = messagesStr ? JSON.parse(messagesStr) : [];
    
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    if (lastMessage && lastMessage.senderId === user.id && lastMessage.text === text.trim()) {
      // Возвращаем последнее сообщение вместо дубликата
      return jsonResponse({ message: lastMessage, duplicate: true }, 200);
    }

    const targetUsername = await env.USERS_KV.get(`userId:${targetUserId}`);
    if (!targetUsername) {
      return jsonResponse({ error: 'Пользователь не найден' }, 404);
    }

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
  'POST /api/admin/ban': async (request, env, user, urlParams, headers) => {
    // Проверка на админа через статус в KV
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const { ip, reason, duration } = await request.json();

    if (!ip) {
      return jsonResponse({ error: 'IP адрес обязателен' }, 400);
    }

    const success = await banIP(ip, reason, duration, env);
    return jsonResponse({ success, message: `IP ${ip} забанен` });
  },

  // Admin: Unban IP
  'POST /api/admin/unban': async (request, env, user, urlParams, headers) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const { ip } = await request.json();

    if (!ip) {
      return jsonResponse({ error: 'IP адрес обязателен' }, 400);
    }

    const success = await unbanIP(ip, env);
    return jsonResponse({ success, message: `IP ${ip} разбанен` });
  },

  // Admin: List banned IPs
  'GET /api/admin/bans': async (request, env, user, urlParams, headers) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const bannedIPs = await env.BANNED_KV.get('banned_ips');
    const banned = bannedIPs ? JSON.parse(bannedIPs) : [];

    const banDetails = [];
    for (const ip of banned) {
      const banInfo = await env.BANNED_KV.get(`ban:${ip}`);
      if (banInfo) {
        banDetails.push(JSON.parse(banInfo));
      }
    }

    return jsonResponse({ banned: banDetails });
  },

  // Super Admin: Set admin status
  'POST /api/admin/set-admin': async (request, env, user, urlParams, headers) => {
    // Только супер-админ может назначать админов (первый пользователь или с superAdmin: true)
    const userData = await env.USERS_KV.get(`user:${user.username}`);
    const userFull = userData ? JSON.parse(userData) : null;
    
    if (!userFull || (userFull.isAdmin !== true && userFull.superAdmin !== true)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус супер-администратора' }, 403);
    }

    const { userId, isAdminStatus } = await request.json();

    if (!userId) {
      return jsonResponse({ error: 'userId обязателен' }, 400);
    }

    const success = await setAdminStatus(userId, isAdminStatus, env);
    return jsonResponse({
      success,
      message: `Статус администратора ${isAdminStatus ? 'назначен' : 'снят'}`
    });
  },

  // Admin: Get user IP logs
  'GET /api/admin/ip-logs/:username': async (request, env, user, urlParams) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const username = urlParams[0];
    const logs = await getUserIPLogs(username, env);

    return jsonResponse({ username, logs });
  },

  // Admin: Get username by IP
  'GET /api/admin/ip-lookup/:ip': async (request, env, user, urlParams) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const ip = urlParams[0];
    const ipKey = `ip_rev:${ip}`;
    const username = await env.IP_LOGS_KV.get(ipKey);

    if (!username) {
      return jsonResponse({ error: 'IP не найден в логах' }, 404);
    }

    const logs = await getUserIPLogs(username, env);
    return jsonResponse({ ip, username, logs });
  },

  // Admin: Ban user
  'POST /api/admin/ban-user': async (request, env, user, urlParams) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const { userId, username, reason, duration } = await request.json();

    if (!userId) {
      return jsonResponse({ error: 'userId обязателен' }, 400);
    }

    const success = await banUser(userId, username, reason, duration, env);
    return jsonResponse({ success, message: `Пользователь ${username || userId} забанен` });
  },

  // Admin: Unban user
  'POST /api/admin/unban-user': async (request, env, user, urlParams) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const { userId } = await request.json();

    if (!userId) {
      return jsonResponse({ error: 'userId обязателен' }, 400);
    }

    const success = await unbanUser(userId, env);
    return jsonResponse({ success, message: `Пользователь разбанен` });
  },

  // Admin: List banned users
  'GET /api/admin/banned-users': async (request, env, user, urlParams) => {
    if (!await isAdmin(user, env)) {
      return jsonResponse({ error: 'Доступ запрещён. Требуется статус администратора' }, 403);
    }

    const bannedUsers = [];
    const keys = await env.BANNED_KV.list({ prefix: 'user:' });
    
    for (const key of keys.keys) {
      const banInfo = await env.BANNED_KV.get(key.name);
      if (banInfo) {
        bannedUsers.push(JSON.parse(banInfo));
      }
    }

    return jsonResponse({ banned: bannedUsers });
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
      // Проверка забаненного IP
      const clientIP = getClientIP(request);
      
      // Для логина и регистрации проверяем бан, но разрешаем доступ с сообщением
      if (await isIPBanned(clientIP, env)) {
        if (path === '/api/login') {
          // Разрешаем логин, но проверяем бан пользователя внутри handler
        } else if (path === '/api/register') {
          return jsonResponse({
            error: 'Ваш IP адрес заблокирован',
            code: 'IP_BANNED'
          }, 403);
        } else {
          return jsonResponse({
            error: 'Ваш IP адрес заблокирован',
            code: 'IP_BANNED'
          }, 403);
        }
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
