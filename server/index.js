'use strict';

// Entry point: a plain HTTP server for the client files plus a WebSocket
// endpoint on the same port for the game protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, MOB_KINDS, WEAPONS } = require('./game');
const editor = require('./editor');
editor.setMobKinds(MOB_KINDS, WEAPONS);

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
  if (url.startsWith('/editor/') && editor.handle(req, res, url, game)) return;
  // The keeper's own pixels: world-readable, tightly named, served from
  // the data volume beside the edits overlay.
  if (url.startsWith('/custom-art/')) {
    const base = url.slice('/custom-art/'.length);
    if (base !== 'index.json' && !/^[a-z0-9][a-z0-9-]{1,23}\.png$/.test(base)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    return fs.readFile(path.join(editor.artDir(game), base), (err, data) => {
      if (err) {
        // no studio pieces yet is a normal state, not a client error
        if (base === 'index.json') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store' });
          return res.end('{"art":[]}');
        }
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': base.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', // studio saves must show up on refresh
      });
      res.end(data);
    });
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      players: game.players.size,
      mobs: game.mobs.size,
      tickMs: game.lastTickMs || 0,
      uptime: Math.round(process.uptime()),
    }));
  }
  const rel = url === '/' ? 'index.html' : url.slice(1);
  // The builder's own pages are behind the same gate as its API; a fresh
  // browser lands on the login page instead of a wall of 401s.
  if ((rel === 'editor.html' || rel === 'editor.js') && !editor.authed(req)) {
    res.writeHead(302, { Location: '/editor-login.html' });
    return res.end();
  }
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
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // code and the manifest must never go stale — a cached client from an
      // older deploy mixed with new data renders a broken world. Sprite
      // sheets may cache briefly; they change only on asset rebuilds.
      'Cache-Control': ext === '.png' ? 'max-age=60' : 'no-store',
    });
    res.end(data);
  });
});

const game = new Game();
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true });

wss.on('connection', (ws) => {
  // Token-bucket rate limit: 40 intents/second sustained, bursts to 80.
  ws.bucket = 80;
  ws.lastRefill = Date.now();
  ws.on('message', (data) => {
    const t = Date.now();
    ws.bucket = Math.min(80, ws.bucket + (t - ws.lastRefill) * 0.04);
    ws.lastRefill = t;
    if (ws.bucket < 1) return;
    ws.bucket -= 1;
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

// Railway (and most supervisors) send SIGTERM on redeploys; save on both.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    game.saveAll();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Shardlands is up: http://localhost:${PORT}`);
});
