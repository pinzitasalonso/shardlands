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
const https = require('https');
const { TILE, BUILDING_KINDS } = require('./world');

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
      villages: game.map.villages,
      cities: game.map.cities,
      mobKinds: Object.keys(MOB_KINDS_REF()),
      tileNames: Object.fromEntries(Object.entries(TILE).map(([k, v]) => [v, k])),
      buildingKinds: BUILDING_KINDS,
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
const MOB_KINDS_REF = () => mobKindsRef;
function setMobKinds(mk) { mobKindsRef = mk; }

configure(process.env.EDITOR_PASSWORD);

module.exports = {
  handle, authed, setMobKinds,
  // exposed for the smoke test
  configure, verifyPassword, issueSession, checkToken, rateLimited,
  passwordRequired, githubRequest,
};
