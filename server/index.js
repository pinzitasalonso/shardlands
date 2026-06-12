'use strict';

// Entry point: a plain HTTP server for the client files plus a WebSocket
// endpoint on the same port for the game protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, MOB_KINDS } = require('./game');

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

// The map editor is an internal tool: only the shard keeper's own machine
// (loopback) may use it, unless EDITOR=1 is set explicitly.
const editorAllowed = (req) =>
  process.env.EDITOR === '1' ||
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function handleEditor(req, res, url) {
  if (!editorAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'The editor is keeper-only (run locally or set EDITOR=1).' }));
    return true;
  }
  if (url === '/editor/tiles') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(game.map.tiles.buffer, game.map.tiles.byteOffset, game.map.tiles.length));
    return true;
  }
  if (url === '/editor/meta') {
    let edits = null;
    try { edits = JSON.parse(fs.readFileSync(game.editsPath, 'utf8')); } catch { /* none yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      w: game.map.w,
      h: game.map.h,
      props: game.map.props,
      spawners: game.map.spawners.map((s) => ({ kind: s.kind, count: s.count, x: s.x, y: s.y, r: s.r })),
      secrets: game.map.secrets.map((s) => ({ type: s.type, x: s.x, y: s.y })),
      vendors: game.map.vendors.map((v) => ({ name: v.name, x: v.x, y: v.y })),
      villages: game.map.villages,
      cities: game.map.cities,
      mobKinds: Object.keys(MOB_KINDS),
      edits,
    }));
    return true;
  }
  if (url === '/editor/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 8_000_000) req.destroy();
    });
    req.on('end', () => {
      let edits;
      try {
        edits = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not valid JSON' }));
      }
      fs.mkdirSync(path.dirname(game.editsPath), { recursive: true });
      fs.writeFileSync(game.editsPath, JSON.stringify(edits, null, 1));
      // Tile paints go live immediately; entities need a restart (spawner
      // and cache state is built at boot).
      let live = 0;
      for (const [x, y, v] of edits.tiles || []) {
        if (x >= 0 && y >= 0 && x < game.map.w && y < game.map.h &&
            game.map.tiles[y * game.map.w + x] !== v) {
          game.map.tiles[y * game.map.w + x] = v;
          if (live < 800) game.broadcast({ t: 'tile', x, y, tile: v });
          live++;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tilesLive: live,
        note: 'saved to world/edits.json — tiles are live; props/spawners/secrets apply on next server start' }));
    });
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/editor/') && handleEditor(req, res, url)) return;
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
