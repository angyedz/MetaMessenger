// Локальный сервер для разработки с проксированием API на Cloudflare Worker
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const WORKER_URL = 'https://meta-messenger.lilo35382.workers.dev';

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Проксирование API запросов на Cloudflare Worker
  if (url.pathname.startsWith('/api/')) {
    proxyToWorker(req, res, url);
    return;
  }
  
  // Статические файлы
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

function proxyToWorker(req, res, url) {
  const workerPath = url.pathname + url.search;
  const workerUrl = WORKER_URL + workerPath;
  
  const headers = {
    ...req.headers,
    host: 'meta-messenger.lilo35382.workers.dev'
  };
  delete headers.connection;
  delete headers.referer;
  
  const options = {
    hostname: 'meta-messenger.lilo35382.workers.dev',
    port: 443,
    path: workerPath,
    method: req.method,
    headers: headers
  };
  
  const proxyReq = https.request(options, (proxyRes) => {
    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
  });
  
  req.pipe(proxyReq);
}

// HTTPS для проксирования
const https = require('https');

server.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен: http://localhost:${PORT}`);
  console.log(`📡 API проксируется на: ${WORKER_URL}`);
  console.log(`\nОткройте http://localhost:${PORT} в браузере\n`);
});
