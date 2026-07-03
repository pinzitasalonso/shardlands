'use strict';

// Shardlands client: connects to the server over WebSocket, renders the world
// on a canvas, and translates input into intents. The server owns all rules.
//
// The world is drawn in classic 2:1 isometric projection (Ultima Online
// style): tile (x, y) maps to screen ((x - y) * 32, (x + y) * 16). Art comes
// from the sprite manifest loaded by assets.js; if it is missing the world
// renders as flat-shaded diamonds instead.

// Top-down square projection, sized for 16px pixel-art packs drawn at 3x.
const TP = 48;      // tile size on screen
const HT = TP / 2;  // half tile — offset from a tile's top-left to its centre
const T = { WATER: 0, GRASS: 1, TREE: 2, ROCK: 3, ROAD: 4, FLOOR: 5, WALL: 6, SAND: 7, SHRINE: 8, SNOW: 9, SNOWTREE: 10, PLANKS: 11, SWAMP: 12, SWAMPTREE: 13, CAVE: 14 };

// Soft biome seams: tile id -> [fringe art kind (null = never spills),
// priority]. The higher-priority side lays its tufts onto the lower;
// water and roads receive fringes but never spill their own.
const FRINGES = {
  [T.WATER]: [null, 0], [T.ROAD]: [null, 0.5], [T.FLOOR]: [null, 0.4],
  [T.SAND]: ['sand', 1],
  [T.SWAMP]: ['swamp', 2], [T.SWAMPTREE]: ['swamp', 2],
  [T.GRASS]: ['grass', 3], [T.TREE]: ['grass', 3],
  [T.SNOW]: ['snow', 4], [T.SNOWTREE]: ['snow', 4],
};
const WALKABLE = new Set([T.GRASS, T.ROAD, T.FLOOR, T.SAND, T.SHRINE, T.SNOW, T.PLANKS, T.SWAMP, T.CAVE]);

const MOB_STYLE = {
  goblin: { color: '#5aa040', size: 0.5, name: 'a goblin' },
  skeleton: { color: '#d8d4c8', size: 0.7, name: 'a skeleton' },
  skelmage: { color: '#b8a8d8', size: 0.7, name: 'a skeleton mage' },
  orc: { color: '#5a8a3a', size: 0.8, name: 'an orc' },
  ettin: { color: '#a07040', size: 1.0, name: 'an ettin' },
  dragon: { color: '#c03828', size: 1.3, name: 'a dragon' },
  wolf: { color: '#6a625a', size: 0.6, name: 'a wolf' },
  deer: { color: '#a8835a', size: 0.6, name: 'a deer' , neutral: true },
  sheep: { color: '#e8e4da', size: 0.5, name: 'a sheep' , neutral: true },
  pig: { color: '#d8a8a0', size: 0.5, name: 'a pig' , neutral: true },
  chicken: { color: '#e8d8b0', size: 0.3, name: 'a chicken' , neutral: true },
  snake: { color: '#6a8a4a', size: 0.4, name: 'a bog serpent' },
  crab: { color: '#b06a4a', size: 0.4, name: 'a marsh crab' },
  boar: { color: '#6a5240', size: 0.6, name: 'a wild boar' },
  villager: { color: '#b0a890', size: 0.6, name: 'a villager', sprites: ['villager', 'villager2', 'villager3'] , friendly: true },
  guard: { color: '#8a93a5', size: 0.7, name: 'a town guard' , friendly: true },
  whitestag: { color: '#f0f0e8', size: 0.7, name: 'the White Stag', sprite: 'deer', spriteScale: 1.3, boss: true , neutral: true },
  goblinking: { color: '#5aa040', size: 0.9, name: 'Skarg, the Goblin King', sprite: 'goblin', spriteScale: 1.5, boss: true },
  bonelord: { color: '#d8d4c8', size: 1.1, name: 'the Bone Lord', spriteScale: 1.15, boss: true },
  wolfking: { color: '#6a625a', size: 0.9, name: 'Greyfang, the Wolf King', sprite: 'wolf', spriteScale: 1.6, boss: true },
  vyrmaur: { color: '#c03828', size: 1.6, name: 'Vyrmaur the Undying', sprite: 'dragon', spriteScale: 2.0, boss: true },
  zombie: { color: '#7a9a5a', size: 0.7, name: 'a shambling corpse' },
  ghost: { color: '#bcd8e8', size: 0.7, name: 'a restless ghost', ghostly: true },
  harpy: { color: '#b08a5a', size: 0.7, name: 'a harpy' },
  wolfrider: { color: '#8a7a5a', size: 0.7, name: 'a goblin wolf-rider' },
  vampire: { color: '#a03040', size: 1.0, name: 'the Crimson Count', boss: true },
  dwarf: { color: '#c8a878', size: 0.6, name: 'a dwarf miner' , friendly: true },
  dwarfguard: { color: '#b04838', size: 0.7, name: 'a dwarf warden' , friendly: true },
  dwarfpriest: { color: '#e8e0d0', size: 0.6, name: 'a rune-priest' , friendly: true },
  orcbrute: { color: '#4a7a30', size: 0.9, name: 'an orc brute' },
  orcwarlord: { color: '#4a7a30', size: 1.1, name: 'Gruk, Warlord of the Wastes', boss: true },
  elfranger: { color: '#5a8a4a', size: 0.7, name: 'an elf ranger' },
  dryad: { color: '#c05848', size: 0.7, name: 'a dryad' },
  treant: { color: '#7a5a38', size: 1.1, name: 'an elder treant' },
  lizardman: { color: '#4a8a6a', size: 0.7, name: 'a lizardman warrior' },
  raptor: { color: '#5aa080', size: 0.6, name: 'a swamp raptor' },
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
  villages: [],         // named settlements, for the world map
  cities: [],           // walled bastions: safe ground, bindable shrines
  me: null,             // my entry in players
  you: null,            // private stats from the server
  speech: new Map(),    // entity id -> { text, until, magic }
  floaters: [],         // { x, y, text, color, born }
  projectiles: [],      // { x, y, tx, ty, born, color }
  telegraphs: [],
  spellfx: [],       // Magic Book impact animations: { name, x, y, born }
  torches: [],       // wall torches in the deeps, lit during the night pass       // boss slam warnings: { x, y, born }
  target: 0,            // selected mob id
  walkTarget: null,     // { x, y } click-to-move destination
  path: null,           // A* steps toward walkTarget
  pathStuck: 0,         // ticks without progress -> recompute
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

// The world does not open until the art is in hand: the Play button (and
// token auto-login) wait on this. If loading fails, Assets.load resolves
// anyway and the flat-shaded fallback carries the day.
const assetsReady = Assets.load().then(() => {
  const btn = document.getElementById('play');
  btn.disabled = false;
  btn.textContent = 'Enter the World';
});

// ---- networking -------------------------------------------------------------

function connect(join) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    send({ t: 'join', ...join });
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
      if (msg.expired) {
        // dead session token: fall back to the password form quietly
        localStorage.removeItem('shardlands:token');
        loginError('');
      } else {
        loginError(msg.reason);
      }
      break;

    case 'welcome': {
      state.myId = msg.id;
      if (msg.token) localStorage.setItem('shardlands:token', msg.token);
      if (msg.charName) localStorage.setItem('shardlands:char', msg.charName);
      state.spells = msg.spells;
      state.weapons = msg.weapons || {};
      state.qualities = msg.qualities || [];
      state.vendors = (msg.vendors || []).map((v) => ({ ...v, rx: v.x, ry: v.y, heading: 1 }));
      state.map = { w: msg.map.w, h: msg.map.h, chunk: msg.map.chunk };
      state.chunks.clear();
      state.wantedChunks.clear();
      state.buildings = msg.buildings || [];
      state.props = msg.props || [];
      state.villages = msg.villages || [];
      state.cities = msg.cities || [];
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
      if (state.me) {
        const prev = state.myTile;
        if (prev && Math.hypot(state.me.x - prev.x, state.me.y - prev.y) > 4) {
          state.walkTarget = null;
        }
        state.myTile = { x: state.me.x, y: state.me.y };
      }
      if (state.target && !state.mobs.has(state.target)) state.target = 0;
      updateTargetFrame();
      if (state.myTile) {
        document.getElementById('coords').textContent = `${state.myTile.x} · ${state.myTile.y}`;
      }
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
      if (/risen|increased/.test(msg.text)) Sound.play('gain');
      else if (/pick up/.test(msg.text)) Sound.play(/gold/.test(msg.text) ? 'gold' : 'pickup');
      else if (/You drink/.test(msg.text)) Sound.play('drink');
      else if (/You chop/.test(msg.text)) Sound.play('chop');
      else if (/You dig/.test(msg.text)) Sound.play('mine');
      else if (/wriggling fish|not biting/.test(msg.text)) Sound.play('splash');
      else if (/You bandage/.test(msg.text)) Sound.play('bandage');
      else if (/You eat|hot meal|black crisp/.test(msg.text)) Sound.play('eat');
      else if (/You forge/.test(msg.text)) Sound.play('forge');
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

// A* over the loaded chunks, within a window around the player. Returns a
// list of steps (excluding the start tile), or null if unreachable — the
// caller falls back to the old greedy stepper. 8-directional, no corner
// cutting through unwalkable tiles.
function findPath(sx, sy, tx, ty) {
  const R = 56;
  if (Math.abs(tx - sx) > R || Math.abs(ty - sy) > R) return null;
  if (!WALKABLE.has(tileAt(tx, ty))) return null;
  const x0 = sx - R;
  const y0 = sy - R;
  const W = 2 * R + 1;
  const N = W * W;
  const id = (x, y) => (y - y0) * W + (x - x0);
  const inWin = (x, y) => x >= x0 && y >= y0 && x < x0 + W && y < y0 + W;
  const g = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  // binary heap of [f, nodeId]
  const heap = [];
  const push = (f, n) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par][0] <= heap[i][0]) break;
      [heap[par], heap[i]] = [heap[i], heap[par]];
      i = par;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (x, y) => Math.max(Math.abs(tx - x), Math.abs(ty - y));
  const start = id(sx, sy);
  g[start] = 0;
  push(h(sx, sy), start);
  const goal = id(tx, ty);
  let expanded = 0;
  while (heap.length && expanded < 6000) {
    const [, n] = pop();
    if (closed[n]) continue;
    closed[n] = 1;
    expanded++;
    if (n === goal) break;
    const nx = x0 + (n % W);
    const ny = y0 + ((n / W) | 0);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const mx = nx + dx;
        const my = ny + dy;
        if (!inWin(mx, my) || !WALKABLE.has(tileAt(mx, my))) continue;
        // no squeezing diagonally between two blockers
        if (dx && dy && (!WALKABLE.has(tileAt(nx + dx, ny)) || !WALKABLE.has(tileAt(nx, ny + dy)))) continue;
        const m = id(mx, my);
        const cost = g[n] + (dx && dy ? 1.41 : 1);
        if (cost < g[m]) {
          g[m] = cost;
          from[m] = n;
          push(cost + h(mx, my), m);
        }
      }
    }
  }
  if (from[goal] === -1 && goal !== start) return null;
  const path = [];
  for (let n = goal; n !== start && n !== -1; n = from[n]) {
    path.push({ x: x0 + (n % W), y: y0 + ((n / W) | 0) });
  }
  path.reverse();
  return path;
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
      Sound.play('hit');
      break;
    case 'miss':
      state.floaters.push({ x: msg.x, y: msg.y, text: 'miss', color: '#8a8a8a', born: t });
      Sound.play('miss');
      break;
    case 'heal':
      state.floaters.push({ x: msg.x, y: msg.y, text: '+' + msg.amount, color: '#5ac05a', born: t });
      state.spellfx.push({ name: 'greaterheal', x: msg.x, y: msg.y, born: t });
      Sound.play('heal');
      break;
    case 'die':
      state.floaters.push({ x: msg.x, y: msg.y, text: '✝', color: '#c8c8c8', born: t });
      Sound.play('die');
      break;
    case 'portal':
      state.floaters.push({ x: msg.x, y: msg.y, text: '✦ ✦ ✦', color: '#b08aff', born: t });
      Sound.play('portal');
      break;
    case 'break':
      state.floaters.push({ x: msg.x, y: msg.y, text: '*crack*', color: '#d8a8a0', born: t });
      Sound.play('break');
      break;
    case 'arrow':
      state.projectiles.push({ x: msg.x, y: msg.y, tx: msg.tx, ty: msg.ty, born: t, color: '#d8c8a0' });
      Sound.play('bow');
      break;
    case 'mbolt':
      state.projectiles.push({ x: msg.x, y: msg.y, tx: msg.tx, ty: msg.ty, born: t, color: '#b06aff' });
      Sound.play('spell');
      break;
    case 'poison':
      state.floaters.push({ x: msg.x, y: msg.y, text: '☠', color: '#7ac05a', born: t });
      state.spellfx.push({ name: 'poison', x: msg.x, y: msg.y, born: t });
      break;
    case 'evade':
      state.floaters.push({ x: msg.x, y: msg.y, text: 'evade', color: '#c0b070', born: t });
      break;
    case 'telegraph':
      state.telegraphs.push({ x: msg.x, y: msg.y, born: t });
      Sound.play('bell');
      break;
    case 'slam':
      state.floaters.push({ x: msg.x, y: msg.y, text: '💥', color: '#ffaa44', born: t });
      Sound.play('hit');
      break;
    case 'magicarrow':
    case 'fireball':
    case 'energybolt':
    case 'icebolt':
    case 'chainlightning':
    case 'chainarc':
      state.projectiles.push({
        x: msg.x, y: msg.y, tx: msg.tx, ty: msg.ty, born: t,
        color: { magicarrow: '#70b0ff', fireball: '#ff8030', energybolt: '#c0f0ff',
                 icebolt: '#9adcff', chainlightning: '#f0e878', chainarc: '#f0e878' }[msg.kind],
      });
      Sound.play({ magicarrow: 'marrow', fireball: 'fireball', energybolt: 'zap',
                   icebolt: 'marrow', chainlightning: 'zap', chainarc: 'zap' }[msg.kind]);
      state.spellfx.push({ name: msg.kind === 'chainarc' ? 'chainlightning' : msg.kind,
        x: msg.tx, y: msg.ty, born: t + 250 });
      setTimeout(() => {
        state.floaters.push({ x: msg.tx, y: msg.ty, text: '-' + msg.amount, color: '#e05848', born: Date.now() });
      }, 250);
      break;
    case 'haste':
      state.spellfx.push({ name: 'haste', x: msg.x, y: msg.y, born: t });
      Sound.play('gain');
      break;
  }
}

// ---- input -------------------------------------------------------------------

const keys = new Set();
const chatInput = document.getElementById('chat-input');

// On phones the chat log is a one-line ticker; tapping it unfolds history.
document.getElementById('chat-log').addEventListener('click', function () {
  this.classList.toggle('expanded');
  this.scrollTop = this.scrollHeight;
});

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
    case ' ': ev.preventDefault(); attackNearest(); break;
    case 'Enter': chatInput.focus(); ev.preventDefault(); break;
    case 'Escape':
      closeShop();
      document.getElementById('inventory').classList.add('hidden');
      document.getElementById('worldmap').classList.add('hidden');
      document.getElementById('settings').classList.add('hidden');
      break;
    case '1': triggerAction('cast:magicarrow'); break;
    case '2': triggerAction('cast:fireball'); break;
    case '3': triggerAction('cast:greaterheal'); break;
    case '6': triggerAction('cast:bless'); break;
    case '7': triggerAction('cast:poison'); break;
    case '8': triggerAction('cast:energybolt'); break;
    case '9': triggerAction('cast:icebolt'); break;
    case '0': triggerAction('cast:chainlightning'); break;
    case 'h': case 'H': triggerAction('cast:haste'); break;
    case '4': triggerAction('drink:heal'); break;
    case '5': triggerAction('drink:mana'); break;
    case 'b': case 'B': triggerAction('bandage'); break;
    case 'g': case 'G': triggerAction('gather'); break;
    case 'i': case 'I': toggleInventory(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': toggleWorldMap(); break;
    case 'o': case 'O': toggleSettings(); break;
    case 'c': case 'C': toggleCharPanel(); break;
    default: keys.add(ev.key.toLowerCase());
  }
});

document.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function castSpell(id) {
  send({ t: 'cast', spell: id, id: state.target });
}

// Visual cooldown sweeps on the hotbar. The server stays authoritative;
// these only mirror the known cooldowns for feedback.
const cooldowns = new Map(); // act -> { until, total }

function triggerAction(act) {
  if (act.startsWith('cast:')) castSpell(act.slice(5));
  else if (act.startsWith('drink:')) send({ t: 'drink', kind: act.slice(6) });
  else send({ t: act });
  const btn = document.querySelector(`#actions button[data-act="${act}"]`);
  const ms = btn && (btn.dataset.cd | 0);
  if (ms) cooldowns.set(act, { until: Date.now() + ms, total: ms });
  Sound.play(act.startsWith('cast:') ? 'spell' : 'click');
}

function updateCooldowns(time) {
  for (const [act, cd] of cooldowns) {
    const el = document.querySelector(`#actions button[data-act="${act}"] .cd`);
    if (!el) { cooldowns.delete(act); continue; }
    const left = cd.until - time;
    if (left <= 0) {
      el.style.height = '0';
      cooldowns.delete(act);
    } else {
      el.style.height = Math.round(100 * left / cd.total) + '%';
    }
  }
}

// Mini portraits for the unit frames, drawn from the creature atlases.
function drawPortrait(canvasId, kind, scaleHint) {
  const cv = document.getElementById(canvasId);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#11141a';
  g.fillRect(0, 0, cv.width, cv.height);
  if (!Assets.state.ok) return false;
  const c = Assets.creature(kind);
  if (!c) return false;
  const fit = Math.min(cv.width / c.cellW, cv.height / c.cellH) * (scaleHint || 1.7);
  Assets.drawCreature(g, kind, 1, 'stance', 0, cv.width / 2, cv.height * 0.97, fit);
  return true;
}

let portraitDrawn = false;
let targetPortraitKind = null;

function updateTargetFrame() {
  const tf = document.getElementById('target-frame');
  const mob = state.target ? state.mobs.get(state.target) : null;
  if (!mob) {
    tf.classList.add('hidden');
    targetPortraitKind = null;
    return;
  }
  const style = MOB_STYLE[mob.kind] || {};
  tf.classList.remove('hidden');
  tf.classList.toggle('boss', !!style.boss);
  document.getElementById('target-name').textContent = mob.name || style.name || mob.kind;
  const frac = Math.max(0, Math.min(1, mob.hp / mob.maxhp));
  document.getElementById('target-fill').style.width = (100 * frac) + '%';
  document.getElementById('target-text').textContent = `${Math.max(0, mob.hp)} / ${mob.maxhp}`;
  const bar = tf.querySelector('.bar');
  bar.setAttribute('aria-valuenow', Math.round(100 * frac));
  if (targetPortraitKind !== mob.kind) {
    const portraitKind = style.sprites
      ? style.sprites[mob.id % style.sprites.length]
      : style.sprite || mob.kind;
    if (drawPortrait('target-portrait', portraitKind, style.spriteScale ? 1.2 : 1.7)) {
      targetPortraitKind = mob.kind;
    }
  }
}

function toggleWorldMap() {
  const panel = document.getElementById('worldmap');
  panel.classList.toggle('hidden');
  if (panel.classList.contains('hidden') || !state.mini) return;
  const cv = document.getElementById('worldmap-canvas');
  const g = cv.getContext('2d');
  // base terrain from the downsampled overview
  const off = document.createElement('canvas');
  off.width = state.mini.w;
  off.height = state.mini.h;
  off.getContext('2d').putImageData(state.minimapImage, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(off, 0, 0, cv.width, cv.height);
  const k = cv.width / (state.mini.w * state.mini.s);
  g.font = 'bold 13px Georgia';
  g.textAlign = 'center';
  for (const v of state.villages) {
    g.fillStyle = '#120d08';
    g.fillText(v.name, v.x * k + 1, v.y * k - 5);
    g.fillStyle = '#f4e9c8';
    g.fillText(v.name, v.x * k, v.y * k - 6);
    g.fillStyle = '#d8b35e';
    g.fillRect(v.x * k - 2, v.y * k - 2, 4, 4);
  }
  // cities get the big letters and a keep icon — they're the safe harbours
  g.font = 'bold 16px Georgia';
  for (const c of state.cities) {
    g.fillStyle = '#120d08';
    g.fillText(c.name, c.x * k + 1, c.y * k - 8);
    g.fillStyle = '#ffe9a8';
    g.fillText(c.name, c.x * k, c.y * k - 9);
    g.fillStyle = '#e8c25e';
    g.fillRect(c.x * k - 3, c.y * k - 3, 6, 6);
    g.strokeStyle = '#120d08';
    g.strokeRect(c.x * k - 3.5, c.y * k - 3.5, 7, 7);
  }
  g.font = 'bold 13px Georgia';
  if (state.myTile) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(state.myTile.x * k, state.myTile.y * k, 4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#120d08';
    g.stroke();
  }
  g.textAlign = 'left';
}

function toggleSettings() {
  const panel = document.getElementById('settings');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    for (const which of ['master', 'sfx', 'amb', 'music']) {
      document.getElementById('vol-' + which).value = Sound.vols[which];
    }
  }
}

document.getElementById('settings').addEventListener('input', (ev) => {
  if (ev.target.dataset.vol) Sound.setVol(ev.target.dataset.vol, +ev.target.value);
});
document.getElementById('settings').addEventListener('click', (ev) => {
  if (ev.target.classList.contains('shop-close')) document.getElementById('settings').classList.add('hidden');
});
document.getElementById('worldmap').addEventListener('click', () => {
  document.getElementById('worldmap').classList.add('hidden');
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

// On small screens the character sheet starts hidden and 'open' shows it;
// on desktop it starts visible and 'collapsed' hides it. Clearing the
// opposite class keeps a rotation/resize from sticking it the wrong way.
function toggleCharPanel() {
  const el = document.getElementById('char-panel');
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  el.classList.toggle(mobile ? 'open' : 'collapsed');
  el.classList.remove(mobile ? 'collapsed' : 'open');
}

// Tapping a shopkeeper opens their wares; a mob attacks; ground walks.
// pickR is the forgiveness radius: fingers get more of it than cursors.
function pointerAction(cx, cy, pickR) {
  if (!state.me || !state.map) return;
  const cam = camera();
  const clickable = [];
  for (const v of state.vendors) clickable.push({ kind: 'vendor', e: v });
  for (const m of state.mobs.values()) clickable.push({ kind: 'mob', e: m });
  let best = null;
  let bestD = pickR;
  for (const c of clickable) {
    const s = worldToScreen(c.e.rx + 0.5, c.e.ry + 0.5, cam);
    const d = Math.hypot(s.x - cx, s.y - (cy + 24));
    if (d < bestD) { best = c; bestD = d; }
  }
  if (best && best.kind === 'vendor') {
    if (best.e.stories) send({ t: 'story', id: best.e.id });
    else openShop(best.e);
    return;
  }
  if (best) {
    state.target = best.e.id;
    send({ t: 'attack', id: best.e.id });
    state.walkTarget = { x: best.e.x, y: best.e.y };
    updateTargetFrame();
  } else {
    const w = screenToWorld(cx, cy, cam);
    setWalkTarget(Math.floor(w.x), Math.floor(w.y));
  }
}

canvas.addEventListener('mousedown', (ev) => pointerAction(ev.clientX, ev.clientY, 38));

// Spacebar: engage. Keeps hitting your current target while it lives and
// stays close; otherwise picks the nearest hostile. Townsfolk, guards and
// livestock are never auto-picked — killing those takes a deliberate click.
const AUTO_ATTACK_EXCLUDE = new Set(['villager', 'guard', 'sheep', 'pig', 'chicken', 'deer', 'whitestag']);

function attackNearest() {
  if (!state.me || state.you && state.you.dead) return;
  const cur = state.target ? state.mobs.get(state.target) : null;
  if (cur && Math.max(Math.abs(cur.x - state.me.x), Math.abs(cur.y - state.me.y)) <= 10) {
    send({ t: 'attack', id: cur.id });
    state.walkTarget = { x: cur.x, y: cur.y };
    return;
  }
  let best = null;
  let bestD = 8;
  for (const m of state.mobs.values()) {
    if (AUTO_ATTACK_EXCLUDE.has(m.kind)) continue;
    const d = Math.max(Math.abs(m.x - state.me.x), Math.abs(m.y - state.me.y));
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best) return;
  state.target = best.id;
  send({ t: 'attack', id: best.id });
  state.walkTarget = { x: best.x, y: best.y };
  updateTargetFrame();
}

function setWalkTarget(x, y) {
  state.walkTarget = { x, y };
  state.path = state.myTile ? findPath(state.myTile.x, state.myTile.y, x, y) : null;
  state.pathStuck = 0;
}

// ---- touch: virtual joystick + taps -------------------------------------------
// Put a thumb down and drag: a joystick blooms under it and drives continuous
// movement in the dragged screen direction. A short touch that never drags is
// a tap (walk / attack / talk, with a fat-finger pick radius). A second finger
// while steering taps immediately, so you can fight on the move.

const joyBase = document.getElementById('joystick');
const joyKnob = document.getElementById('joystick-knob');
const JOY_ENGAGE = 14; // px of drag before a touch becomes a joystick
const JOY_RANGE = 44;  // px the knob travels

const joy = { touchId: null, ox: 0, oy: 0, engaged: false, startAt: 0 };

// A screen-space drag is a world step directly: the camera is top-down.
function joyToWorld(sx, sy) {
  const m = Math.max(Math.abs(sx), Math.abs(sy));
  if (m < 0.001) return { dx: 0, dy: 0 };
  return {
    dx: Math.abs(sx) > m * 0.45 ? Math.sign(sx) : 0,
    dy: Math.abs(sy) > m * 0.45 ? Math.sign(sy) : 0,
  };
}

canvas.addEventListener('touchstart', (ev) => {
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    if (joy.touchId === null) {
      joy.touchId = t.identifier;
      joy.ox = t.clientX;
      joy.oy = t.clientY;
      joy.engaged = false;
      joy.startAt = Date.now();
    } else {
      // second finger: instant tap while the first keeps steering
      pointerAction(t.clientX, t.clientY, 52);
    }
  }
}, { passive: false });

canvas.addEventListener('touchmove', (ev) => {
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    if (t.identifier !== joy.touchId) continue;
    const sx = t.clientX - joy.ox;
    const sy = t.clientY - joy.oy;
    if (!joy.engaged && Math.hypot(sx, sy) >= JOY_ENGAGE) {
      joy.engaged = true;
      joyBase.style.left = joy.ox + 'px';
      joyBase.style.top = joy.oy + 'px';
      joyBase.classList.remove('hidden');
    }
    if (joy.engaged) {
      const len = Math.hypot(sx, sy) || 1;
      const k = Math.min(1, len / JOY_RANGE);
      joyKnob.style.transform =
        `translate(${(sx / len) * k * JOY_RANGE}px, ${(sy / len) * k * JOY_RANGE}px)`;
      state.joy = joyToWorld(sx, sy);
    }
  }
}, { passive: false });

function endTouch(ev) {
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    if (t.identifier !== joy.touchId) continue;
    if (!joy.engaged && Date.now() - joy.startAt < 450) {
      pointerAction(t.clientX, t.clientY, 52);
    }
    joy.touchId = null;
    joy.engaged = false;
    state.joy = null;
    joyKnob.style.transform = 'translate(0, 0)';
    joyBase.classList.add('hidden');
  }
}
canvas.addEventListener('touchend', endTouch, { passive: false });
canvas.addEventListener('touchcancel', endTouch, { passive: false });

// Movement intents: held keys win over click-to-move.
setInterval(() => {
  if (!state.me || document.activeElement === chatInput) return;
  let dx = 0;
  let dy = 0;
  if (keys.has('w') || keys.has('arrowup')) dy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) dy += 1;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  if (keys.has('d') || keys.has('arrowright')) dx += 1;

  // A held joystick steers exactly like held keys.
  if (!dx && !dy && state.joy) {
    dx = state.joy.dx;
    dy = state.joy.dy;
  }

  if (dx || dy) {
    state.walkTarget = null;
    state.path = null;
    send({ t: 'move', dx, dy });
    return;
  }

  const wt = state.walkTarget;
  const my = state.myTile;
  if (wt && my) {
    if (wt.x === my.x && wt.y === my.y) {
      state.walkTarget = null;
      state.path = null;
      return;
    }
    // If chasing a target, keep the destination fresh and re-path when it strays.
    if (state.target) {
      const mob = state.mobs.get(state.target);
      if (mob && (mob.x !== wt.x || mob.y !== wt.y)) {
        wt.x = mob.x;
        wt.y = mob.y;
        state.path = findPath(my.x, my.y, wt.x, wt.y);
      }
    }

    // Follow the A* path when we have one.
    if (state.path && state.path.length) {
      while (state.path.length && state.path[0].x === my.x && state.path[0].y === my.y) {
        state.path.shift();
        state.pathStuck = 0;
      }
      const next = state.path[0];
      if (next) {
        if (Math.abs(wt.x - my.x) <= 1 && Math.abs(wt.y - my.y) <= 1 && state.target) {
          state.walkTarget = null;
          state.path = null;
          return;
        }
        send({ t: 'move', dx: Math.sign(next.x - my.x), dy: Math.sign(next.y - my.y) });
        if (++state.pathStuck > 22) { // ~1.5s without reaching the node
          state.path = findPath(my.x, my.y, wt.x, wt.y);
          state.pathStuck = 0;
        }
        return;
      }
      state.path = null;
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
  const btn = ev.target.closest('button');
  if (!btn || !btn.dataset.act) return;
  triggerAction(btn.dataset.act);
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
         <img class="eq-icon" src="assets/ui/icons/eq/${esc(g.item)}.png" alt="">
         <span style="color:${QUALITY_COLORS[g.q]}">${esc(label)}<small>${def.dmg ? def.dmg[0] + '-' + def.dmg[1] + ' dmg' : def.dr ? '-' + def.dr + ' dmg taken' : def.block ? def.block + '% block' : ''}${def.minSkill ? ' · needs ' + def.minSkill + ' skill' : ''}</small></span>
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
           <img class="eq-icon" src="assets/ui/icons/eq/${esc(id)}.png" alt="">
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
  assetsReady.then(() => connect({ email, password, name }));
}

// A saved session token walks straight back into the world — no password,
// which matters most on a phone. An expired token falls back to the form.
// Either way, not before the sprites are loaded.
const savedToken = localStorage.getItem('shardlands:token');
if (savedToken) {
  const who = localStorage.getItem('shardlands:char');
  loginError(who ? `Returning as ${who}…` : 'Returning to the world…');
  assetsReady.then(() => connect({ token: savedToken }));
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
    (state.me ? state.me.name : '') + (y.title ? ' — ' + y.title : '') + (y.dead ? '  (ghost)' : '');
  document.getElementById('hp-fill').style.width = (100 * y.hp / y.maxhp) + '%';
  document.getElementById('hp-text').textContent = `${y.hp} / ${y.maxhp}`;
  document.getElementById('mana-fill').style.width = (100 * y.mana / y.maxmana) + '%';
  document.getElementById('mana-text').textContent = `${y.mana} / ${y.maxmana}`;
  document.querySelector('#player-frame .bar.hp').setAttribute('aria-valuenow', Math.round(100 * y.hp / y.maxhp));
  document.querySelector('#player-frame .bar.mana').setAttribute('aria-valuenow', Math.round(100 * y.mana / y.maxmana));
  document.getElementById('stats-line').textContent = `STR ${y.str}  DEX ${y.dex}  INT ${y.int}`;
  const eq = y.weapon != null && (y.items || []).find((i) => i.uid === y.weapon);
  document.getElementById('pack-line').textContent =
    `⛀ ${y.gold} gold · ${y.logs} logs · ${y.ore} ore` + (y.gems ? ` · ${y.gems} gems` : '') +
    (y.fish ? ` · ${y.fish} fish` : '') + (y.food ? ` · ${y.food} meals` : '');
  const eqA = y.armor != null && (y.items || []).find((i) => i.uid === y.armor);
  const eqO = y.offhand != null && (y.items || []).find((i) => i.uid === y.offhand);
  document.getElementById('weapon-line').textContent =
    '⚔ ' + (eq ? weaponLabel(eq) : 'Fists') +
    (eqA ? ' · 🛡 ' + weaponLabel(eqA) : '') +
    (eqO ? ' · ' + weaponLabel(eqO) : '') +
    (y.arrows ? ' · ➶ ' + y.arrows : '');
  const pots = y.pots || {};
  document.getElementById('pot-heal-count').textContent = pots.heal || 0;
  document.getElementById('pot-mana-count').textContent = pots.mana || 0;

  const list = document.getElementById('skills-list');
  list.innerHTML = Object.entries(y.skills)
    .map(([k, v]) => `<div class="skill-row"><span>${k[0].toUpperCase() + k.slice(1)}</span><span>${Number(v).toFixed(1)}</span></div>`)
    .join('');
}

document.getElementById('deeds-toggle').addEventListener('click', () => {
  const list = document.getElementById('deeds-list');
  list.classList.toggle('hidden');
  if (!list.classList.contains('hidden') && state.you) {
    const deeds = Object.keys(state.you.deeds || {});
    list.innerHTML = deeds.length
      ? deeds.map((d) => `<div class="skill-row"><span>⚑ ${esc(d)}</span></div>`).join('')
      : '<div class="skill-row"><span>No deeds yet. The world is waiting.</span></div>';
  }
});

document.getElementById('skills-toggle').addEventListener('click', () => {
  const list = document.getElementById('skills-list');
  list.classList.toggle('hidden');
  document.getElementById('skills-toggle').setAttribute('aria-expanded', String(!list.classList.contains('hidden')));
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
    const equipped = y.weapon === it.uid || y.armor === it.uid || y.offhand === it.uid;
    const durFrac = it.dur / it.maxDur;
    const durColor = durFrac > 0.5 ? '#48b048' : durFrac > 0.25 ? '#c8a030' : '#c84030';
    return `<div class="inv-weapon${equipped ? ' equipped' : ''}">
       <div class="iw-top">
         <span><img class="eq-icon" src="assets/ui/icons/eq/${esc(it.id)}.png" alt=""><span style="color:${QUALITY_COLORS[it.q]}">${esc(weaponLabel(it))}</span></span>
         <span class="iw-dmg">${def.dmg ? def.dmg[0] + '-' + def.dmg[1] + ' dmg' : def.dr ? '-' + def.dr + ' dmg taken' : def.block ? def.block + '% block' : ''}</span>
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
  const mats = y.mats || {};
  const px = (n) => `<img class="px-icon" src="assets/ui/icons/${n}.png" alt="">`;
  const rows = [
    [px('gold'), 'Gold', y.gold, ''],
    [px('heal'), 'Heal potions', pots.heal || 0, 'drink:heal'],
    [px('mana'), 'Mana potions', pots.mana || 0, 'drink:mana'],
    [px('logs'), 'Logs', y.logs, ''],
    [px('ore'), 'Ore', y.ore, ''],
    [px('gems'), 'Gems', y.gems || 0, ''],
    ['🐟', 'Raw fish', y.fish || 0, 'cook'],
    ['🍖', 'Raw meat', y.meat || 0, 'cook'],
    [px('food'), 'Hot meals', y.food || 0, 'eat'],
    ['❄', 'Frostwood', mats.frostwood || 0, ''],
    ['☀', 'Sunsteel', mats.sunsteel || 0, ''],
    ['🌿', 'Ironbark', mats.ironbark || 0, ''],
  ].concat((y.tmaps || []).map((m, i) =>
    ['🗺', 'Weathered map #' + (i + 1), 1, 'readmap:' + m.x + ',' + m.y])
  ).filter(([, label, count]) =>
    count > 0 || ['Gold', 'Heal potions', 'Mana potions', 'Logs', 'Ore'].includes(label));
  document.getElementById('inv-items').innerHTML = rows.map(([icon, label, count, act]) =>
    `<div class="inv-row">
       <span class="inv-icon">${icon}</span>
       <span class="inv-label">${label}</span>
       <span class="inv-count">${count}</span>
       ${act ? `<button data-act="${act}">${act === 'cook' ? 'cook' : act === 'eat' ? 'eat' : act.startsWith('readmap') ? 'read' : 'use'}</button>` : '<span></span>'}
     </div>`).join('');
}

document.getElementById('inventory').addEventListener('click', (ev) => {
  if (ev.target.id === 'inv-close') return document.getElementById('inventory').classList.add('hidden');
  const act = ev.target.dataset.act;
  if (act && act.startsWith('drink:')) send({ t: 'drink', kind: act.slice(6) });
  if (act === 'cook') send({ t: 'cook' });
  if (act === 'eat') send({ t: 'eat' });
  if (act && act.startsWith('readmap:')) {
    const [x, y] = act.slice(8).split(',').map(Number);
    document.getElementById('inventory').classList.add('hidden');
    toggleWorldMap();
    const cv = document.getElementById('worldmap-canvas');
    const g = cv.getContext('2d');
    const k = cv.width / (state.mini.w * state.mini.s);
    g.strokeStyle = '#ff4030';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x * k - 7, y * k - 7); g.lineTo(x * k + 7, y * k + 7);
    g.moveTo(x * k + 7, y * k - 7); g.lineTo(x * k - 7, y * k + 7);
    g.stroke();
    g.lineWidth = 1;
  }
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

// The minstrel follows you: a dirge in the barrow-deeps, a town tune inside
// settlements, a night air after dark, and out in the wilds the land itself
// picks the song — frost over the snows, a murk-tune in the mires, a heat-
// shimmer air in the southeastern desert, the road-song everywhere else.
setInterval(() => {
  if (!state.me || !state.myTile) return;
  const { x, y } = state.myTile;
  if (y < 64) return Sound.setTrack('deeps');
  const nearTown = state.villages.concat(state.cities).some((v) =>
    Math.abs(v.x - x) < 26 && Math.abs(v.y - y) < 26);
  if (nearTown) return Sound.setTrack('town');
  if (dayDarkness() > 0.3) return Sound.setTrack('night');
  const t = tileAt(x, y);
  if (t === T.SNOW || t === T.SNOWTREE) return Sound.setTrack('frost');
  if (t === T.SWAMP || t === T.SWAMPTREE) return Sound.setTrack('mire');
  // sand only counts as desert in the sun-baked southeast — beaches keep
  // the road-song
  if (t === T.SAND && x + y > 2300) return Sound.setTrack('dunes');
  Sound.setTrack('overworld');
}, 3000);

// Stream in the chunks around the player as they travel.
setInterval(() => {
  const m = state.map;
  if (!m || !state.me) return;
  const span = Math.ceil((Math.max(canvas.width, canvas.height) / (2 * TP) + 24) / m.chunk) + 1;
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
  [T.SNOW]: ['#e6ebf0', '#dde4ec'],
  [T.SNOWTREE]: ['#e6ebf0', '#dde4ec'],
  [T.PLANKS]: ['#946e48', '#8a6642'],
  [T.SWAMP]: ['#5a6b42', '#52613c'],
  [T.SWAMPTREE]: ['#4c5c3a', '#46553a'],
  [T.CAVE]: ['#4a443c', '#423d36'],
};

function camera() {
  const px = state.me ? state.me.rx + 0.5 : 64;
  const py = state.me ? state.me.ry + 0.5 : 64;
  // integer camera: every sprite rounds the same way, so pixels never swim
  return {
    ox: Math.round(canvas.width / 2 - px * TP),
    oy: Math.round(canvas.height / 2 - py * TP),
  };
}

// World (tile units, fractional ok) -> screen pixels. worldToScreen(tx, ty)
// of an integer tile is that tile's top-left corner on screen.
function worldToScreen(x, y, cam) {
  return { x: x * TP + cam.ox, y: y * TP + cam.oy };
}

function screenToWorld(px, py, cam) {
  return { x: (px - cam.ox) / TP, y: (py - cam.oy) / TP };
}

// Fallback ground: a flat square.
function fillSquare(sx, sy, color) {
  ctx.fillStyle = color;
  ctx.fillRect(sx, sy, TP, TP);
}

// 20-minute day. Darkness 0 at noon, ~0.62 at deepest night.
const DAY_MS = 20 * 60_000;
function dayDarkness() {
  if (state.myTile && state.myTile.y < 64) return 0.78; // the barrow-deeps
  const phase = (Date.now() % DAY_MS) / DAY_MS;        // 0..1
  return Math.max(0, -Math.cos(phase * Math.PI * 2)) * 0.62;
}

const lightCanvas = document.createElement('canvas');

// Cover the world in night, then punch warm light around fires, windows
// and the player's own lantern.
const weather = { drops: [], mode: null };

function drawWeather(cam, time) {
  if (!state.myTile) return;
  const here = tileAt(state.myTile.x, state.myTile.y);
  const snowy = here === T.SNOW || here === T.SNOWTREE;
  // rain comes in episodes keyed to the clock
  const episode = Math.floor(time / 300000) % 4 === 1;
  const mode = snowy ? 'snow' : episode && [T.GRASS, T.TREE, T.SWAMP, T.SWAMPTREE].includes(here) ? 'rain' : null;
  if (mode !== weather.mode) {
    weather.mode = mode;
    weather.drops.length = 0;
  }
  if (!mode) return;
  while (weather.drops.length < (mode === 'snow' ? 90 : 130)) {
    weather.drops.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, v: 1 + Math.random() });
  }
  ctx.strokeStyle = mode === 'snow' ? 'rgba(240, 245, 250, 0.7)' : 'rgba(170, 190, 220, 0.45)';
  ctx.lineWidth = mode === 'snow' ? 1.6 : 1;
  ctx.beginPath();
  for (const d of weather.drops) {
    if (mode === 'snow') {
      d.y += d.v * 1.1;
      d.x += Math.sin(time / 600 + d.y / 40) * 0.6;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + 1, d.y + 1);
    } else {
      d.y += d.v * 9;
      d.x -= d.v * 2;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2, d.y + 9);
    }
    if (d.y > canvas.height) { d.y = -5; d.x = Math.random() * canvas.width; }
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawNight(cam, time) {
  const dark = dayDarkness();
  if (dark < 0.03) return;
  lightCanvas.width = canvas.width;
  lightCanvas.height = canvas.height;
  const g = lightCanvas.getContext('2d');
  g.fillStyle = `rgba(8, 10, 30, ${dark})`;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalCompositeOperation = 'destination-out';
  const punch = (x, y, r, a) => {
    const grad = g.createRadialGradient(x, y, r * 0.15, x, y, r);
    grad.addColorStop(0, `rgba(0,0,0,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  if (state.me) {
    const s = worldToScreen(state.me.rx + 0.5, state.me.ry + 0.5, cam);
    punch(s.x, s.y - 20, 150, 0.85); // the traveller's lantern
  }
  for (const pr of state.props) {
    if (pr.name !== 'fx.campfire' && pr.name !== 'prop.lamp') continue;
    const s = worldToScreen(pr.x + 0.5, pr.y + 0.5, cam);
    if (s.x < -200 || s.x > canvas.width + 200 || s.y < -200 || s.y > canvas.height + 200) continue;
    if (pr.name === 'prop.lamp') {
      // street braziers: a smaller, steadier pool of light than a campfire
      punch(s.x, s.y - 14, 95 + Math.sin(time / 210 + pr.x * 2) * 5, 0.9);
    } else {
      punch(s.x, s.y - 6, 120 + Math.sin(time / 130 + pr.x) * 8, 0.95);
    }
  }
  for (const t of state.torches || []) {
    const s = worldToScreen(t.x, t.y, cam);
    punch(s.x, s.y, 85 + Math.sin(time / 170 + t.x * 3) * 7, 0.9);
  }
  ctx.drawImage(lightCanvas, 0, 0);
  // a faint warm tint over fires so night feels inhabited
}

function render() {
  requestAnimationFrame(render);
  // crisp pixels: 16px art at 3x must never be resampled (it also bleeds
  // neighbouring atlas cells into 1px seam lines); resets with canvas size
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.map || !state.me) return;

  const time = Date.now();

  // Glide render positions toward authoritative ones at the entity's real
  // walking speed (constant velocity, not exponential easing — continuous
  // movement becomes one smooth scroll instead of a dash per tile).
  const dtMs = Math.min(120, time - (state.lastFrameAt || time));
  state.lastFrameAt = time;
  const glide = (map, msPerTile) => {
    for (const e of map.values()) {
      const dx = e.x - e.rx;
      const dy = e.y - e.ry;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        e.rx = e.x;
        e.ry = e.y;
        // a big jump means a portal or recall: forget the old destination,
        // or the stale path marches you straight back through the door
        if (e.id === state.myId) {
          state.walkTarget = null;
          state.path = null;
        }
        continue;
      }
      // diagonal steps are granted more slowly (165ms vs 118ms)
      const step = dtMs / (dx && dy ? msPerTile * 1.4 : msPerTile);
      e.rx += Math.max(-step, Math.min(step, dx));
      e.ry += Math.max(-step, Math.min(step, dy));
    }
  };
  glide(state.players, 118); // the server grants a step every 118ms
  glide(state.mobs, 300);    // mobs stroll — a middling speedMs across kinds

  const cam = camera();
  // a stale cached manifest (no top-down recipes) must fall back, not crash
  const useSprites = Assets.state.ok && !!Assets.state.manifest.tilesTD;

  // Visible tile range, with margin for tall objects.
  const cx = Math.floor(state.me.rx);
  const cy = Math.floor(state.me.ry);
  const range = Math.ceil(Math.max(canvas.width, canvas.height) / (2 * TP)) + 3;
  const x0 = Math.max(0, cx - range);
  const x1 = Math.min(state.map.w - 1, cx + range);
  const y0 = Math.max(0, cy - range);
  const y1 = Math.min(state.map.h - 1, cy + range);

  const drawables = [];
  state.torches = [];

  // Ground pass, plus collection of y-sorted scenery. Depth is the world y
  // of a thing's feet: painter's algorithm, north to south.
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const top = worldToScreen(tx, ty, cam); // the tile's top-left corner
      const sx = top.x;
      const sy = top.y;
      if (sx < -TP - 4 || sx > canvas.width + 4 || sy < -3 * TP || sy > canvas.height + 4) continue;
      const tile = tileAt(tx, ty);
      const h = hash(tx, ty);

      if (useSprites) {
        const under = ty < 64 && Assets.tileTD('u' + tile);
        const recipe = under || Assets.tileTD(tile) || Assets.tileTD(T.WATER);
        Assets.drawGround(ctx, recipe, h, sx, sy);

        // Soft biome seams: a higher-priority neighbour lays its tufty
        // fringe over this tile's edge — grass over sand, snow over grass.
        const fr = FRINGES[tile];
        if (fr && ty >= 64) {
          const pr = fr[1];
          let f;
          if ((f = FRINGES[tileAt(tx, ty - 1)]) && f[0] && f[1] > pr) Assets.drawFrame(ctx, 'td.fr.' + f[0] + '.n', sx, sy);
          if ((f = FRINGES[tileAt(tx, ty + 1)]) && f[0] && f[1] > pr) Assets.drawFrame(ctx, 'td.fr.' + f[0] + '.s', sx, sy);
          if ((f = FRINGES[tileAt(tx - 1, ty)]) && f[0] && f[1] > pr) Assets.drawFrame(ctx, 'td.fr.' + f[0] + '.w', sx, sy);
          if ((f = FRINGES[tileAt(tx + 1, ty)]) && f[0] && f[1] > pr) Assets.drawFrame(ctx, 'td.fr.' + f[0] + '.e', sx, sy);
        }
        const belowT = tileAt(tx, ty + 1);
        if (under && recipe.torch && (belowT === T.CAVE || belowT === T.PLANKS) && hash(tx * 7, ty * 3) < 0.14) {
          drawables.push({ depth: ty, kind: 'sprite', name: 'td.o.torch', x: sx + HT, y: sy + TP + 12 });
          state.torches.push({ x: tx + 0.5, y: ty + 0.8 });
        }

        // Walls pick their piece by which neighbours are also wall, so
        // ramparts read as connected runs with proper corners.
        if (recipe.autowall) {
          const A = recipe.autowall;
          const wn = tileAt(tx, ty - 1) === T.WALL;
          const ws = tileAt(tx, ty + 1) === T.WALL;
          const ww = tileAt(tx - 1, ty) === T.WALL;
          const we = tileAt(tx + 1, ty) === T.WALL;
          let f = A.h;
          if (wn && ws && !ww && !we) f = A.v;
          else if (ws && we && !wn && !ww) f = A.tl;
          else if (ws && ww && !wn && !we) f = A.tr;
          else if (wn && we && !ws && !ww) f = A.bl;
          else if (wn && ww && !ws && !we) f = A.br;
          else if (ww && !we && !wn && !ws) f = A.capR; // a run ends going east
          else if (we && !ww && !wn && !ws) f = A.capL;
          else if (wn && !ws && !ww && !we) f = A.capB;
          else if (ws && !wn && !ww && !we) f = A.capT;
          Assets.drawFrame(ctx, f, sx, sy);
        }

        // Hand-drawn stamps are built to fill their tile (HoMM-style forest
        // clusters) and stay put; procedural placeholder scenery jitters so
        // it doesn't grid-lock.
        const jx = recipe.stamp ? 0 : (hash(tx * 13 + 7, ty * 3) - 0.5) * 22;
        const jy = recipe.stamp ? 0 : (hash(tx, ty * 17 + 9) - 0.5) * 10;
        if (recipe.objectSets) {
          // one set per coarse region, so whole forests share a species mix
          const sets = recipe.objectSets;
          const set = sets[Math.floor(hash((tx >> 4) * 7 + 3, (ty >> 4) * 13 + 5) * sets.length)];
          const name = set[Math.floor(hash(tx * 5 + 1, ty) * set.length)];
          drawables.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
        } else if (recipe.object) {
          const name = recipe.object[Math.floor(hash(tx * 5 + 1, ty) * recipe.object.length)];
          drawables.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
        } else if (recipe.decor && hash(tx, ty * 3 + 1) < recipe.decor.chance) {
          const name = recipe.decor.objects[Math.floor(h * recipe.decor.objects.length)];
          drawables.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
        }
        if (recipe.effect === 'water') drawWaterGlint(tx, ty, sx, sy, time);
        if (recipe.effect === 'shrine') drawables.push({ depth: ty, kind: 'shrine', x: sx + HT, y: sy + HT });
      } else {
        const pair = TILE_COLORS[tile] || TILE_COLORS[T.WATER];
        fillSquare(sx, sy, pair[h > 0.5 ? 0 : 1]);
        if (tile === T.TREE || tile === T.ROCK || tile === T.WALL) {
          drawables.push({ depth: ty, kind: 'block', tile, x: sx + HT, y: sy + TP, h });
        }
        if (tile === T.SHRINE) drawables.push({ depth: ty, kind: 'shrine', x: sx + HT, y: sy + HT });
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
    drawables.push({ depth: b.y + b.h - 0.5, kind: 'roof', b });
  }

  // Furniture and trail dressing.
  for (const pr of state.props) {
    if (pr.x < x0 || pr.x > x1 || pr.y < y0 || pr.y > y1) continue;
    const s = worldToScreen(pr.x, pr.y, cam);
    if (pr.name === 'fx.campfire') {
      drawables.push({ depth: pr.y, kind: 'campfire', x: s.x + HT, y: s.y + HT });
    } else {
      // server names props 'prop.well' etc.; the 16px frames are 'td.o.well'
      drawables.push({ depth: pr.y, kind: 'sprite', name: 'td.o.' + pr.name.split('.')[1],
        x: s.x + HT, y: s.y + TP });
    }
  }

  // Entities join the same depth-sorted pass.
  for (const d of state.drops) drawables.push({ depth: d.y, kind: 'drop', e: d });
  for (const v of state.vendors) drawables.push({ depth: v.ry + 0.005, kind: 'vendor', e: v });
  for (const m of state.mobs.values()) drawables.push({ depth: m.ry + 0.01, kind: 'mob', e: m });
  for (const p of state.players.values()) drawables.push({ depth: p.ry + 0.01, kind: 'player', e: p });

  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) {
    switch (d.kind) {
      case 'sprite': Assets.drawFrame(ctx, d.name, d.x, d.y); break;
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

  drawTelegraphs(cam, time);
  drawProjectiles(cam, time);
  drawSpellFx(cam, time);
  drawWeather(cam, time);
  drawNight(cam, time);
  drawFloaters(cam, time);
  drawSpeech(cam, time);
  drawMinimap();
  updateCooldowns(time);
  if (!portraitDrawn) portraitDrawn = drawPortrait('portrait', 'player');

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
  ctx.fillRect(sx + 4 + hash(ty, tx) * (TP - 20), sy + 6 + hash(tx * 3, ty) * (TP - 12), 14, 2);
}

function drawShrine(cx, cy, time) {
  const glow = 0.5 + 0.3 * Math.sin(time / 400);
  ctx.fillStyle = `rgba(220, 190, 90, ${glow * 0.22})`;
  ctx.beginPath();
  ctx.arc(cx, cy, HT - 3, 0, Math.PI * 2);
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
// (cx, cy) is the bottom-centre of the tile.
function drawFallbackBlock(d) {
  const { tile, x: cx, y: cy, h } = d;
  if (tile === T.TREE) {
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(cx - 3, cy - 16, 6, 14);
    ctx.fillStyle = h > 0.5 ? '#2d5a26' : '#33651f';
    ctx.beginPath();
    ctx.arc(cx, cy - 28, 14 + h * 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (tile === T.ROCK) {
    ctx.fillStyle = '#6e6a60';
    ctx.beginPath();
    ctx.ellipse(cx, cy - 12, 16, 10 + h * 5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (tile === T.WALL) {
    ctx.fillStyle = '#5c584e';
    ctx.fillRect(cx - HT, cy - TP, TP, TP);
    ctx.fillStyle = '#6e6a60';
    ctx.fillRect(cx - HT, cy - TP, TP, 6);
  }
}

// Roofs come in a few weathered colours so towns don't look stamped out.
const ROOF_PALETTES = [
  { far: '#6e3a30', near: '#a0523f', gable: '#874437', cap: '#552a22' }, // terracotta
  { far: '#39434f', near: '#5a6a7d', gable: '#4a5868', cap: '#2c343d' }, // slate
  { far: '#42512d', near: '#647c43', gable: '#536a38', cap: '#33401f' }, // moss
  { far: '#523c2f', near: '#7a5a45', gable: '#66493a', cap: '#3e2d23' }, // umber
];

// Buildings present a face to the camera: a stone facade along the south
// edge with lit windows and the door at street level, and a pitched,
// textured roof above it. UO-style: all of it vanishes while you stand
// inside.
function drawRoof(b, cam, time) {
  const pal = ROOF_PALETTES[(b.x * 7 + b.y * 13) % ROOF_PALETTES.length];
  const e = 0.22; // eave overhang, east/west/north only
  const tl = worldToScreen(b.x - e, b.y - e, cam);
  const br = worldToScreen(b.x + b.w + e, b.y + b.h, cam);
  const w = br.x - tl.x;
  const facadeH = TP * 2; // two art rows: the block's intended proportions
  const fy = br.y - facadeH;         // where roof meets wall
  const roofH = fy - tl.y;
  const ridgeY = Math.round(tl.y + roofH * 0.42);

  const roofTex = Assets.pattern(ctx, (b.x * 7 + b.y * 13) % 2 ? 'td.g.floor.0' : 'td.g.road.0');
  // patterns anchor to the building, not the screen, or textures swim
  const fill = (x, y, sw, sh, tex, fallback) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = tex || fallback;
    ctx.fillRect(0, 0, sw, sh);
    ctx.restore();
  };

  // ---- the facade: the keep block's own column arrangement, per tile ----
  // Window columns alternate with plain brick columns; each is two stacked
  // 16px cells drawn at 3x on the exact tile grid, so courses, arches and
  // the door all line up the way the sheet intends.
  const southDoor = b.dy === b.y + b.h - 1;
  fill(tl.x, fy, w, facadeH, null, '#7a4a3e'); // backing for the eave slivers
  for (let cx = b.x; cx < b.x + b.w; cx++) {
    const s = worldToScreen(cx, 0, cam);
    if (cx === b.dx && southDoor) {
      Assets.drawFrame(ctx, 'td.f.door', s.x + HT, br.y);
      continue;
    }
    const win = (cx - b.x) % 2 === 1;
    Assets.drawFrame(ctx, win ? 'td.f.wt' : 'td.f.pt', s.x, fy);
    Assets.drawFrame(ctx, win ? 'td.f.wb' : 'td.f.pb', s.x, fy + TP);
  }
  ctx.fillStyle = 'rgba(30, 15, 8, 0.28)'; // the wall sits in the roof's shade
  ctx.fillRect(tl.x, fy, w, 7);
  ctx.strokeStyle = 'rgba(30, 20, 10, 0.6)';
  ctx.strokeRect(tl.x + 0.5, fy + 0.5, w - 1, facadeH - 1);

  // ---- the roof: far slope shaded above the ridge, near slope below ----
  const shingles = (x, y, sw, sh, shade) => {
    fill(x, y, sw, sh, roofTex, shade ? pal.far : pal.near);
    if (shade) {
      ctx.fillStyle = 'rgba(24, 12, 6, 0.3)';
      ctx.fillRect(x, y, sw, sh);
    }
    ctx.strokeStyle = 'rgba(40, 16, 10, 0.5)';
    ctx.strokeRect(x + 0.5, y + 0.5, sw - 1, sh - 1);
    // shingle courses with staggered seams
    ctx.strokeStyle = 'rgba(40, 16, 10, 0.28)';
    ctx.beginPath();
    const n = Math.max(2, Math.round(sh / 14));
    for (let k = 1; k < n; k++) {
      ctx.moveTo(x, y + sh * k / n);
      ctx.lineTo(x + sw, y + sh * k / n);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40, 16, 10, 0.14)';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const off = (k % 2) * 13;
      for (let xx = x + off; xx < x + sw; xx += 26) {
        ctx.moveTo(xx, y + sh * k / n);
        ctx.lineTo(xx, y + sh * (k + 1) / n);
      }
    }
    ctx.stroke();
  };
  shingles(tl.x + 5, tl.y, w - 10, ridgeY - tl.y, true);   // far side, foreshortened
  shingles(tl.x, ridgeY, w, fy - ridgeY, false);           // the slope facing us
  ctx.strokeStyle = pal.cap;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tl.x + 4, ridgeY);
  ctx.lineTo(br.x - 4, ridgeY);
  ctx.stroke();
  ctx.lineWidth = 1;

  // Chimney and a lazy plume of smoke, a third of the way along the ridge.
  const chx = tl.x + w * 0.3;
  const chy = ridgeY;
  ctx.fillStyle = '#6a6258';
  ctx.fillRect(chx - 5, chy - 12, 10, 12);
  ctx.fillStyle = '#3a362e';
  ctx.fillRect(chx - 5, chy - 14, 10, 3);
  const seed = (b.x * 31 + b.y * 17) % 1000;
  for (let i = 0; i < 3; i++) {
    const k = ((time / 1800 + seed / 1000 + i / 3) % 1);
    const px = chx + Math.sin((k * 5 + i) * 2.2) * 5 + k * 10;
    const py = chy - 16 - k * 16;
    ctx.fillStyle = `rgba(200, 198, 192, ${0.3 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(px, py, 3 + k * 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // doors on any other face keep the flat marker on their own tile
  if (b.dx !== undefined && !southDoor) {
    const d = worldToScreen(b.dx, b.dy, cam);
    ctx.fillStyle = '#2a1c10';
    ctx.fillRect(d.x + 8, d.y + 4, TP - 16, TP - 4);
    ctx.fillStyle = '#8a6a42';
    ctx.fillRect(d.x + 8, d.y + 4, TP - 16, 6);
    ctx.fillStyle = '#6e5334';
    ctx.fillRect(d.x + 12, d.y + 12, TP - 24, TP - 14);
    ctx.fillStyle = '#d8b35e';
    ctx.fillRect(d.x + TP - 17, d.y + 26, 4, 4);
    ctx.strokeStyle = 'rgba(20, 12, 6, 0.8)';
    ctx.strokeRect(d.x + 11.5, d.y + 11.5, TP - 23, TP - 13);
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

  const spriteKind = style.sprites
    ? style.sprites[m.id % style.sprites.length]
    : style.sprite || m.kind;
  const spriteScale = style.spriteScale || 1;
  const c = Assets.state.ok && Assets.creature(spriteKind);
  let labelY;
  if (c) {
    if (style.ghostly) ctx.globalAlpha = 0.62; // you can see the stones through them
    Assets.drawCreature(ctx, spriteKind, m.heading, entityAnim(m), time + m.id * 137, s.x, s.y, spriteScale,
      style.overlay || null);
    if (style.ghostly) ctx.globalAlpha = 1;
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
  // UO-style name plates: gold for the crowned, blue for friends of the
  // realm, pale tan for harmless beasts, red for everything that bites.
  ctx.fillStyle = style.boss ? '#ffd060'
    : style.friendly ? 'rgba(140, 199, 255, 0.92)'
    : style.neutral ? 'rgba(208, 202, 173, 0.85)'
    : 'rgba(255, 150, 132, 0.92)';
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
    const overlays = [p.ar, p.oh, p.w]
      .map((id) => id && state.weapons[id] && state.weapons[id].sprite)
      .filter(Boolean);
    Assets.drawCreature(ctx, 'player', p.heading, entityAnim(p), time + p.id * 137, s.x, s.y,
      1, overlays);
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
  const model = v.model && Assets.state.ok && Assets.creature(v.model) ? v.model : 'vendor';
  const c = Assets.state.ok && Assets.creature(model);
  let labelY;
  if (c) {
    entityShadow(s.x, s.y, 11);
    Assets.drawCreature(ctx, model, v.heading, 'stance', time + (v.id || 0) * 211, s.x, s.y);
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
  ctx.fillStyle = v.stories ? '#c8a8e8' : '#88e0a0';
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

function drawTelegraphs(cam, time) {
  state.telegraphs = state.telegraphs.filter((a) => time - a.born < 1600);
  for (const a of state.telegraphs) {
    const k = (time - a.born) / 1600;
    const pulse = 0.35 + 0.3 * Math.sin(time / 90);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = worldToScreen(a.x + dx, a.y + dy, cam);
        ctx.fillStyle = `rgba(255, ${60 + 80 * k}, 40, ${pulse * (0.5 + k * 0.5)})`;
        ctx.fillRect(s.x + 1, s.y + 1, TP - 2, TP - 2);
      }
    }
  }
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

// Magic Book impact animations: four 24px frames at 3x, feet-anchored.
function drawSpellFx(cam, time) {
  state.spellfx = state.spellfx.filter((f) => time - f.born < 440);
  for (const f of state.spellfx) {
    const k = time - f.born;
    if (k < 0) continue; // still travelling
    const s = worldToScreen(f.x + 0.5, f.y + 0.9, cam);
    Assets.drawFrame(ctx, 'td.sfx.' + f.name + '.' + Math.min(3, Math.floor(k / 110)), s.x, s.y);
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
  [T.SWAMP]: [90, 107, 66], [T.SWAMPTREE]: [70, 86, 56], [T.CAVE]: [50, 46, 40],
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
  mctx.fillStyle = '#e8c25e';
  for (const c of state.cities) {
    mctx.fillRect(Math.round(c.x / s) - 1, Math.round(c.y / s) - 1, 3, 3);
  }
  for (const p of state.players.values()) {
    mctx.fillStyle = p.id === state.myId ? '#ffffff' : '#ffd040';
    mctx.fillRect(Math.round(p.x / s) - 1, Math.round(p.y / s) - 1, 3, 3);
  }
}

requestAnimationFrame(render);
