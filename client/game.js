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
const T = { WATER: 0, GRASS: 1, TREE: 2, ROCK: 3, ROAD: 4, FLOOR: 5, WALL: 6, SAND: 7, SHRINE: 8, SNOW: 9, SNOWTREE: 10, PLANKS: 11 };
const WALKABLE = new Set([T.GRASS, T.ROAD, T.FLOOR, T.SAND, T.SHRINE, T.SNOW, T.PLANKS]);

const MOB_STYLE = {
  goblin: { color: '#5aa040', size: 0.5, name: 'a goblin' },
  skeleton: { color: '#d8d4c8', size: 0.7, name: 'a skeleton' },
  orc: { color: '#5a8a3a', size: 0.8, name: 'an orc' },
  ettin: { color: '#a07040', size: 1.0, name: 'an ettin' },
  dragon: { color: '#c03828', size: 1.3, name: 'a dragon' },
  wolf: { color: '#6a625a', size: 0.6, name: 'a wolf' },
  deer: { color: '#a8835a', size: 0.6, name: 'a deer' },
  sheep: { color: '#e8e4da', size: 0.5, name: 'a sheep' },
  pig: { color: '#d8a8a0', size: 0.5, name: 'a pig' },
  chicken: { color: '#e8d8b0', size: 0.3, name: 'a chicken' },
  villager: { color: '#b0a890', size: 0.6, name: 'a villager', sprite: 'player' },
  goblinking: { color: '#5aa040', size: 0.9, name: 'Skarg, the Goblin King', sprite: 'goblin', spriteScale: 1.5, boss: true },
  bonelord: { color: '#d8d4c8', size: 1.1, name: 'the Bone Lord', sprite: 'skeleton', spriteScale: 1.4, boss: true },
  wolfking: { color: '#6a625a', size: 0.9, name: 'Greyfang, the Wolf King', sprite: 'wolf', spriteScale: 1.6, boss: true },
  vyrmaur: { color: '#c03828', size: 1.6, name: 'Vyrmaur the Undying', sprite: 'dragon', spriteScale: 2.0, boss: true },
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
  props: [],            // furniture inside buildings (client-side dressing)
  me: null,             // my entry in players
  you: null,            // private stats from the server
  speech: new Map(),    // entity id -> { text, until, magic }
  floaters: [],         // { x, y, text, color, born }
  projectiles: [],      // { x, y, tx, ty, born, color }
  target: 0,            // selected mob id
  walkTarget: null,     // { x, y } click-to-move destination
  myTile: null,         // authoritative tile pos from last state message
  spells: {},
  weapons: {},
  qualities: [],
  minimapImage: null,
};

const QUALITY_COLORS = ['#9a9a9a', '#e8e2d0', '#6ac06a', '#6a9ae0', '#e0a040', '#ff5a3c'];

function weaponLabel(item) {
  const q = state.qualities[item.q];
  return (q && q.name ? q.name + ' ' : '') + (state.weapons[item.id] ? state.weapons[item.id].name : item.id);
}

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
      state.weapons = msg.weapons || {};
      state.qualities = msg.qualities || [];
      state.vendors = (msg.vendors || []).map((v) => ({ ...v, rx: v.x, ry: v.y, heading: 1 }));
      state.map = { w: msg.map.w, h: msg.map.h, chunk: msg.map.chunk };
      state.chunks.clear();
      state.wantedChunks.clear();
      state.buildings = msg.buildings || [];
      state.props = msg.props || [];
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
      if (e.x !== prev.x || e.y !== prev.y) {
        prev.heading = octant(e.x - prev.x, e.y - prev.y);
        prev.movedAt = Date.now();
      }
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
    case 'break':
      state.floaters.push({ x: msg.x, y: msg.y, text: '*crack*', color: '#d8a8a0', born: t });
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
    case 'f': case 'F': toggleFullscreen(); break;
    default: keys.add(ev.key.toLowerCase());
  }
});

document.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function castSpell(id) {
  send({ t: 'cast', spell: id, id: state.target });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
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
}, 65);

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
  const lines = vendor.goods.map((g, idx) => {
    if (g.type === 'weapon') {
      const def = state.weapons[g.item] || {};
      const qual = state.qualities[g.q] || {};
      const price = Math.round((def.price || 0) * (qual.priceMul || 1));
      const label = (qual.name ? qual.name + ' ' : '') + def.name;
      return `<div class="shop-row">
         <span style="color:${QUALITY_COLORS[g.q]}">${esc(label)}<small>${def.dmg[0]}-${def.dmg[1]} dmg${def.minSkill ? ' · needs ' + def.minSkill + ' swords' : ''}</small></span>
         <button data-idx="${idx}">${price} gp</button>
       </div>`;
    }
    return `<div class="shop-row">
       <span>${esc(g.name)}<small>${esc(g.desc || '')}</small></span>
       <button data-idx="${idx}">${g.price} gp</button>
     </div>`;
  }).join('');
  let forge = '';
  if (vendor.forge) {
    forge = '<div class="shop-title" style="margin-top:10px">Forge</div>' +
      Object.entries(state.weapons).filter(([, def]) => def.craft && !def.secret).map(([id, def]) =>
        `<div class="shop-row">
           <span>${esc(def.name)}<small>${def.craft.ore} ore · ${def.craft.logs} logs · ${def.craft.gold} gp</small></span>
           <button data-craft="${esc(id)}">Forge</button>
         </div>`).join('');
  }
  shopPanel.innerHTML =
    `<div class="shop-title">${esc(vendor.name)}</div>${lines}${forge}
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
  if (ev.target.dataset.idx !== undefined) send({ t: 'buy', idx: ev.target.dataset.idx | 0 });
  if (ev.target.dataset.craft) send({ t: 'craft', id: ev.target.dataset.craft });
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
  const eq = y.weapon != null && (y.items || []).find((i) => i.uid === y.weapon);
  document.getElementById('pack-line').textContent =
    `⛀ ${y.gold} gold · ${y.logs} logs · ${y.ore} ore` + (y.gems ? ` · ${y.gems} gems` : '');
  document.getElementById('weapon-line').textContent =
    '⚔ ' + (eq ? weaponLabel(eq) : 'Fists');
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
  const weaponsHtml = (y.items || []).map((it) => {
    const def = state.weapons[it.id] || {};
    const equipped = y.weapon === it.uid;
    const durFrac = it.dur / it.maxDur;
    const durColor = durFrac > 0.5 ? '#48b048' : durFrac > 0.25 ? '#c8a030' : '#c84030';
    return `<div class="inv-weapon${equipped ? ' equipped' : ''}">
       <div class="iw-top">
         <span style="color:${QUALITY_COLORS[it.q]}">${esc(weaponLabel(it))}</span>
         <span class="iw-dmg">${def.dmg ? def.dmg[0] + '-' + def.dmg[1] : ''}</span>
       </div>
       <div class="iw-dur"><div style="width:${Math.round(100 * durFrac)}%;background:${durColor}"></div></div>
       <div class="iw-actions">
         ${equipped
           ? '<button data-equip="0">Unequip</button>'
           : `<button data-equip="${it.uid}">Equip</button>`}
         <button data-sell="${it.uid}">Sell</button>
       </div>
     </div>`;
  }).join('') || '<div class="inv-row"><span class="inv-icon">✊</span><span class="inv-label">Fists only</span><span></span><span></span></div>';
  document.getElementById('inv-weapons').innerHTML = weaponsHtml;
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
  if (ev.target.dataset.equip !== undefined) {
    const uid = ev.target.dataset.equip | 0;
    send({ t: 'equip', uid: uid || null });
  }
  if (ev.target.dataset.sell !== undefined) send({ t: 'sell', uid: ev.target.dataset.sell | 0 });
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

// Terrain blending: tiles with higher priority bleed a soft fringe onto
// lower-priority neighbours. Masonry (floor/wall/shrine) stays crisp.
const TILE_BLEND = {
  [T.WATER]: { pal: 'water', pri: 0 },
  [T.SAND]: { pal: 'sand', pri: 1 },
  [T.ROCK]: { pal: 'dirt', pri: 2 },
  [T.ROAD]: { pal: 'dirt', pri: 3 },
  [T.GRASS]: { pal: 'grass', pri: 4 },
  [T.TREE]: { pal: 'grass', pri: 4 },
  [T.SNOW]: { pal: 'snow', pri: 5 },
  [T.SNOWTREE]: { pal: 'snow', pri: 5 },
};

// Neighbour offsets for the four diamond edges, in edge order
// (upper-left, upper-right, lower-right, lower-left).
const EDGE_NEIGHBOR = [[-1, 0], [0, -1], [1, 0], [0, 1]];

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
  [T.SNOW]: ['#e6ebf0', '#dde4ec'],
  [T.SNOWTREE]: ['#e6ebf0', '#dde4ec'],
  [T.PLANKS]: ['#946e48', '#8a6642'],
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
      e.rx += (e.x - e.rx) * 0.35;
      e.ry += (e.y - e.ry) * 0.35;
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

        // Feather higher-priority neighbours over this tile's edges.
        const blend = TILE_BLEND[tile];
        if (blend) {
          for (let e = 0; e < 4; e++) {
            const nb = TILE_BLEND[tileAt(tx + EDGE_NEIGHBOR[e][0], ty + EDGE_NEIGHBOR[e][1])];
            if (nb && nb.pri > blend.pri && nb.pal !== blend.pal) {
              Assets.drawFringe(ctx, nb.pal, e, sx, sy);
            }
          }
        }

        if (recipe.objectSets) {
          const sets = recipe.objectSets;
          const set = sets[Math.floor(hash((tx >> 4) * 7 + 3, (ty >> 4) * 13 + 5) * sets.length)];
          const name = set[Math.floor(hash(tx * 5 + 1, ty) * set.length)];
          drawables.push({ depth: tx + ty, kind: 'sprite', name, x: top.x, y: top.y + HH });
        } else if (recipe.object) {
          const name = recipe.object[Math.floor(hash(tx * 5 + 1, ty) * recipe.object.length)];
          drawables.push({ depth: tx + ty, kind: 'sprite', name, x: top.x, y: top.y + HH,
            stack: recipe.stack || 1,
            win: recipe.stack > 1 && hash(tx * 3 + 5, ty * 7 + 1) > 0.55
              ? (hash(tx * 11 + 2, ty * 5 + 3) > 0.5 ? 1 : 2) : 0 });
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
    drawables.push({ depth: b.x + b.w - 1 + b.y + b.h - 1 + 0.5, kind: 'roof', b });
  }

  // Furniture and trail dressing.
  for (const pr of state.props) {
    if (pr.x < x0 || pr.x > x1 || pr.y < y0 || pr.y > y1) continue;
    const s = worldToScreen(pr.x, pr.y, cam);
    if (pr.name === 'fx.campfire') {
      drawables.push({ depth: pr.x + pr.y, kind: 'campfire', x: s.x, y: s.y + HH });
    } else {
      drawables.push({ depth: pr.x + pr.y, kind: 'sprite', name: pr.name, x: s.x, y: s.y + HH, stack: 1 });
    }
  }

  // Entities join the same depth-sorted pass.
  for (const d of state.drops) drawables.push({ depth: d.x + d.y, kind: 'drop', e: d });
  for (const v of state.vendors) drawables.push({ depth: v.rx + v.ry, kind: 'vendor', e: v });
  for (const m of state.mobs.values()) drawables.push({ depth: m.rx + m.ry + 0.01, kind: 'mob', e: m });
  for (const p of state.players.values()) drawables.push({ depth: p.rx + p.ry + 0.01, kind: 'player', e: p });

  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) {
    switch (d.kind) {
      case 'sprite':
        if (d.stack > 1) {
          // Stacked wall cubes: plain blocks below, the variant on top.
          for (let i = 0; i < d.stack - 1; i++) Assets.drawFrame(ctx, 'wall.0', d.x, d.y - 32 * i);
          Assets.drawFrame(ctx, d.name, d.x, d.y - 32 * (d.stack - 1));
          if (d.win) drawWindow(d.x, d.y, d.win);
        } else {
          Assets.drawFrame(ctx, d.name, d.x, d.y);
        }
        break;
      case 'block': drawFallbackBlock(d); break;
      case 'shrine': drawShrine(d.x, d.y, time); break;
      case 'drop': drawDrop(d.e, cam, time); break;
      case 'roof': drawRoof(d.b, cam, time); break;
      case 'campfire': drawCampfire(d.x, d.y, time); break;
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

// A window on an upper wall cube. The cube art uses horizontal brick
// courses on its faces, so the window is axis-aligned to match: recessed
// dark opening under a stone lintel, with a sill and a faint lamp glow.
// face 1 = southeast (right of the cube's front corner), 2 = southwest.
function drawWindow(cx, cy, face) {
  const w = 12;
  const h = 15;
  const x = face === 1 ? cx + 9 : cx - 9 - w;
  const y = cy - 41;
  // lintel and sill in the wall's lighter stone
  ctx.fillStyle = '#aeb6a2';
  ctx.fillRect(x - 2, y - 3, w + 4, 3);
  ctx.fillRect(x - 2, y + h, w + 4, 3);
  ctx.fillStyle = '#7e8674';
  ctx.fillRect(x - 2, y + h + 3, w + 4, 1);
  // recessed opening
  ctx.fillStyle = '#171209';
  ctx.fillRect(x, y, w, h);
  // lamplight behind the panes
  ctx.fillStyle = 'rgba(252, 206, 110, 0.5)';
  ctx.fillRect(x + 2, y + 3, w - 4, h - 6);
  ctx.fillStyle = 'rgba(255, 235, 170, 0.35)';
  ctx.fillRect(x + 2, y + 3, w - 4, 3);
  // timber cross frame
  ctx.fillStyle = '#241a10';
  ctx.fillRect(x + (w >> 1) - 1, y, 2, h);
  ctx.fillRect(x, y + (h >> 1) - 1, w, 2);
  // outline
  ctx.strokeStyle = 'rgba(30, 26, 18, 0.8)';
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
}

// Roofs come in a few weathered colours so towns don't look stamped out.
const ROOF_PALETTES = [
  { far: '#6e3a30', near: '#a0523f', gable: '#874437', cap: '#552a22' }, // terracotta
  { far: '#39434f', near: '#5a6a7d', gable: '#4a5868', cap: '#2c343d' }, // slate
  { far: '#42512d', near: '#647c43', gable: '#536a38', cap: '#33401f' }, // moss
  { far: '#523c2f', near: '#7a5a45', gable: '#66493a', cap: '#3e2d23' }, // umber
];

// A gabled roof drawn as an isometric prism above the building's walls.
// UO-style: it vanishes while you stand inside.
function drawRoof(b, cam, time) {
  const pal = ROOF_PALETTES[(b.x * 7 + b.y * 13) % ROOF_PALETTES.length];
  const e = 0.3; // eave overhang in tiles
  const x0 = b.x - e;
  const y0 = b.y - e;
  const x1 = b.x + b.w - 1 + 1 + e; // walls occupy [x, x+w-1]
  const y1 = b.y + b.h - 1 + 1 + e;
  const lift = 62;       // top of the (two-cube) walls, in screen px
  const ridgeLift = 92;
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

  let chimney;
  if (b.w >= b.h) {
    // Ridge runs west-east.
    const my = (y0 + y1) / 2;
    const rA = P(x0 + 0.5, my, ridgeLift);
    const rB = P(x1 - 0.5, my, ridgeLift);
    poly([A, B, rB, rA], pal.far);    // north slope (faces away)
    poly([D, C, rB, rA], pal.near);   // south slope (faces camera)
    courses(D, C, rA, rB);
    poly([B, C, rB], pal.gable);      // east gable
    // ridge cap
    ctx.strokeStyle = pal.cap;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rA[0], rA[1]); ctx.lineTo(rB[0], rB[1]); ctx.stroke();
    ctx.lineWidth = 1;
    chimney = P(x0 + 1.4, my, ridgeLift);
  } else {
    // Ridge runs north-south.
    const mx = (x0 + x1) / 2;
    const rA = P(mx, y0 + 0.5, ridgeLift);
    const rB = P(mx, y1 - 0.5, ridgeLift);
    poly([A, D, rB, rA], pal.far);    // west slope (faces away-ish)
    poly([B, C, rB, rA], pal.near);   // east slope (faces camera)
    courses(B, C, rA, rB);
    poly([D, C, rB], pal.gable);      // south gable
    ctx.strokeStyle = pal.cap;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rA[0], rA[1]); ctx.lineTo(rB[0], rB[1]); ctx.stroke();
    ctx.lineWidth = 1;
    chimney = P(mx, y0 + 1.4, ridgeLift);
  }

  // Chimney and a lazy plume of smoke.
  ctx.fillStyle = '#6a6258';
  ctx.fillRect(chimney[0] - 4, chimney[1] - 14, 8, 14);
  ctx.fillStyle = '#544e46';
  ctx.fillRect(chimney[0] - 5, chimney[1] - 16, 10, 3);
  const seed = (b.x * 31 + b.y * 17) % 1000;
  for (let i = 0; i < 3; i++) {
    const k = ((time / 1800 + seed / 1000 + i / 3) % 1);
    const px = chimney[0] + Math.sin((k * 5 + i) * 2.2) * 4 + k * 8;
    const py = chimney[1] - 18 - k * 26;
    ctx.fillStyle = `rgba(200, 198, 192, ${0.3 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(px, py, 3 + k * 5, 0, Math.PI * 2);
    ctx.fill();
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
  } else if (d.item === 'weapon') {
    // A little sword, tinted by quality.
    const tint = QUALITY_COLORS[d.q ?? 1];
    ctx.save();
    ctx.translate(s.x, s.y - 4 + bob);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = tint;
    ctx.fillRect(-1.5, -10, 3, 14);
    ctx.fillStyle = '#5a4a30';
    ctx.fillRect(-5, 3, 10, 2.5);
    ctx.fillRect(-1.5, 5, 3, 5);
    ctx.restore();
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

// A small camp fire: crossed logs, flickering flame, ember glow.
function drawCampfire(cx, cy, time) {
  ctx.fillStyle = 'rgba(255, 150, 50, 0.10)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, 26, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5a4028';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy + 3); ctx.lineTo(cx + 8, cy - 3);
  ctx.moveTo(cx - 8, cy - 3); ctx.lineTo(cx + 8, cy + 3);
  ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const fl = Math.sin(time / (90 + i * 37) + i * 2.1) * 2;
    const h = 12 + i * 4 + fl * 2;
    ctx.fillStyle = ['rgba(255, 90, 30, 0.85)', 'rgba(255, 160, 40, 0.8)', 'rgba(255, 230, 120, 0.85)'][i];
    ctx.beginPath();
    ctx.moveTo(cx - 6 + i * 2, cy);
    ctx.quadraticCurveTo(cx + fl, cy - h, cx + 6 - i * 2, cy);
    ctx.closePath();
    ctx.fill();
  }
  const k = (time / 1400) % 1;
  ctx.fillStyle = `rgba(120, 120, 120, ${0.25 * (1 - k)})`;
  ctx.beginPath();
  ctx.arc(cx + Math.sin(time / 500) * 3, cy - 22 - k * 18, 3 + k * 4, 0, Math.PI * 2);
  ctx.fill();
}

function entityAnim(e) {
  if (e.a) return 'melee';
  if (Date.now() - (e.movedAt || 0) < 350) return 'run';
  return 'stance';
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

  const spriteKind = style.sprite || m.kind;
  const spriteScale = style.spriteScale || 1;
  const c = Assets.state.ok && Assets.creature(spriteKind);
  let labelY;
  if (c) {
    Assets.drawCreature(ctx, spriteKind, m.heading, entityAnim(m), time + m.id * 137, s.x, s.y, spriteScale);
    labelY = s.y - c.ay * spriteScale - 8;
  } else {
    const r = 22 * style.size;
    entityShadow(s.x, s.y + 2, r * 0.8);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y - r * 0.6, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    labelY = s.y - r * 1.6 - 10;
  }

  if (!style.sprite || style.boss) drawHpBar(s.x, labelY + 4, m.hp, m.maxhp);
  ctx.fillStyle = style.boss ? '#ffd060' : 'rgba(220, 214, 200, 0.85)';
  ctx.font = style.boss ? 'bold 12px Georgia' : '11px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(m.name || style.name, s.x, labelY);
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
    const wdef = p.w && state.weapons[p.w];
    Assets.drawCreature(ctx, 'player', p.heading, entityAnim(p), time + p.id * 137, s.x, s.y,
      1, wdef ? wdef.sprite : null);
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
    Assets.drawCreature(ctx, 'vendor', v.heading, 'stance', time, s.x, s.y);
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
    const e = state.players.get(id) || state.mobs.get(id) || state.vendors.find((v) => v.id === id);
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
  [T.SNOW]: [228, 234, 240], [T.SNOWTREE]: [196, 210, 218], [T.PLANKS]: [148, 110, 72],
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
