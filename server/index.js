'use strict';

// Entry point: a plain HTTP server for the client files plus a WebSocket
// endpoint on the same port for the game protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 8080;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const file = path.join(CLIENT_DIR, path.normalize(rel));
  if (!file.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const game = new Game();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      game.handle(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
    }
  });
  ws.on('close', () => game.leave(ws));
  ws.on('error', () => {});
});

process.on('SIGINT', () => {
  game.saveAll();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Shardlands is up: http://localhost:${PORT}`);
});
