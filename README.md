# Meta Messenger

Мессенджер на Cloudflare Workers с хранением данных в Cloudflare KV.

## Возможности

- ✅ Регистрация и аутентификация пользователей
- ✅ Поиск и добавление контактов
- ✅ Отправка и получение сообщений
- ✅ Статус прочтения сообщений
- ✅ Хранение всех данных в Cloudflare KV
- ✅ Современный UI в стиле Meta/Facebook Messenger

## Структура проекта

```
Meta Messenger/
├── wrangler.toml          # Конфигурация Wrangler
├── src/
│   └── worker.js          # Cloudflare Worker (backend API)
├── public/
│   ├── index.html         # HTML frontend
│   ├── styles.css         # CSS стили
│   └── app.js             # JavaScript frontend
└── README.md              # Документация
```

## Требования

- Node.js 18+
- Аккаунт Cloudflare
- Wrangler CLI

## Установка

### 1. Установите Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Авторизуйтесь в Cloudflare

```bash
wrangler login
```

### 3. Создайте KV namespaces

Выполните команды для создания трёх KV хранилищ:

```bash
wrangler kv:namespace create MESSAGES_KV
wrangler kv:namespace create USERS_KV
wrangler kv:namespace create SESSIONS_KV
```

После создания каждой команды вы получите ID namespace. Скопируйте их.

### 4. Обновите wrangler.toml

Откройте файл `wrangler.toml` и замените placeholder ID на реальные:

```toml
[[kv_namespaces]]
binding = "MESSAGES_KV"
id = "скопированный_id_1"

[[kv_namespaces]]
binding = "USERS_KV"
id = "скопированный_id_2"

[[kv_namespaces]]
binding = "SESSIONS_KV"
id = "скопированный_id_3"
```

## Запуск

### Локальная разработка

```bash
wrangler dev
```

Приложение будет доступно по адресу `http://localhost:8787`

### Деплой

```bash
wrangler deploy
```

После деплоя приложение будет доступно по вашему `.workers.dev` домену.

## API Endpoints

### Аутентификация

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/register` | Регистрация нового пользователя |
| POST | `/api/login` | Вход в систему |
| POST | `/api/logout` | Выход из системы |
| GET | `/api/me` | Получить текущий профиль |

### Контакты и чаты

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/users/search?q=query` | Поиск пользователей |
| POST | `/api/contacts/:userId` | Добавить контакт |
| GET | `/api/chats` | Список чатов |

### Сообщения

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/messages/:userId` | Получить сообщения чата |
| POST | `/api/messages/:userId` | Отправить сообщение |
| POST | `/api/messages/:userId/read` | Пометить как прочитанное |
| DELETE | `/api/messages/:messageId` | Удалить сообщение |

## Структура данных в KV

### USERS_KV

- `user:{username}` - данные пользователя
- `userId:{id}` - маппинг ID → username
- `contacts:{userId}` - список контактов пользователя

### MESSAGES_KV

- `chat:{sortedUserId1}_{sortedUserId2}` - сообщения чата

### SESSIONS_KV

- `{sessionToken}` - данные сессии (TTL 30 дней)

## Безопасность

- Пароли хешируются с солью (SHA-256)
- Сессии хранятся в KV с TTL
- Требуется Bearer токен для защищённых endpoints

## Ограничения

- Максимум 1000 сообщений в чате (старые удаляются)
- Сессия действительна 30 дней
- Поиск возвращает до 20 пользователей

## Технологии

- **Backend:** Cloudflare Workers (JavaScript)
- **Database:** Cloudflare KV
- **Frontend:** Vanilla JS, CSS (отдельные файлы в `/public`)
- **Deploy:** Wrangler

## Лицензия

MIT
