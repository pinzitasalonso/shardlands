'use strict';

// The world builder's server side: password gate, session tokens, the edit
// API, and the GitHub publish hand. index.js mounts handle() for every
// /editor/* request and asks authed() before serving the builder's pages.
//
// Gate policy: when EDITOR_PASSWORD is set, a valid session is required
// from everywhere — loopback included. When it is not set, the builder is
// loopback-only (safe default for local dev). The old EDITOR=1 world-open
// bypass is gone on purpose.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { TILE, BUILDING_KINDS } = require('./world');

// ---- the pixel studio's storage rules ---------------------------------------
// Custom art is small, named plainly, and PNG or nothing.
const ART_NAME_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
const ART_MAX_BYTES = 64_000;
const ART_MAX_DIM = 64;

// Width and height straight from the IHDR chunk; null when the buffer is
// not a PNG. Pure, so the smoke test can lean on it.
function pngDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return null;
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function artDir(game) {
  return path.join(path.dirname(game.editsPath), 'custom-art');
}

function readArtIndex(game) {
  try {
    return JSON.parse(fs.readFileSync(path.join(artDir(game), 'index.json'), 'utf8'));
  } catch {
    return { art: [] };
  }
}

const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_TRIES = 5;

let bootSalt = null;
let refHash = null; // scrypt of EDITOR_PASSWORD, derived once at boot

function configure(password) {
  if (password) {
    bootSalt = crypto.randomBytes(16);
    refHash = crypto.scryptSync(String(password), bootSalt, 64);
  } else {
    bootSalt = null;
    refHash = null;
  }
  sessions.clear();
  attempts.clear();
}

const sessions = new Map(); // token -> expiry epoch ms
const attempts = new Map(); // ip -> { count, resetAt }

const passwordRequired = () => !!refHash;

function verifyPassword(pw) {
  if (!refHash) return false;
  const h = crypto.scryptSync(String(pw || ''), bootSalt, 64);
  return crypto.timingSafeEqual(h, refHash);
}

function issueSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

function checkToken(token) {
  if (typeof token !== 'string' || !token) return false;
  const t = Date.now();
  for (const [k, exp] of sessions) if (exp <= t) sessions.delete(k);
  const exp = sessions.get(token);
  return !!exp && exp > t;
}

function rateLimited(ip) {
  const t = Date.now();
  let rec = attempts.get(ip);
  if (!rec || t >= rec.resetAt) {
    rec = { count: 0, resetAt: t + LOGIN_WINDOW_MS };
    attempts.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX_TRIES;
}

const isLoopback = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)editorToken=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const q = /[?&]token=([a-f0-9]{16,})/.exec(req.url || '');
  return q ? q[1] : null;
}

// May this request use the builder at all?
function authed(req) {
  if (!passwordRequired()) return isLoopback(req);
  return checkToken(tokenFrom(req));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 8_000_000) req.destroy();
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'not valid JSON' });
    }
    cb(parsed);
  });
}

// Build the request options + payload for a GitHub Contents API call.
// Pure, so the smoke test can check it without touching the network.
function githubRequest(method, repo, token, filePath, body) {
  return {
    options: {
      hostname: 'api.github.com',
      path: `/repos/${repo}/contents/${filePath}`,
      method,
      headers: {
        'User-Agent': 'shardlands-world-builder',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    },
    payload: body ? JSON.stringify(body) : null,
  };
}

function githubCall(method, repo, token, filePath, body, cb) {
  const { options, payload } = githubRequest(method, repo, token, filePath, body);
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (d) => { data += d; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(data); } catch { /* GitHub always sends JSON */ }
      cb(null, res.statusCode, parsed);
    });
  });
  req.on('error', (err) => cb(err));
  if (payload) req.write(payload);
  req.end();
}

// Commit the current overlay to the repo as world/edits.json. The commit
// is what makes an edit session part of history — Save alone keeps prod
// running and the volume durable, Publish makes it permanent.
function publishToGitHub(game, message, cb) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) {
    return cb(null, { code: 503, body: {
      error: 'publishing needs GITHUB_TOKEN and GITHUB_REPO (owner/name) set on the server' } });
  }
  const filePath = 'world/edits.json';
  const content = Buffer.from(JSON.stringify(game.appliedEdits || {}, null, 1)).toString('base64');
  githubCall('GET', repo, token, `${filePath}?ref=${branch}`, null, (err, code, current) => {
    if (err) return cb(err);
    const sha = code === 200 && current && current.sha ? current.sha : undefined;
    const body = {
      message: message || 'World builder: publish world edits',
      content,
      branch,
      ...(sha ? { sha } : {}),
    };
    githubCall('PUT', repo, token, filePath, body, (err2, code2, out) => {
      if (err2) return cb(err2);
      if (code2 !== 200 && code2 !== 201) {
        return cb(null, { code: 502, body: {
          error: `GitHub said ${code2}: ${(out && out.message) || 'unknown error'}` } });
      }
      cb(null, { code: 200, body: {
        ok: true,
        commit: out.commit && out.commit.sha,
        url: out.commit && out.commit.html_url,
      } });
    });
  });
}

// Handle any /editor/* request. Returns true when the URL was ours.
function handle(req, res, url, game) {
  if (!url.startsWith('/editor/')) return false;

  if (url === '/editor/login' && req.method === 'POST') {
    if (!passwordRequired()) {
      if (isLoopback(req)) json(res, 200, { ok: true, note: 'no password set; loopback access is open' });
      else json(res, 403, { error: 'the builder is loopback-only until EDITOR_PASSWORD is set' });
      return true;
    }
    const ip = req.socket.remoteAddress || '?';
    if (rateLimited(ip)) {
      json(res, 429, { error: 'too many attempts — wait a while' });
      return true;
    }
    readBody(req, res, (body) => {
      if (!verifyPassword(body.password)) {
        return json(res, 401, { error: 'wrong password' });
      }
      const token = issueSession();
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `editorToken=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`,
      });
      res.end(JSON.stringify({ ok: true, token }));
    });
    return true;
  }

  if (!authed(req)) {
    json(res, 401, { error: passwordRequired()
      ? 'sign in at /editor-login.html'
      : 'the builder is loopback-only until EDITOR_PASSWORD is set' });
    return true;
  }

  if (url === '/editor/logout' && req.method === 'POST') {
    const token = tokenFrom(req);
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'editorToken=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (url === '/editor/tiles') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(game.map.tiles.buffer, game.map.tiles.byteOffset, game.map.tiles.length));
    return true;
  }

  if (url === '/editor/meta') {
    json(res, 200, {
      w: game.map.w,
      h: game.map.h,
      props: game.map.props,
      spawners: game.map.spawners.map((s) => ({ kind: s.kind, count: s.count, x: s.x, y: s.y, r: s.r })),
      secrets: game.map.secrets.map((s) => ({
        type: s.type, x: s.x, y: s.y,
        ...(s.type === 'portal' ? { tx: s.tx, ty: s.ty } : {}),
        ...(s.dead ? { dead: true } : {}),
      })),
      vendors: game.map.vendors.map((v) => ({ name: v.name, x: v.x, y: v.y })),
      // full terms for the Edit tool (stories stay server-side; they are long)
      vendorsFull: game.map.vendors.map(({ stories, ...v }) => v),
      villages: game.map.villages,
      cities: game.map.cities,
      mobKinds: Object.keys(MOB_KINDS_REF()),
      tileNames: Object.fromEntries(Object.entries(TILE).map(([k, v]) => [v, k])),
      buildingKinds: BUILDING_KINDS,
      weaponKinds: Object.keys(weaponsRef),
      limits: { count: [1, 12], r: [1, 24] },
      passwordRequired: passwordRequired(),
      savedAt: (game.appliedEdits && game.appliedEdits.savedAt) || null,
      publishConfigured: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
      edits: game.appliedEdits && Object.keys(game.appliedEdits).length ? game.appliedEdits : null,
    });
    return true;
  }

  if (url === '/editor/edits') {
    let data = '{}';
    try { data = fs.readFileSync(game.editsPath, 'utf8'); } catch { /* none yet */ }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="edits.json"',
    });
    res.end(data);
    return true;
  }

  if (url === '/editor/save' && req.method === 'POST') {
    readBody(req, res, (edits) => {
      let counts;
      try {
        counts = game.applyEditsLive(edits);
      } catch (err) {
        console.error('applyEditsLive failed:', err);
        return json(res, 500, { error: 'apply failed: ' + err.message });
      }
      json(res, 200, { ok: true, counts,
        note: 'live everywhere; building removals settle at the next restart' });
    });
    return true;
  }

  // The pixel studio: the keeper draws a piece in the browser, it lands
  // here as a small PNG, and every client learns it as prop 'custom.<name>'.
  if (url === '/editor/art' && req.method === 'GET') {
    json(res, 200, readArtIndex(game));
    return true;
  }

  if (url === '/editor/art' && req.method === 'POST') {
    readBody(req, res, (body) => {
      const name = String(body.name || '').toLowerCase();
      if (!ART_NAME_RE.test(name)) {
        return json(res, 400, { error: 'name it plainly: 2-24 of a-z, 0-9, dashes' });
      }
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.png || ''));
      if (!m) return json(res, 400, { error: 'the piece must arrive as a PNG data URL' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > ART_MAX_BYTES) return json(res, 400, { error: 'too heavy: 64KB at most' });
      const dims = pngDims(buf);
      if (!dims) return json(res, 400, { error: 'that is not a PNG' });
      if (dims.w > ART_MAX_DIM || dims.h > ART_MAX_DIM || !dims.w || !dims.h) {
        return json(res, 400, { error: `64x64 at most (got ${dims.w}x${dims.h})` });
      }
      const dir = artDir(game);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.png`), buf);
      const index = readArtIndex(game);
      index.art = (index.art || []).filter((a) => a.name !== name);
      index.art.push({ name, w: dims.w, h: dims.h, t: Date.now() });
      index.art.sort((a, b) => a.name.localeCompare(b.name));
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
      json(res, 200, { ok: true, ...index });
    });
    return true;
  }

  if (url === '/editor/publish' && req.method === 'POST') {
    readBody(req, res, (body) => {
      publishToGitHub(game, body.message, (err, out) => {
        if (err) return json(res, 502, { error: 'GitHub unreachable: ' + err.message });
        json(res, out.code, out.body);
      });
    });
    return true;
  }

  json(res, 404, { error: 'no such editor endpoint' });
  return true;
}

// MOB_KINDS lives in game.js, which requires this file's sibling world.js;
// requiring game.js from here would be circular, so it is injected.
let mobKindsRef = {};
let weaponsRef = {};
const MOB_KINDS_REF = () => mobKindsRef;
function setMobKinds(mk, weapons) { mobKindsRef = mk; weaponsRef = weapons || {}; }

configure(process.env.EDITOR_PASSWORD);

module.exports = {
  handle, authed, setMobKinds, artDir,
  // exposed for the smoke test
  configure, verifyPassword, issueSession, checkToken, rateLimited,
  passwordRequired, githubRequest, pngDims,
};
