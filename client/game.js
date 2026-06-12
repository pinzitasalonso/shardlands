'use strict';

// Shardlands client: connects to the server over WebSocket, renders the world
// on a canvas, and translates input into intents. The server owns all rules.

const TILE_SIZE = 36;
const T = { WATER: 0, GRASS: 1, TREE: 2, ROCK: 3, ROAD: 4, FLOOR: 5, WALL: 6, SAND: 7, SHRINE: 8 };
const WALKABLE = new Set([T.GRASS, T.ROAD, T.FLOOR, T.SAND, T.SHRINE]);

const MOB_STYLE = {
  mongbat: { color: '#9a5ab0', size: 0.5, name: 'a mongbat' },
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
  map: null,            // { w, h, tiles: Uint8Array }
  players: new Map(),   // id -> { ...snapshot, rx, ry } (rx/ry = render pos)
  mobs: new Map(),
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

// ---- networking -------------------------------------------------------------

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    const token = localStorage.getItem('shardlands:' + name.toLowerCase()) || undefined;
    send({ t: 'join', name, token });
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
      const raw = atob(msg.map.tiles);
      const tiles = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) tiles[i] = raw.charCodeAt(i);
      state.map = { w: msg.map.w, h: msg.map.h, tiles };
      const name = document.getElementById('name').value.trim();
      localStorage.setItem('shardlands:' + name.toLowerCase(), msg.token);
      buildMinimap();
      document.getElementById('login').classList.add('hidden');
      document.getElementById('hud').classList.remove('hidden');
      break;
    }

    case 'state': {
      syncEntities(state.players, msg.players);
      syncEntities(state.mobs, msg.mobs);
      state.me = state.players.get(state.myId) || null;
      if (state.me) state.myTile = { x: state.me.x, y: state.me.y };
      if (state.target && !state.mobs.has(state.target)) state.target = 0;
      break;
    }

    case 'you':
      state.you = msg;
      updateHud();
      break;

    case 'chat': {
      state.speech.set(msg.id, { text: msg.text, until: Date.now() + 5000, magic: !!msg.magic });
      log(`<b>${esc(msg.name)}:</b> ${esc(msg.text)}`, 'speech');
      break;
    }

    case 'sys':
      log(esc(msg.text), /risen|increased/.test(msg.text) ? 'gain' : 'sys');
      break;

    case 'fx':
      handleFx(msg);
      break;
  }
}

function syncEntities(map, list) {
  const seen = new Set();
  for (const e of list) {
    seen.add(e.id);
    const prev = map.get(e.id);
    if (prev) {
      // Keep render position for interpolation; adopt new authoritative pos.
      Object.assign(prev, e);
    } else {
      map.set(e.id, { ...e, rx: e.x, ry: e.y });
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
  if (document.activeElement === document.getElementById('name')) return;

  switch (ev.key) {
    case 'Enter': chatInput.focus(); ev.preventDefault(); break;
    case '1': castSpell('magicarrow'); break;
    case '2': castSpell('fireball'); break;
    case '3': castSpell('greaterheal'); break;
    case 'b': case 'B': send({ t: 'bandage' }); break;
    case 'g': case 'G': send({ t: 'gather' }); break;
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
  const wx = (ev.clientX + cam.x) / TILE_SIZE;
  const wy = (ev.clientY + cam.y) / TILE_SIZE;

  // Clicking a mob attacks it; clicking ground walks there.
  let best = null;
  let bestD = 0.9;
  for (const m of state.mobs.values()) {
    const d = Math.hypot(m.rx + 0.5 - wx, m.ry + 0.5 - wy);
    if (d < bestD) { best = m; bestD = d; }
  }
  if (best) {
    state.target = best.id;
    send({ t: 'attack', id: best.id });
    state.walkTarget = { x: best.x, y: best.y };
  } else {
    state.walkTarget = { x: Math.floor(wx), y: Math.floor(wy) };
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
  else send({ t: act });
});

// ---- login --------------------------------------------------------------------

const nameInput = document.getElementById('name');
nameInput.value = localStorage.getItem('shardlands:lastname') || '';

function tryLogin() {
  const name = nameInput.value.trim();
  if (!name) return loginError('Choose a name first.');
  localStorage.setItem('shardlands:lastname', name);
  loginError('');
  connect(name);
}

document.getElementById('play').addEventListener('click', tryLogin);
nameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') tryLogin();
});

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
  document.getElementById('pack-line').textContent = `⛀ ${y.gold} gold · ${y.logs} logs · ${y.ore} ore`;

  const list = document.getElementById('skills-list');
  list.innerHTML = Object.entries(y.skills)
    .map(([k, v]) => `<div class="skill-row"><span>${k[0].toUpperCase() + k.slice(1)}</span><span>${Number(v).toFixed(1)}</span></div>`)
    .join('');
}

document.getElementById('skills-toggle').addEventListener('click', () => {
  document.getElementById('skills-list').classList.toggle('hidden');
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
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  return m.tiles[y * m.w + x];
}

// Deterministic per-tile jitter so terrain doesn't look flat.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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
  const px = state.me ? state.me.rx : 64;
  const py = state.me ? state.me.ry : 64;
  return {
    x: (px + 0.5) * TILE_SIZE - canvas.width / 2,
    y: (py + 0.5) * TILE_SIZE - canvas.height / 2,
  };
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
  const x0 = Math.floor(cam.x / TILE_SIZE) - 1;
  const y0 = Math.floor(cam.y / TILE_SIZE) - 1;
  const x1 = x0 + Math.ceil(canvas.width / TILE_SIZE) + 2;
  const y1 = y0 + Math.ceil(canvas.height / TILE_SIZE) + 2;
  const time = Date.now();

  // Terrain.
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const tile = tileAt(tx, ty);
      const sx = tx * TILE_SIZE - cam.x;
      const sy = ty * TILE_SIZE - cam.y;
      const pair = TILE_COLORS[tile] || TILE_COLORS[T.WATER];
      ctx.fillStyle = pair[hash(tx, ty) > 0.5 ? 0 : 1];
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

      if (tile === T.WATER && hash(tx, ty * 7) > 0.85) {
        // Glints that drift with time.
        const phase = (time / 900 + hash(tx, ty) * 6) % 1;
        ctx.fillStyle = `rgba(140, 190, 220, ${0.35 * Math.sin(phase * Math.PI)})`;
        ctx.fillRect(sx + TILE_SIZE * 0.2, sy + TILE_SIZE * 0.45, TILE_SIZE * 0.5, 2);
      } else if (tile === T.GRASS && hash(tx * 3, ty) > 0.78) {
        ctx.fillStyle = 'rgba(30, 60, 22, 0.5)';
        ctx.fillRect(sx + TILE_SIZE * hash(ty, tx), sy + TILE_SIZE * 0.4, 2, 5);
      } else if (tile === T.WALL) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(sx, sy + TILE_SIZE - 5, TILE_SIZE, 5);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.strokeRect(sx + 0.5, sy + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
      } else if (tile === T.ROCK) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(sx + TILE_SIZE * 0.2, sy + TILE_SIZE * 0.8);
        ctx.lineTo(sx + TILE_SIZE * 0.5, sy + TILE_SIZE * (0.2 + hash(tx, ty) * 0.2));
        ctx.lineTo(sx + TILE_SIZE * 0.8, sy + TILE_SIZE * 0.8);
        ctx.fill();
      } else if (tile === T.SHRINE) {
        const glow = 0.5 + 0.3 * Math.sin(time / 400);
        ctx.fillStyle = `rgba(220, 190, 90, ${glow * 0.25})`;
        ctx.fillRect(sx - 4, sy - 4, TILE_SIZE + 8, TILE_SIZE + 8);
        ctx.strokeStyle = `rgba(240, 210, 110, ${glow})`;
        ctx.lineWidth = 3;
        // A little ankh.
        const cx = sx + TILE_SIZE / 2;
        ctx.beginPath();
        ctx.arc(cx, sy + 10, 5, 0, Math.PI * 2);
        ctx.moveTo(cx, sy + 15);
        ctx.lineTo(cx, sy + TILE_SIZE - 5);
        ctx.moveTo(cx - 7, sy + 20);
        ctx.lineTo(cx + 7, sy + 20);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }

  // Trees on top of terrain (drawn after ground so canopies overlap).
  for (let ty = y0; ty <= y1 + 1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tileAt(tx, ty) !== T.TREE) continue;
      const sx = tx * TILE_SIZE - cam.x + TILE_SIZE / 2;
      const sy = ty * TILE_SIZE - cam.y + TILE_SIZE / 2;
      ctx.fillStyle = '#4a3520';
      ctx.fillRect(sx - 2, sy, 4, TILE_SIZE * 0.4);
      const r = TILE_SIZE * (0.42 + hash(tx, ty) * 0.12);
      ctx.fillStyle = hash(tx + 9, ty) > 0.5 ? '#2d5a26' : '#33651f';
      ctx.beginPath();
      ctx.arc(sx, sy - TILE_SIZE * 0.15, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.arc(sx - r * 0.3, sy - TILE_SIZE * 0.15 - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Entities, painter's order by y.
  const drawables = [...state.mobs.values(), ...state.players.values()]
    .sort((a, b) => a.ry - b.ry);
  for (const e of drawables) {
    if (e.kind) drawMob(e, cam);
    else drawPlayer(e, cam, time);
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

function drawMob(m, cam) {
  const style = MOB_STYLE[m.kind];
  const sx = (m.rx + 0.5) * TILE_SIZE - cam.x;
  const sy = (m.ry + 0.5) * TILE_SIZE - cam.y;
  const r = TILE_SIZE * 0.32 * style.size;

  if (m.id === state.target) {
    ctx.strokeStyle = 'rgba(255, 80, 60, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sx, sy + r * 0.8, r, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = style.color;
  ctx.beginPath();
  ctx.arc(sx, sy - r * 0.2, r, 0, Math.PI * 2);
  ctx.fill();
  // Eyes so it reads as a creature.
  ctx.fillStyle = '#101010';
  ctx.beginPath();
  ctx.arc(sx - r * 0.35, sy - r * 0.4, r * 0.13, 0, Math.PI * 2);
  ctx.arc(sx + r * 0.35, sy - r * 0.4, r * 0.13, 0, Math.PI * 2);
  ctx.fill();

  drawHpBar(sx, sy - r - 10, m.hp, m.maxhp);
  ctx.fillStyle = 'rgba(220, 214, 200, 0.85)';
  ctx.font = '11px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(style.name, sx, sy - r - 14);
  ctx.textAlign = 'left';
}

function drawPlayer(p, cam, time) {
  const sx = (p.rx + 0.5) * TILE_SIZE - cam.x;
  const sy = (p.ry + 0.5) * TILE_SIZE - cam.y;
  const r = TILE_SIZE * 0.3;

  ctx.save();
  if (p.dead) ctx.globalAlpha = 0.45;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sx, sy + r * 0.9, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tunic.
  ctx.fillStyle = p.dead ? '#aab4c8' : p.id === state.myId ? '#2858a8' : '#7a3030';
  ctx.beginPath();
  ctx.moveTo(sx - r * 0.8, sy + r);
  ctx.lineTo(sx, sy - r * 0.4);
  ctx.lineTo(sx + r * 0.8, sy + r);
  ctx.closePath();
  ctx.fill();
  // Head.
  ctx.fillStyle = p.dead ? '#cfd6e4' : '#d8a878';
  ctx.beginPath();
  ctx.arc(sx, sy - r * 0.7, r * 0.45, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  if (!p.dead && p.hp < p.maxhp) drawHpBar(sx, sy - r - 12, p.hp, p.maxhp);
  ctx.fillStyle = p.id === state.myId ? '#ffd870' : '#dce4f0';
  ctx.font = '12px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, sx, sy - r - 16);
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
    const x = (p.x + (p.tx - p.x) * k + 0.5) * TILE_SIZE - cam.x;
    const y = (p.y + (p.ty - p.y) * k + 0.5) * TILE_SIZE - cam.y;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFloaters(cam, time) {
  state.floaters = state.floaters.filter((f) => time - f.born < 1100);
  ctx.font = 'bold 13px Georgia';
  ctx.textAlign = 'center';
  for (const f of state.floaters) {
    const k = (time - f.born) / 1100;
    const x = (f.x + 0.5) * TILE_SIZE - cam.x;
    const y = (f.y + 0.2) * TILE_SIZE - cam.y - k * 28;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = '#000';
    ctx.fillText(f.text, x + 1, y + 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, x, y);
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
    const e = state.players.get(id);
    if (!e) continue;
    const x = (e.rx + 0.5) * TILE_SIZE - cam.x;
    const y = (e.ry - 0.6) * TILE_SIZE - cam.y;
    const w = ctx.measureText(s.text).width;
    ctx.fillStyle = 'rgba(8, 10, 13, 0.75)';
    ctx.fillRect(x - w / 2 - 5, y - 13, w + 10, 18);
    ctx.fillStyle = s.magic ? '#9ab8ff' : '#f0ead8';
    ctx.fillText(s.text, x, y);
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
  const m = state.map;
  const img = new ImageData(m.w, m.h);
  for (let i = 0; i < m.tiles.length; i++) {
    const c = MINI_COLORS[m.tiles[i]] || [0, 0, 0];
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  state.minimapImage = img;
}

function drawMinimap() {
  if (!state.minimapImage) return;
  const mctx = minimap.getContext('2d');
  mctx.putImageData(state.minimapImage, 0, 0);
  mctx.fillStyle = '#ff4040';
  for (const p of state.players.values()) {
    mctx.fillStyle = p.id === state.myId ? '#ffffff' : '#ffd040';
    mctx.fillRect(p.x - 1, p.y - 1, 3, 3);
  }
}

requestAnimationFrame(render);
