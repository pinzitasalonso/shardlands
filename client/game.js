'use strict';

// Shardlands client: connects to the server over WebSocket, renders the world
// on a canvas, and translates input into intents. The server owns all rules.
//
// The world is drawn in classic 2:1 isometric projection (Ultima Online
// style): tile (x, y) maps to screen ((x - y) * 32, (x + y) * 16). Art comes
// from the sprite manifest loaded by assets.js; if it is missing the world
// renders as flat-shaded diamonds instead.

const HW = 32; // half tile width on screen
const HH = 16; // half tile height on screen
const T = { WATER: 0, GRASS: 1, TREE: 2, ROCK: 3, ROAD: 4, FLOOR: 5, WALL: 6, SAND: 7, SHRINE: 8 };
const WALKABLE = new Set([T.GRASS, T.ROAD, T.FLOOR, T.SAND, T.SHRINE]);

const MOB_STYLE = {
  goblin: { color: '#5aa040', size: 0.5, name: 'a goblin' },
  skeleton: { color: '#d8d4c8', size: 0.7, name: 'a skeleton' },
  orc: { color: '#5a8a3a', size: 0.8, name: 'an orc' },
  ettin: { color: '#a07040', size: 1.0, name: 'an ettin' },
  dragon: { color: '#c03828', size: 1.3, name: 'a dragon' },
};

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');

const state = {
  ws: null,
  myId: 0,
  map: null,            // { w, h, chunk } — tiles arrive in chunks
  chunks: new Map(),    // "cx,cy" -> Uint8Array(chunk*chunk)
  wantedChunks: new Set(),
  buildings: [],        // { x, y, w, h } for roofs
  mini: null,           // downsampled world overview for the minimap
  players: new Map(),   // id -> { ...snapshot, rx, ry, heading }
  mobs: new Map(),
  vendors: [],          // static shopkeepers from the welcome message
  drops: [],            // loot lying on the ground
  me: null,             // my entry in players
  you: null,            // private stats from the server
  speech: new Map(),    // entity id -> { text, until, magic }
  floaters: [],         // { x, y, text, color, born }
  projectiles: [],      // { x, y, tx, ty, born, color }
  target: 0,            // selected mob id
  walkTarget: null,     // { x, y } click-to-move destination
  myTile: null,         // authoritative tile pos from last state message
  spells: {},
  minimapImage: null,
};

Assets.load();

// ---- networking -------------------------------------------------------------

function connect(email, password, name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    send({ t: 'join', email, password, name });
  };
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    loginError('Connection lost. Refresh to rejoin.');
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'reject':
      state.ws.onclose = null;
      state.ws.close();
      loginError(msg.reason);
      break;

    case 'welcome': {
      state.myId = msg.id;
      state.spells = msg.spells;
      state.vendors = (msg.vendors || []).map((v) => ({ ...v, rx: v.x, ry: v.y, heading: 1 }));
      state.map = { w: msg.map.w, h: msg.map.h, chunk: msg.map.chunk };
      state.chunks.clear();
      state.wantedChunks.clear();
      state.buildings = msg.buildings || [];
      state.mini = msg.mini;
      buildMinimap();
      document.getElementById('login').classList.add('hidden');
      document.getElementById('hud').classList.remove('hidden');
      break;
    }

    case 'chunk': {
      const raw = atob(msg.d);
      const tiles = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) tiles[i] = raw.charCodeAt(i);
      state.chunks.set(msg.cx + ',' + msg.cy, tiles);
      state.wantedChunks.delete(msg.cx + ',' + msg.cy);
      break;
    }

    case 'state': {
      syncEntities(state.players, msg.players);
      syncEntities(state.mobs, msg.mobs);
      state.drops = msg.drops || [];
      state.me = state.players.get(state.myId) || null;
      if (state.me) state.myTile = { x: state.me.x, y: state.me.y };
      if (state.target && !state.mobs.has(state.target)) state.target = 0;
      break;
    }

    case 'you':
      state.you = msg;
      updateHud();
      if (!document.getElementById('inventory').classList.contains('hidden')) renderInventory();
      break;

    case 'chat': {
      state.speech.set(msg.id, { text: msg.text, until: Date.now() + 5000, magic: !!msg.magic });
      log(`<b>${esc(msg.name)}:</b> ${esc(msg.text)}`, 'speech');
      break;
    }

    case 'sys':
      log(esc(msg.text), /risen|increased/.test(msg.text) ? 'gain' : 'sys');
      break;

    case 'tile': {
      // A resource depleted or regrew somewhere in the world.
      const m = state.map;
      if (!m) break;
      const c = state.chunks.get(Math.floor(msg.x / m.chunk) + ',' + Math.floor(msg.y / m.chunk));
      if (c) c[(msg.y % m.chunk) * m.chunk + (msg.x % m.chunk)] = msg.tile;
      break;
    }

    case 'fx':
      handleFx(msg);
      break;
  }
}

function octant(dx, dy) {
  return ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
}

function syncEntities(map, list) {
  const seen = new Set();
  for (const e of list) {
    seen.add(e.id);
    const prev = map.get(e.id);
    if (prev) {
      // Keep render position for interpolation; adopt new authoritative pos.
      if (e.x !== prev.x || e.y !== prev.y) prev.heading = octant(e.x - prev.x, e.y - prev.y);
      Object.assign(prev, e);
    } else {
      map.set(e.id, { ...e, rx: e.x, ry: e.y, heading: 1 });
    }
  }
  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
}

function handleFx(msg) {
  const t = Date.now();
  switch (msg.kind) {
    case 'hit':
      state.floaters.push({ x: msg.x, y: msg.y, text: '-' + msg.amount, color: '#e05848', born: t });
      break;
    case 'miss':
      state.floaters.push({ x: msg.x, y: msg.y, text: 'miss', color: '#8a8a8a', born: t });
      break;
    case 'heal':
      state.floaters.push({ x: msg.x, y: msg.y, text: '+' + msg.amount, color: '#5ac05a', born: t });
      break;
    case 'die':
      state.floaters.push({ x: msg.x, y: msg.y, text: '✝', color: '#c8c8c8', born: t });
      break;
    case 'portal':
      state.floaters.push({ x: msg.x, y: msg.y, text: '✦ ✦ ✦', color: '#b08aff', born: t });
      break;
    case 'magicarrow':
    case 'fireball':
      state.projectiles.push({
        x: msg.x, y: msg.y, tx: msg.tx, ty: msg.ty, born: t,
        color: msg.kind === 'fireball' ? '#ff8030' : '#70b0ff',
      });
      setTimeout(() => {
        state.floaters.push({ x: msg.tx, y: msg.ty, text: '-' + msg.amount, color: '#e05848', born: Date.now() });
      }, 250);
      break;
  }
}

// ---- input -------------------------------------------------------------------

const keys = new Set();
const chatInput = document.getElementById('chat-input');

document.addEventListener('keydown', (ev) => {
  if (document.activeElement === chatInput) {
    if (ev.key === 'Enter') {
      const text = chatInput.value.trim();
      if (text) send({ t: 'say', text });
      chatInput.value = '';
      chatInput.blur();
    } else if (ev.key === 'Escape') {
      chatInput.blur();
    }
    return;
  }
  const ae = document.activeElement;
  if (ae && (ae.id === 'name' || ae.id === 'email' || ae.id === 'password')) return;

  switch (ev.key) {
    case 'Enter': chatInput.focus(); ev.preventDefault(); break;
    case 'Escape': closeShop(); document.getElementById('inventory').classList.add('hidden'); break;
    case '1': castSpell('magicarrow'); break;
    case '2': castSpell('fireball'); break;
    case '3': castSpell('greaterheal'); break;
    case '4': send({ t: 'drink', kind: 'heal' }); break;
    case '5': send({ t: 'drink', kind: 'mana' }); break;
    case 'b': case 'B': send({ t: 'bandage' }); break;
    case 'g': case 'G': send({ t: 'gather' }); break;
    case 'i': case 'I': toggleInventory(); break;
    default: keys.add(ev.key.toLowerCase());
  }
});

document.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function castSpell(id) {
  send({ t: 'cast', spell: id, id: state.target });
}

canvas.addEventListener('mousedown', (ev) => {
  if (!state.me || !state.map) return;
  const cam = camera();

  // Clicking a shopkeeper opens their wares; a mob attacks; ground walks.
  const clickable = [];
  for (const v of state.vendors) clickable.push({ kind: 'vendor', e: v });
  for (const m of state.mobs.values()) clickable.push({ kind: 'mob', e: m });
  let best = null;
  let bestD = 38;
  for (const c of clickable) {
    const s = worldToScreen(c.e.rx + 0.5, c.e.ry + 0.5, cam);
    const d = Math.hypot(s.x - ev.clientX, s.y - (ev.clientY + 24));
    if (d < bestD) { best = c; bestD = d; }
  }
  if (best && best.kind === 'vendor') {
    openShop(best.e);
    return;
  }
  if (best) {
    state.target = best.e.id;
    send({ t: 'attack', id: best.e.id });
    state.walkTarget = { x: best.e.x, y: best.e.y };
  } else {
    const w = screenToWorld(ev.clientX, ev.clientY, cam);
    state.walkTarget = { x: Math.floor(w.x), y: Math.floor(w.y) };
  }
});

// Movement intents: held keys win over click-to-move.
setInterval(() => {
  if (!state.me || document.activeElement === chatInput) return;
  let dx = 0;
  let dy = 0;
  if (keys.has('w') || keys.has('arrowup')) dy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) dy += 1;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  if (keys.has('d') || keys.has('arrowright')) dx += 1;

  if (dx || dy) {
    state.walkTarget = null;
    send({ t: 'move', dx, dy });
    return;
  }

  const wt = state.walkTarget;
  const my = state.myTile;
  if (wt && my) {
    if (wt.x === my.x && wt.y === my.y) {
      state.walkTarget = null;
      return;
    }
    // If chasing a target, keep the destination fresh.
    if (state.target) {
      const mob = state.mobs.get(state.target);
      if (mob) { wt.x = mob.x; wt.y = mob.y; }
    }
    const sx = Math.sign(wt.x - my.x);
    const sy = Math.sign(wt.y - my.y);
    // Stop one tile short when walking onto a mob's square.
    if (Math.abs(wt.x - my.x) <= 1 && Math.abs(wt.y - my.y) <= 1 && state.target) {
      state.walkTarget = null;
      return;
    }
    for (const [ox, oy] of [[sx, sy], [sx, 0], [0, sy]]) {
      if (ox === 0 && oy === 0) continue;
      if (state.you && state.you.dead) { send({ t: 'move', dx: ox, dy: oy }); return; }
      if (WALKABLE.has(tileAt(my.x + ox, my.y + oy))) {
        send({ t: 'move', dx: ox, dy: oy });
        return;
      }
    }
    state.walkTarget = null; // boxed in; give up
  }
}, 90);

document.getElementById('actions').addEventListener('click', (ev) => {
  const act = ev.target.dataset.act;
  if (!act) return;
  if (act.startsWith('cast:')) castSpell(act.slice(5));
  else if (act.startsWith('drink:')) send({ t: 'drink', kind: act.slice(6) });
  else send({ t: act });
});

// ---- shop ----------------------------------------------------------------------

const shopPanel = document.getElementById('shop');

function openShop(vendor) {
  const lines = vendor.goods.map((g) =>
    `<div class="shop-row">
       <span>${esc(g.name)}<small>${esc(g.desc || '')}</small></span>
       <button data-item="${esc(g.item)}">${g.price} gp</button>
     </div>`).join('');
  shopPanel.innerHTML =
    `<div class="shop-title">${esc(vendor.name)}</div>${lines}
     <button class="shop-close">Close</button>`;
  shopPanel.classList.remove('hidden');
  if (state.me && Math.hypot(vendor.x - state.me.x, vendor.y - state.me.y) > 3) {
    state.walkTarget = { x: vendor.x, y: vendor.y - 1 };
  }
}

function closeShop() {
  shopPanel.classList.add('hidden');
}

shopPanel.addEventListener('click', (ev) => {
  if (ev.target.classList.contains('shop-close')) return closeShop();
  const item = ev.target.dataset.item;
  if (item) send({ t: 'buy', item });
});

// ---- login --------------------------------------------------------------------

const nameInput = document.getElementById('name');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
emailInput.value = localStorage.getItem('shardlands:email') || '';
nameInput.value = localStorage.getItem('shardlands:lastname') || '';

function tryLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();
  if (!email) return loginError('Enter your email address.');
  if (password.length < 6) return loginError('Password must be at least 6 characters.');
  localStorage.setItem('shardlands:email', email);
  if (name) localStorage.setItem('shardlands:lastname', name);
  loginError('');
  connect(email, password, name);
}

document.getElementById('play').addEventListener('click', tryLogin);
for (const el of [nameInput, emailInput, passwordInput]) {
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') tryLogin();
  });
}

function loginError(text) {
  document.getElementById('login-error').textContent = text;
}

// ---- HUD ------------------------------------------------------------------------

function updateHud() {
  const y = state.you;
  if (!y) return;
  document.getElementById('char-name').textContent =
    (state.me ? state.me.name : '') + (y.dead ? '  (ghost)' : '');
  document.getElementById('hp-fill').style.width = (100 * y.hp / y.maxhp) + '%';
  document.getElementById('hp-text').textContent = `${y.hp} / ${y.maxhp}`;
  document.getElementById('mana-fill').style.width = (100 * y.mana / y.maxmana) + '%';
  document.getElementById('mana-text').textContent = `${y.mana} / ${y.maxmana}`;
  document.getElementById('stats-line').textContent = `STR ${y.str}  DEX ${y.dex}  INT ${y.int}`;
  document.getElementById('pack-line').textContent =
    `⛀ ${y.gold} gold · ${y.logs} logs · ${y.ore} ore` + (y.gems ? ` · ${y.gems} gems` : '');
  const pots = y.pots || {};
  document.getElementById('pot-heal-count').textContent = pots.heal || 0;
  document.getElementById('pot-mana-count').textContent = pots.mana || 0;

  const list = document.getElementById('skills-list');
  list.innerHTML = Object.entries(y.skills)
    .map(([k, v]) => `<div class="skill-row"><span>${k[0].toUpperCase() + k.slice(1)}</span><span>${Number(v).toFixed(1)}</span></div>`)
    .join('');
}

document.getElementById('skills-toggle').addEventListener('click', () => {
  document.getElementById('skills-list').classList.toggle('hidden');
});

// ---- inventory --------------------------------------------------------------

function toggleInventory() {
  const panel = document.getElementById('inventory');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderInventory();
}

function renderInventory() {
  const y = state.you;
  if (!y) return;
  const pots = y.pots || {};
  const rows = [
    ['🪙', 'Gold', y.gold, ''],
    ['🧪', 'Heal potions', pots.heal || 0, 'drink:heal'],
    ['🜄', 'Mana potions', pots.mana || 0, 'drink:mana'],
    ['🪵', 'Logs', y.logs, ''],
    ['🪨', 'Ore', y.ore, ''],
    ['💎', 'Gems', y.gems || 0, ''],
  ];
  document.getElementById('inv-items').innerHTML = rows.map(([icon, label, count, act]) =>
    `<div class="inv-row">
       <span class="inv-icon">${icon}</span>
       <span class="inv-label">${label}</span>
       <span class="inv-count">${count}</span>
       ${act ? `<button data-act="${act}">use</button>` : '<span></span>'}
     </div>`).join('');
}

document.getElementById('inventory').addEventListener('click', (ev) => {
  if (ev.target.id === 'inv-close') return document.getElementById('inventory').classList.add('hidden');
  const act = ev.target.dataset.act;
  if (act && act.startsWith('drink:')) send({ t: 'drink', kind: act.slice(6) });
});

const chatLog = document.getElementById('chat-log');

function log(html, cls) {
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  chatLog.appendChild(div);
  while (chatLog.children.length > 80) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- rendering ---------------------------------------------------------------------

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function tileAt(x, y) {
  const m = state.map;
  if (!m || x < 0 || y < 0 || x >= m.w || y >= m.h) return T.WATER;
  const c = state.chunks.get(Math.floor(x / m.chunk) + ',' + Math.floor(y / m.chunk));
  if (!c) return T.WATER; // not streamed in yet
  return c[(y % m.chunk) * m.chunk + (x % m.chunk)];
}

// Stream in the chunks around the player as they travel.
setInterval(() => {
  const m = state.map;
  if (!m || !state.me) return;
  const span = Math.ceil((canvas.width / (4 * HW) + canvas.height / (4 * HH) + 24) / m.chunk) + 1;
  const ccx = Math.floor(state.me.x / m.chunk);
  const ccy = Math.floor(state.me.y / m.chunk);
  const want = [];
  for (let cy = ccy - span; cy <= ccy + span; cy++) {
    for (let cx = ccx - span; cx <= ccx + span; cx++) {
      if (cx < 0 || cy < 0 || cx >= m.w / m.chunk || cy >= m.h / m.chunk) continue;
      const key = cx + ',' + cy;
      if (state.chunks.has(key) || state.wantedChunks.has(key)) continue;
      want.push([cx, cy]);
      state.wantedChunks.add(key);
      if (want.length >= 32) break;
    }
    if (want.length >= 32) break;
  }
  if (want.length) send({ t: 'chunks', l: want });
}, 200);

// Deterministic per-tile jitter so terrain doesn't look flat.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Flat-shaded fallback palette, used when sprite assets are unavailable.
const TILE_COLORS = {
  [T.WATER]: ['#1d4d6e', '#1a4664'],
  [T.GRASS]: ['#4a7a38', '#447236'],
  [T.TREE]: ['#4a7a38', '#447236'],
  [T.ROCK]: ['#6e6a60', '#646055'],
  [T.ROAD]: ['#9a8a64', '#8f805c'],
  [T.FLOOR]: ['#8a8078', '#827870'],
  [T.WALL]: ['#4a4640', '#403c36'],
  [T.SAND]: ['#c0ae7c', '#b8a674'],
  [T.SHRINE]: ['#8a8078', '#8a8078'],
};

function camera() {
  const px = state.me ? state.me.rx + 0.5 : 64;
  const py = state.me ? state.me.ry + 0.5 : 64;
  return {
    ox: canvas.width / 2 - (px - py) * HW,
    oy: canvas.height / 2 - (px + py) * HH,
  };
}

// World (tile units, fractional ok) -> screen pixels.
function worldToScreen(x, y, cam) {
  return { x: (x - y) * HW + cam.ox, y: (x + y) * HH + cam.oy };
}

function screenToWorld(px, py, cam) {
  const a = (px - cam.ox) / HW;
  const b = (py - cam.oy) / HH;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

// Fallback ground: a flat diamond.
function fillDiamond(sx, sy, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(sx + HW, sy);
  ctx.lineTo(sx + 2 * HW, sy + HH);
  ctx.lineTo(sx + HW, sy + 2 * HH);
  ctx.lineTo(sx, sy + HH);
  ctx.closePath();
  ctx.fill();
}

function render() {
  requestAnimationFrame(render);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.map || !state.me) return;

  // Ease render positions toward authoritative positions.
  for (const map of [state.players, state.mobs]) {
    for (const e of map.values()) {
      if (Math.abs(e.x - e.rx) > 4 || Math.abs(e.y - e.ry) > 4) { e.rx = e.x; e.ry = e.y; }
      e.rx += (e.x - e.rx) * 0.25;
      e.ry += (e.y - e.ry) * 0.25;
    }
  }

  const cam = camera();
  const time = Date.now();
  const useSprites = Assets.state.ok;

  // Visible tile range: scan a square of tiles big enough to cover the
  // diamond-shaped viewport, with margin for tall objects.
  const cx = Math.floor(state.me.rx);
  const cy = Math.floor(state.me.ry);
  const range = Math.ceil(canvas.width / (4 * HW) + canvas.height / (4 * HH)) + 8;
  const x0 = Math.max(0, cx - range);
  const x1 = Math.min(state.map.w - 1, cx + range);
  const y0 = Math.max(0, cy - range);
  const y1 = Math.min(state.map.h - 1, cy + range);

  const drawables = [];

  // Ground pass, plus collection of depth-sorted scenery.
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const top = worldToScreen(tx, ty, cam); // top corner of the diamond
      const sx = top.x - HW;
      const sy = top.y;
      if (sx < -200 || sx > canvas.width + 140 || sy < -260 || sy > canvas.height + 160) continue;
      const tile = tileAt(tx, ty);
      const h = hash(tx, ty);

      if (useSprites) {
        const recipe = Assets.tile(tile) || Assets.tile(T.WATER);
        Assets.drawGround(ctx, recipe, h, sx, sy);

        if (recipe.objectSets) {
          const sets = recipe.objectSets;
          const set = sets[Math.floor(hash((tx >> 4) * 7 + 3, (ty >> 4) * 13 + 5) * sets.length)];
          const name = set[Math.floor(hash(tx * 5 + 1, ty) * set.length)];
          drawables.push({ depth: tx + ty, kind: 'sprite', name, x: top.x, y: top.y + HH });
        } else if (recipe.object) {
          const name = recipe.object[Math.floor(hash(tx * 5 + 1, ty) * recipe.object.length)];
          drawables.push({ depth: tx + ty, kind: 'sprite', name, x: top.x, y: top.y + HH });
        } else if (recipe.decor && hash(tx, ty * 3 + 1) < recipe.decor.chance) {
          const name = recipe.decor.objects[Math.floor(h * recipe.decor.objects.length)];
          drawables.push({ depth: tx + ty, kind: 'sprite', name, x: top.x, y: top.y + HH });
        }
        if (recipe.effect === 'water') drawWaterGlint(tx, ty, sx, sy, time);
        if (recipe.effect === 'shrine') drawables.push({ depth: tx + ty, kind: 'shrine', x: top.x, y: top.y + HH });
      } else {
        const pair = TILE_COLORS[tile] || TILE_COLORS[T.WATER];
        fillDiamond(sx, sy, pair[h > 0.5 ? 0 : 1]);
        if (tile === T.TREE || tile === T.ROCK || tile === T.WALL) {
          drawables.push({ depth: tx + ty, kind: 'block', tile, x: top.x, y: top.y + HH, h });
        }
        if (tile === T.SHRINE) drawables.push({ depth: tx + ty, kind: 'shrine', x: top.x, y: top.y + HH });
      }
    }
  }

  // Roofs cover buildings unless you are standing inside them.
  for (const b of state.buildings) {
    if (b.x + b.w < x0 || b.x > x1 || b.y + b.h < y0 || b.y > y1) continue;
    const inside = state.me &&
      state.me.x >= b.x && state.me.x < b.x + b.w &&
      state.me.y >= b.y && state.me.y < b.y + b.h;
    if (inside) continue;
    drawables.push({ depth: b.x + b.w + b.y + b.h + 0.5, kind: 'roof', b });
  }

  // Entities join the same depth-sorted pass.
  for (const d of state.drops) drawables.push({ depth: d.x + d.y, kind: 'drop', e: d });
  for (const v of state.vendors) drawables.push({ depth: v.rx + v.ry, kind: 'vendor', e: v });
  for (const m of state.mobs.values()) drawables.push({ depth: m.rx + m.ry + 0.01, kind: 'mob', e: m });
  for (const p of state.players.values()) drawables.push({ depth: p.rx + p.ry + 0.01, kind: 'player', e: p });

  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) {
    switch (d.kind) {
      case 'sprite': Assets.drawFrame(ctx, d.name, d.x, d.y); break;
      case 'block': drawFallbackBlock(d); break;
      case 'shrine': drawShrine(d.x, d.y, time); break;
      case 'drop': drawDrop(d.e, cam, time); break;
      case 'roof': drawRoof(d.b, cam); break;
      case 'vendor': drawVendor(d.e, cam, time); break;
      case 'mob': drawMob(d.e, cam, time); break;
      case 'player': drawPlayer(d.e, cam, time); break;
    }
  }

  drawProjectiles(cam, time);
  drawFloaters(cam, time);
  drawSpeech(cam, time);
  drawMinimap();

  if (state.you && state.you.dead) {
    ctx.fillStyle = 'rgba(40, 50, 70, 0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c8d0e0';
    ctx.font = '22px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText('You are dead. Walk to the glowing ankh in Briarhaven to resurrect.', canvas.width / 2, 60);
    ctx.textAlign = 'left';
  }
}

function drawWaterGlint(tx, ty, sx, sy, time) {
  if (hash(tx, ty * 7) <= 0.8) return;
  const phase = (time / 900 + hash(tx, ty) * 6) % 1;
  ctx.fillStyle = `rgba(170, 210, 235, ${0.35 * Math.sin(phase * Math.PI)})`;
  ctx.fillRect(sx + HW - 10 + hash(ty, tx) * 14, sy + HH - 2, 14, 2);
}

function drawShrine(cx, cy, time) {
  const glow = 0.5 + 0.3 * Math.sin(time / 400);
  ctx.fillStyle = `rgba(220, 190, 90, ${glow * 0.22})`;
  ctx.beginPath();
  ctx.ellipse(cx, cy, HW, HH, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(240, 210, 110, ${glow})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy - 30, 5, 0, Math.PI * 2);
  ctx.moveTo(cx, cy - 25);
  ctx.lineTo(cx, cy - 2);
  ctx.moveTo(cx - 7, cy - 20);
  ctx.lineTo(cx + 7, cy - 20);
  ctx.stroke();
  ctx.lineWidth = 1;
}

// Fallback scenery for trees/rocks/walls when sprites are unavailable.
function drawFallbackBlock(d) {
  const { tile, x: cx, y: cy, h } = d;
  if (tile === T.TREE) {
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(cx - 2, cy - 12, 4, 12);
    ctx.fillStyle = h > 0.5 ? '#2d5a26' : '#33651f';
    ctx.beginPath();
    ctx.arc(cx, cy - 24, 14 + h * 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (tile === T.ROCK) {
    ctx.fillStyle = '#6e6a60';
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy + 6);
    ctx.lineTo(cx, cy - 16 - h * 8);
    ctx.lineTo(cx + 18, cy + 6);
    ctx.closePath();
    ctx.fill();
  } else if (tile === T.WALL) {
    ctx.fillStyle = '#5c584e';
    ctx.beginPath();
    ctx.moveTo(cx - HW, cy - HH);
    ctx.lineTo(cx, cy - 2 * HH);
    ctx.lineTo(cx, cy - 2 * HH - 32);
    ctx.lineTo(cx - HW, cy - HH - 32);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4a463e';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 2 * HH);
    ctx.lineTo(cx + HW, cy - HH);
    ctx.lineTo(cx + HW, cy - HH - 32);
    ctx.lineTo(cx, cy - 2 * HH - 32);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#6e6a60';
    fillDiamond(cx - HW, cy - 2 * HH - 32, '#6e6a60');
  }
}

// A gabled roof drawn as an isometric prism above the building's walls.
// UO-style: it vanishes while you stand inside.
function drawRoof(b, cam) {
  const e = 0.3; // eave overhang in tiles
  const x0 = b.x - e;
  const y0 = b.y - e;
  const x1 = b.x + b.w - 1 + 1 + e; // walls occupy [x, x+w-1]
  const y1 = b.y + b.h - 1 + 1 + e;
  const lift = 30;       // top of the walls, in screen px
  const ridgeLift = 54;
  const P = (wx, wy, dz) => {
    const s = worldToScreen(wx, wy, cam);
    return [s.x, s.y - dz];
  };
  const A = P(x0, y0, lift);
  const B = P(x1, y0, lift);
  const C = P(x1, y1, lift);
  const D = P(x0, y1, lift);

  const poly = (pts, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 16, 10, 0.5)';
    ctx.stroke();
  };
  // Shingle course lines between the eave edge and the ridge.
  const courses = (eaveA, eaveB, rA, rB) => {
    ctx.strokeStyle = 'rgba(40, 16, 10, 0.22)';
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const f = k / 4;
      ctx.moveTo(eaveA[0] + (rA[0] - eaveA[0]) * f, eaveA[1] + (rA[1] - eaveA[1]) * f);
      ctx.lineTo(eaveB[0] + (rB[0] - eaveB[0]) * f, eaveB[1] + (rB[1] - eaveB[1]) * f);
    }
    ctx.stroke();
  };

  if (b.w >= b.h) {
    // Ridge runs west-east.
    const my = (y0 + y1) / 2;
    const rA = P(x0 + 0.5, my, ridgeLift);
    const rB = P(x1 - 0.5, my, ridgeLift);
    poly([A, B, rB, rA], '#6e3a30');  // north slope (faces away)
    poly([D, C, rB, rA], '#a0523f');  // south slope (faces camera)
    courses(D, C, rA, rB);
    poly([B, C, rB], '#874437');      // east gable
  } else {
    // Ridge runs north-south.
    const mx = (x0 + x1) / 2;
    const rA = P(mx, y0 + 0.5, ridgeLift);
    const rB = P(mx, y1 - 0.5, ridgeLift);
    poly([A, D, rB, rA], '#6e3a30');  // west slope (faces away-ish)
    poly([B, C, rB, rA], '#a0523f');  // east slope (faces camera)
    courses(B, C, rA, rB);
    poly([D, C, rB], '#874437');      // south gable
  }
}

const DROP_COLORS = {
  gold: ['#e8c84a', '#9a7e20'],
  heal: ['#d05050', '#702828'],
  mana: ['#5070d0', '#283870'],
  logs: ['#8a6a42', '#4a3520'],
  ore: ['#9a968a', '#56524a'],
};

function drawDrop(d, cam, time) {
  const s = worldToScreen(d.x + 0.5, d.y + 0.5, cam);
  const [main, dark] = DROP_COLORS[d.item] || DROP_COLORS.gold;
  const bob = Math.sin(time / 350 + d.id) * 1.5;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(s.x, s.y + 2, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  if (d.item === 'gold') {
    for (const [ox, oy] of [[-4, 0], [4, -1], [0, 2], [1, -3]]) {
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.ellipse(s.x + ox, s.y + oy - 3, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = dark;
      ctx.stroke();
    }
  } else if (d.item === 'logs' || d.item === 'ore') {
    ctx.fillStyle = main;
    ctx.fillRect(s.x - 6, s.y - 6 , 12, 7);
    ctx.strokeStyle = dark;
    ctx.strokeRect(s.x - 6.5, s.y - 6.5, 13, 8);
  } else {
    // A little potion bottle.
    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.arc(s.x, s.y - 4 + bob, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.fillRect(s.x - 2, s.y - 13 + bob, 4, 5);
    ctx.fillStyle = '#c8b478';
    ctx.fillRect(s.x - 2, s.y - 15 + bob, 4, 2);
  }
}

function entityShadow(sx, sy, r) {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sx, sy, r, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawMob(m, cam, time) {
  const style = MOB_STYLE[m.kind];
  const s = worldToScreen(m.rx + 0.5, m.ry + 0.5, cam);

  if (m.id === state.target) {
    ctx.strokeStyle = 'rgba(255, 80, 60, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, 26, 13, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  const c = Assets.state.ok && Assets.creature(m.kind);
  let labelY;
  if (c) {
    Assets.drawCreature(ctx, m.kind, m.heading, time + m.id * 137, s.x, s.y);
    labelY = s.y - c.ay - 8;
  } else {
    const r = 22 * style.size;
    entityShadow(s.x, s.y + 2, r * 0.8);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y - r * 0.6, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    labelY = s.y - r * 1.6 - 10;
  }

  drawHpBar(s.x, labelY + 4, m.hp, m.maxhp);
  ctx.fillStyle = 'rgba(220, 214, 200, 0.85)';
  ctx.font = '11px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(style.name, s.x, labelY);
  ctx.textAlign = 'left';
}

function drawPlayer(p, cam, time) {
  const s = worldToScreen(p.rx + 0.5, p.ry + 0.5, cam);

  ctx.save();
  if (p.dead) ctx.globalAlpha = 0.45;

  const c = Assets.state.ok && Assets.creature('player');
  let labelY;
  if (c) {
    entityShadow(s.x, s.y, 11);
    Assets.drawCreature(ctx, 'player', p.heading, time + p.id * 137, s.x, s.y);
    labelY = s.y - c.ay - 8;
  } else {
    entityShadow(s.x, s.y + 2, 10);
    ctx.fillStyle = p.dead ? '#aab4c8' : p.id === state.myId ? '#2858a8' : '#7a3030';
    ctx.beginPath();
    ctx.moveTo(s.x - 9, s.y);
    ctx.lineTo(s.x, s.y - 22);
    ctx.lineTo(s.x + 9, s.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.dead ? '#cfd6e4' : '#d8a878';
    ctx.beginPath();
    ctx.arc(s.x, s.y - 26, 5, 0, Math.PI * 2);
    ctx.fill();
    labelY = s.y - 38;
  }
  ctx.restore();

  if (!p.dead && p.hp < p.maxhp) drawHpBar(s.x, labelY + 4, p.hp, p.maxhp);
  ctx.fillStyle = p.id === state.myId ? '#ffd870' : '#dce4f0';
  ctx.font = '12px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, s.x, labelY);
  ctx.textAlign = 'left';
}

function drawVendor(v, cam, time) {
  const s = worldToScreen(v.rx + 0.5, v.ry + 0.5, cam);
  const c = Assets.state.ok && Assets.creature('vendor');
  let labelY;
  if (c) {
    entityShadow(s.x, s.y, 11);
    Assets.drawCreature(ctx, 'vendor', v.heading, time, s.x, s.y);
    labelY = s.y - c.ay - 8;
  } else {
    entityShadow(s.x, s.y + 2, 10);
    ctx.fillStyle = '#b08a28';
    ctx.beginPath();
    ctx.moveTo(s.x - 9, s.y);
    ctx.lineTo(s.x, s.y - 22);
    ctx.lineTo(s.x + 9, s.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d8a878';
    ctx.beginPath();
    ctx.arc(s.x, s.y - 26, 5, 0, Math.PI * 2);
    ctx.fill();
    labelY = s.y - 38;
  }
  ctx.fillStyle = '#88e0a0';
  ctx.font = '12px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(v.name, s.x, labelY);
  ctx.textAlign = 'left';
}

function drawHpBar(sx, sy, hp, maxhp) {
  const w = 30;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(sx - w / 2, sy, w, 4);
  ctx.fillStyle = hp / maxhp > 0.4 ? '#48b048' : '#c84030';
  ctx.fillRect(sx - w / 2, sy, w * Math.max(0, hp / maxhp), 4);
}

function drawProjectiles(cam, time) {
  state.projectiles = state.projectiles.filter((p) => time - p.born < 260);
  for (const p of state.projectiles) {
    const k = (time - p.born) / 260;
    const s = worldToScreen(p.x + (p.tx - p.x) * k + 0.5, p.y + (p.ty - p.y) * k + 0.5, cam);
    const y = s.y - 20;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(s.x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(s.x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFloaters(cam, time) {
  state.floaters = state.floaters.filter((f) => time - f.born < 1100);
  ctx.font = 'bold 13px Georgia';
  ctx.textAlign = 'center';
  for (const f of state.floaters) {
    const k = (time - f.born) / 1100;
    const s = worldToScreen(f.x + 0.5, f.y + 0.5, cam);
    const y = s.y - 36 - k * 28;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = '#000';
    ctx.fillText(f.text, s.x + 1, y + 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, s.x, y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawSpeech(cam, time) {
  ctx.font = '13px Georgia';
  ctx.textAlign = 'center';
  for (const [id, s] of state.speech) {
    if (time > s.until) {
      state.speech.delete(id);
      continue;
    }
    const e = state.players.get(id) || state.vendors.find((v) => v.id === id);
    if (!e) continue;
    const pos = worldToScreen(e.rx + 0.5, e.ry + 0.5, cam);
    const y = pos.y - 64;
    const w = ctx.measureText(s.text).width;
    ctx.fillStyle = 'rgba(8, 10, 13, 0.75)';
    ctx.fillRect(pos.x - w / 2 - 5, y - 13, w + 10, 18);
    ctx.fillStyle = s.magic ? '#9ab8ff' : '#f0ead8';
    ctx.fillText(s.text, pos.x, y);
  }
  ctx.textAlign = 'left';
}

// ---- minimap -----------------------------------------------------------------------

const MINI_COLORS = {
  [T.WATER]: [26, 70, 100], [T.GRASS]: [74, 122, 56], [T.TREE]: [40, 80, 32],
  [T.ROCK]: [110, 106, 96], [T.ROAD]: [154, 138, 100], [T.FLOOR]: [138, 128, 120],
  [T.WALL]: [70, 66, 60], [T.SAND]: [192, 174, 124], [T.SHRINE]: [240, 210, 110],
};

function buildMinimap() {
  const mini = state.mini;
  if (!mini) return;
  minimap.width = mini.w;
  minimap.height = mini.h;
  const raw = atob(mini.d);
  const img = new ImageData(mini.w, mini.h);
  for (let i = 0; i < raw.length; i++) {
    const c = MINI_COLORS[raw.charCodeAt(i)] || [0, 0, 0];
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  state.minimapImage = img;
}

function drawMinimap() {
  if (!state.minimapImage || !state.mini) return;
  const mctx = minimap.getContext('2d');
  mctx.putImageData(state.minimapImage, 0, 0);
  const s = state.mini.s;
  for (const p of state.players.values()) {
    mctx.fillStyle = p.id === state.myId ? '#ffffff' : '#ffd040';
    mctx.fillRect(Math.round(p.x / s) - 1, Math.round(p.y / s) - 1, 3, 3);
  }
}

requestAnimationFrame(render);
