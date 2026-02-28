// Meta Messenger - Modern Glassmorphism UI
// URL Cloudflare Worker API
const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://meta-messenger.lilo35382.workers.dev';

class MetaMessenger {
  constructor() {
    this.token = localStorage.getItem('messenger_token');
    this.user = JSON.parse(localStorage.getItem('messenger_user') || 'null');
    this.currentChat = null;
    this.pollingInterval = null;
    this.init();
  }

  init() {
    this.loadTheme();
    this.bindEvents();

    if (this.token && this.user) {
      this.showMainScreen();
      this.loadChats();
      this.startPolling();
    } else {
      this.showAuthScreen();
    }
  }

  loadTheme() {
    const theme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  }

  bindEvents() {
    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

    // Auth tabs
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', (e) => this.switchAuthTab(e.target.dataset.tab));
    });

    // Forms
    document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));
    document.getElementById('register-form').addEventListener('submit', (e) => this.handleRegister(e));

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => this.handleLogout());

    // Search
    document.getElementById('user-search').addEventListener('input', (e) => this.searchUsers(e.target.value));

    // Message form
    document.getElementById('message-form').addEventListener('submit', (e) => this.sendMessage(e));

    // Message character counter
    document.getElementById('message-input').addEventListener('input', (e) => this.updateMessageCounter(e.target.value.length));

    // Admin panel
    document.getElementById('admin-panel-btn')?.addEventListener('click', () => this.toggleAdminPanel());
    document.getElementById('admin-panel-close')?.addEventListener('click', () => this.toggleAdminPanel());
    document.getElementById('ban-user-btn')?.addEventListener('click', () => this.banUser());
    document.getElementById('ban-ip-btn')?.addEventListener('click', () => this.banIP());
    document.getElementById('ip-lookup-btn')?.addEventListener('click', () => this.lookupIP());
    document.getElementById('refresh-banned-btn')?.addEventListener('click', () => this.loadBannedIPs());
  }

  switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

    document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
    
    // Clear errors
    document.getElementById('login-error').classList.add('hidden');
    document.getElementById('register-error').classList.add('hidden');
  }

  async apiRequest(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.token && { 'Authorization': `Bearer ${this.token}` })
    };

    const apiUrl = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
    const response = await fetch(apiUrl, {
      ...options,
      headers: { ...headers, ...options.headers }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  }

  async handleLogin(e) {
    e.preventDefault();

    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
      const data = await this.apiRequest('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      this.token = data.token;
      this.user = data.user;

      localStorage.setItem('messenger_token', data.token);
      localStorage.setItem('messenger_user', JSON.stringify(data.user));

      this.showMainScreen();
      this.loadChats();
      this.startPolling();

      document.getElementById('login-form').reset();
      document.getElementById('login-error').classList.add('hidden');
    } catch (error) {
      const errorEl = document.getElementById('login-error');
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
    }
  }

  async handleRegister(e) {
    e.preventDefault();

    const username = document.getElementById('register-username').value;
    const displayName = document.getElementById('register-display-name').value;
    const password = document.getElementById('register-password').value;

    try {
      await this.apiRequest('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username, displayName, password })
      });

      const loginData = await this.apiRequest('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      this.token = loginData.token;
      this.user = loginData.user;

      localStorage.setItem('messenger_token', loginData.token);
      localStorage.setItem('messenger_user', JSON.stringify(loginData.user));

      this.showMainScreen();
      this.loadChats();
      this.startPolling();

      document.getElementById('register-form').reset();
      document.getElementById('register-error').classList.add('hidden');
    } catch (error) {
      const errorEl = document.getElementById('register-error');
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
    }
  }

  async handleLogout() {
    try {
      await this.apiRequest('/api/logout', { method: 'POST' });
    } catch (e) {
      // Ignore
    }

    this.token = null;
    this.user = null;
    this.currentChat = null;

    localStorage.removeItem('messenger_token');
    localStorage.removeItem('messenger_user');

    this.stopPolling();
    this.showAuthScreen();
  }

  showAuthScreen() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('hidden');
  }

  showMainScreen() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');

    document.getElementById('current-user-avatar').src = this.user.avatar;
    document.getElementById('current-user-name').textContent = this.user.displayName;

    // Show admin badge and button if admin
    const isAdmin = this.user.isAdmin || this.user.superAdmin;
    document.getElementById('admin-badge').classList.toggle('hidden', !isAdmin);
    document.getElementById('admin-panel-btn').classList.toggle('hidden', !isAdmin);
  }

  toggleAdminPanel() {
    const panel = document.getElementById('admin-panel');
    panel.classList.toggle('hidden');
    
    if (!panel.classList.contains('hidden')) {
      this.loadBannedIPs();
    }
  }

  async searchUsers(query) {
    const resultsContainer = document.getElementById('search-results');

    if (!query || query.length < 2) {
      resultsContainer.classList.add('hidden');
      resultsContainer.innerHTML = '';
      return;
    }

    try {
      const url = `/api/users/search?q=${encodeURIComponent(query)}`;
      const data = await this.apiRequest(url);

      const newContainer = resultsContainer.cloneNode(false);

      if (data.users.length === 0) {
        newContainer.innerHTML = '<div class="search-result-item" style="cursor: default;">Пользователи не найдены</div>';
      } else {
        newContainer.innerHTML = data.users.map(user => `
          <div class="search-result-item" data-user-id="${user.id}">
            <img src="${user.avatar}" alt="${user.displayName}" class="avatar">
            <div class="search-result-info">
              <div class="search-result-name">${user.displayName}</div>
              <div class="search-result-username">@${user.username}</div>
            </div>
            <button class="btn-add" data-user-id="${user.id}">Добавить</button>
          </div>
        `).join('');
      }

      resultsContainer.parentNode.replaceChild(newContainer, resultsContainer);

      newContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-add');
        if (btn) {
          e.stopPropagation();
          const userId = btn.getAttribute('data-user-id');
          if (userId) this.addContact(userId);
        }
      });

      newContainer.classList.remove('hidden');
    } catch (error) {
      console.error('Search error:', error);
    }
  }

  async addContact(userId) {
    try {
      await this.apiRequest(`/api/contacts/${userId}`, { method: 'POST' });
      await this.loadChats();
      document.getElementById('search-results').classList.add('hidden');
      document.getElementById('user-search').value = '';
    } catch (error) {
      alert('Ошибка добавления контакта: ' + error.message);
    }
  }

  async loadChats() {
    try {
      const data = await this.apiRequest('/api/chats');
      this.renderChats(data.chats);
    } catch (error) {
      console.error('Load chats error:', error);
    }
  }

  renderChats(chats) {
    const container = document.getElementById('chats-container');

    if (chats.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Нет чатов</p>';
      return;
    }

    container.innerHTML = chats.map(chat => {
      const lastMessage = chat.lastMessage;
      const time = lastMessage ? this.formatTime(lastMessage.timestamp) : '';
      const preview = lastMessage ? (lastMessage.text.length > 30 ? lastMessage.text.substring(0, 30) + '...' : lastMessage.text) : '';

      return `
        <div class="chat-item" data-user-id="${chat.user.id}">
          <img src="${chat.user.avatar}" alt="${chat.user.displayName}" class="avatar">
          <div class="chat-item-info">
            <div class="chat-item-name">${chat.user.displayName}</div>
            <div class="chat-item-last-message">${lastMessage ? (lastMessage.senderId === this.user.id ? 'Вы: ' : '') + preview : ''}</div>
          </div>
          <div class="chat-item-time">${time}</div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.chat-item').forEach(item => {
      item.addEventListener('click', () => this.openChat(item.dataset.userId));
    });
  }

  async openChat(userId) {
    this.currentChat = userId;

    document.querySelectorAll('.chat-item').forEach(item => {
      item.classList.toggle('active', item.dataset.userId === userId);
    });

    document.getElementById('no-chat-selected').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');

    try {
      const chatsData = await this.apiRequest('/api/chats');
      const chat = chatsData.chats.find(c => c.user.id === userId);

      if (chat) {
        document.getElementById('chat-user-avatar').src = chat.user.avatar;
        document.getElementById('chat-user-name').textContent = chat.user.displayName;
      }

      await this.loadMessages(userId);
      await this.apiRequest(`/api/messages/${userId}/read`, { method: 'POST' });
      this.updateMessageCounter(0);
    } catch (error) {
      console.error('Open chat error:', error);
    }
  }

  async loadMessages(userId) {
    try {
      const data = await this.apiRequest(`/api/messages/${userId}`);
      this.renderMessages(data.messages);
    } catch (error) {
      console.error('Load messages error:', error);
    }
  }

  renderMessages(messages) {
    const container = document.getElementById('messages-container');
    const existingMessages = container.querySelectorAll('.message');

    // Если сообщений нет или первое новое - рендерим всё
    if (existingMessages.length === 0) {
      container.innerHTML = messages.map(msg => {
        const isOutgoing = msg.senderId === this.user.id;
        const time = this.formatTime(msg.timestamp);

        return `
          <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}" data-message-id="${msg.id}">
            <img src="${msg.senderAvatar}" alt="${msg.senderName}" class="message-avatar">
            <div class="message-content">
              <div class="message-bubble">${this.escapeHtml(msg.text)}</div>
              <div class="message-meta">
                <span class="message-time">${time}</span>
                ${isOutgoing && msg.read ? '<span class="message-read">✓✓</span>' : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');
      container.scrollTop = container.scrollHeight;
      return;
    }

    // Получаем ID существующих сообщений
    const existingIds = new Set(Array.from(existingMessages).map(el => el.dataset.messageId));

    // Находим новые сообщения
    const newMessages = messages.filter(msg => !existingIds.has(msg.id));

    if (newMessages.length === 0) {
      // Проверяем статус прочтения для исходящих
      messages.forEach(msg => {
        if (msg.senderId === this.user.id && msg.read) {
          const el = container.querySelector(`[data-message-id="${msg.id}"] .message-read`);
          if (!el) {
            const messageEl = container.querySelector(`[data-message-id="${msg.id}"] .message-meta`);
            if (messageEl && !messageEl.querySelector('.message-read')) {
              messageEl.innerHTML += '<span class="message-read">✓✓</span>';
            }
          }
        }
      });
      return;
    }

    // Добавляем только новые сообщения
    const scrollContainer = container;
    const wasScrolledToBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 50;

    newMessages.forEach(msg => {
      const isOutgoing = msg.senderId === this.user.id;
      const time = this.formatTime(msg.timestamp);

      const messageEl = document.createElement('div');
      messageEl.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
      messageEl.dataset.messageId = msg.id;
      messageEl.innerHTML = `
        <img src="${msg.senderAvatar}" alt="${msg.senderName}" class="message-avatar">
        <div class="message-content">
          <div class="message-bubble">${this.escapeHtml(msg.text)}</div>
          <div class="message-meta">
            <span class="message-time">${time}</span>
            ${isOutgoing && msg.read ? '<span class="message-read">✓✓</span>' : ''}
          </div>
        </div>
      `;
      container.appendChild(messageEl);
    });

    if (wasScrolledToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  async sendMessage(e) {
    e.preventDefault();

    const input = document.getElementById('message-input');
    const text = input.value.trim();

    if (!text || !this.currentChat) return;

    try {
      await this.apiRequest(`/api/messages/${this.currentChat}`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });

      input.value = '';
      this.updateMessageCounter(0);

      await this.loadMessages(this.currentChat);
      await this.loadChats();
    } catch (error) {
      console.error('Send message error:', error);
      alert('Ошибка отправки сообщения: ' + error.message);
    }
  }

  updateMessageCounter(length) {
    const counter = document.getElementById('message-counter');
    if (counter) {
      counter.textContent = `${length}/2000`;
      counter.classList.toggle('warning', length > 1800);
      counter.classList.toggle('error', length > 2000);
    }
  }

  // Admin functions
  async banUser() {
    const userId = document.getElementById('ban-user-id').value.trim();
    const username = document.getElementById('ban-username').value.trim();
    const reason = document.getElementById('ban-reason').value.trim();
    let duration = parseInt(document.getElementById('ban-duration').value) || 0;

    if (!userId) {
      alert('Введите User ID');
      return;
    }

    if (duration <= 0) duration = null;

    try {
      await this.apiRequest('/api/admin/ban-user', {
        method: 'POST',
        body: JSON.stringify({ userId, username, reason, duration })
      });
      alert(`Пользователь ${username || userId} забанен!`);
      this.loadBannedIPs();
    } catch (error) {
      alert('Ошибка: ' + error.message);
    }
  }

  async banIP() {
    const ip = document.getElementById('ban-ip-address').value.trim();
    const reason = document.getElementById('ban-ip-reason').value.trim();
    let duration = parseInt(document.getElementById('ban-ip-duration').value) || 0;

    if (!ip) {
      alert('Введите IP адрес');
      return;
    }

    if (duration <= 0) duration = null;

    try {
      await this.apiRequest('/api/admin/ban', {
        method: 'POST',
        body: JSON.stringify({ ip, reason, duration })
      });
      alert(`IP ${ip} забанен!`);
      this.loadBannedIPs();
    } catch (error) {
      alert('Ошибка: ' + error.message);
    }
  }

  async lookupIP() {
    const username = document.getElementById('ip-lookup-username').value.trim();
    const resultDiv = document.getElementById('ip-lookup-result');

    if (!username) {
      alert('Введите username');
      return;
    }

    try {
      const data = await this.apiRequest(`/api/admin/ip-logs/${username}`);
      
      if (!data.logs || data.logs.length === 0) {
        resultDiv.innerHTML = '<p style="padding: 15px; color: var(--text-muted);">IP логи не найдены</p>';
      } else {
        resultDiv.innerHTML = `
          <div style="padding: 10px 15px; background: var(--surface); border-radius: 12px; margin-bottom: 10px;">
            <strong>Username:</strong> ${data.username}<br>
            <strong>Записей:</strong> ${data.logs.length}
          </div>
          ${data.logs.slice(-10).reverse().map(log => `
            <div class="admin-list-item">
              <div class="admin-list-info">
                <div class="admin-list-title">${log.ip}</div>
                <div class="admin-list-subtitle">${new Date(log.timestamp).toLocaleString('ru-RU')}</div>
              </div>
              <button class="btn-small danger" onclick="document.getElementById('ban-ip-address').value='${log.ip}'">
                Бан
              </button>
            </div>
          `).join('')}
        `;
      }
      resultDiv.classList.remove('hidden');
    } catch (error) {
      alert('Ошибка: ' + error.message);
    }
  }

  async loadBannedIPs() {
    try {
      const data = await this.apiRequest('/api/admin/bans');
      const listDiv = document.getElementById('banned-list');

      if (!data.banned || data.banned.length === 0) {
        listDiv.innerHTML = '<p style="padding: 15px; color: var(--text-muted);">Нет забаненных IP</p>';
      } else {
        listDiv.innerHTML = data.banned.map(ban => `
          <div class="admin-list-item">
            <div class="admin-list-info">
              <div class="admin-list-title">${ban.ip}</div>
              <div class="admin-list-subtitle">${ban.reason || 'Без причины'} • ${ban.duration ? new Date(ban.expiresAt).toLocaleString('ru-RU') : 'Навсегда'}</div>
            </div>
            <button class="btn-small success" onclick="messenger.unbanIP('${ban.ip}')">
              Разбан
            </button>
          </div>
        `).join('');
      }
    } catch (error) {
      console.error('Load banned IPs error:', error);
    }
  }

  async unbanIP(ip) {
    try {
      await this.apiRequest('/api/admin/unban', {
        method: 'POST',
        body: JSON.stringify({ ip })
      });
      this.loadBannedIPs();
    } catch (error) {
      alert('Ошибка: ' + error.message);
    }
  }

  startPolling() {
    this.pollingInterval = setInterval(() => {
      if (this.currentChat) {
        this.loadMessages(this.currentChat);
      }
      this.loadChats();
    }, 1000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Make messenger accessible globally for inline handlers
window.messenger = null;

document.addEventListener('DOMContentLoaded', () => {
  window.messenger = new MetaMessenger();
});
