// Meta Messenger - Frontend JavaScript

// URL Cloudflare Worker API (замените на ваш после деплоя)
// Для локальной разработки: http://localhost:3000
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
    this.bindEvents();
    
    if (this.token && this.user) {
      this.showMainScreen();
      this.loadChats();
      this.startPolling();
    } else {
      this.showAuthScreen();
    }
  }
  
  bindEvents() {
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
  }
  
  switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    
    document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
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
      document.getElementById('login-error').textContent = '';
    } catch (error) {
      document.getElementById('login-error').textContent = error.message;
    }
  }
  
  async handleRegister(e) {
    e.preventDefault();
    
    const username = document.getElementById('register-username').value;
    const displayName = document.getElementById('register-display-name').value;
    const password = document.getElementById('register-password').value;
    
    try {
      const data = await this.apiRequest('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username, displayName, password })
      });
      
      // Auto login after registration
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
      document.getElementById('register-error').textContent = '';
    } catch (error) {
      document.getElementById('register-error').textContent = error.message;
    }
  }
  
  async handleLogout() {
    try {
      await this.apiRequest('/api/logout', { method: 'POST' });
    } catch (e) {
      // Ignore logout errors
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
      console.log('Search URL:', url);
      const data = await this.apiRequest(url);
      console.log('Search results:', data);

      // Клонируем узел, чтобы удалить старые обработчики событий
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

      // Заменяем старый контейнер на новый
      resultsContainer.parentNode.replaceChild(newContainer, resultsContainer);

      // Добавляем обработчик на новый контейнер
      newContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-add');
        if (btn) {
          e.stopPropagation();
          const userId = btn.getAttribute('data-user-id');
          if (userId) {
            this.addContact(userId);
          }
        }
      });

      newContainer.classList.remove('hidden');
    } catch (error) {
      console.error('Search error:', error);
    }
  }
  
  async addContact(userId) {
    console.log('Adding contact:', userId);
    try {
      const url = `/api/contacts/${userId}`;
      console.log('Request URL:', url);
      const data = await this.apiRequest(url, { method: 'POST' });
      console.log('Add contact response:', data);
      await this.loadChats();
      document.getElementById('search-results').classList.add('hidden');
      document.getElementById('user-search').value = '';
    } catch (error) {
      console.error('Add contact error:', error);
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
      container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Нет чатов</p>';
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
    
    // Bind click events
    container.querySelectorAll('.chat-item').forEach(item => {
      item.addEventListener('click', () => this.openChat(item.dataset.userId));
    });
  }
  
  async openChat(userId) {
    this.currentChat = userId;
    
    // Update active state
    document.querySelectorAll('.chat-item').forEach(item => {
      item.classList.toggle('active', item.dataset.userId === userId);
    });
    
    // Show chat container
    document.getElementById('no-chat-selected').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    // Load chat info
    try {
      const chatsData = await this.apiRequest('/api/chats');
      const chat = chatsData.chats.find(c => c.user.id === userId);
      
      if (chat) {
        document.getElementById('chat-user-avatar').src = chat.user.avatar;
        document.getElementById('chat-user-name').textContent = chat.user.displayName;
      }
      
      // Load messages
      await this.loadMessages(userId);
      
      // Mark as read
      await this.apiRequest(`/api/messages/${userId}/read`, { method: 'POST' });
      
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
    
    container.innerHTML = messages.map(msg => {
      const isOutgoing = msg.senderId === this.user.id;
      const time = this.formatTime(msg.timestamp);
      
      return `
        <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}">
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
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }
  
  async sendMessage(e) {
    e.preventDefault();
    
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (!text || !this.currentChat) return;
    
    try {
      const data = await this.apiRequest(`/api/messages/${this.currentChat}`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      
      input.value = '';
      
      // Reload messages
      await this.loadMessages(this.currentChat);
      await this.loadChats();
      
    } catch (error) {
      console.error('Send message error:', error);
      alert('Ошибка отправки сообщения: ' + error.message);
    }
  }
  
  startPolling() {
    // Poll for new messages every 3 seconds
    this.pollingInterval = setInterval(() => {
      if (this.currentChat) {
        this.loadMessages(this.currentChat);
      }
      this.loadChats();
    }, 3000);
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
    
    // Less than a minute
    if (diff < 60000) {
      return 'только что';
    }
    
    // Less than an hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} мин назад`;
    }
    
    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} ч назад`;
    }
    
    // Show time
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  window.messenger = new MetaMessenger();
});
