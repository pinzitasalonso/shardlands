'use strict';

// World generation: a 2048x2048 tile world, deterministically generated from
// a seed. Multi-octave noise shapes the island; biomes come from forest and
// dryness fields. Settlements, roads, ruins and a sprinkling of secrets are
// then carved on top, all placed by searching the generated terrain for
// suitable ground, so every structure sits on real land.
//
// generate() returns not just tiles but everything the game layer needs to
// know about the world: buildings (for roofs), vendors, mob spawner sites,
// and the secrets hidden out in the wilds.

const W = 2048;
const H = 2048;

const TILE = {
  WATER: 0,
  GRASS: 1,
  TREE: 2,
  ROCK: 3,
  ROAD: 4,
  FLOOR: 5,
  WALL: 6,
  SAND: 7,
  SHRINE: 8,
  SNOW: 9,
  SNOWTREE: 10,
  PLANKS: 11,
};

const WALKABLE = new Set([TILE.GRASS, TILE.ROAD, TILE.FLOOR, TILE.SAND, TILE.SHRINE, TILE.SNOW, TILE.PLANKS]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple value noise: a coarse grid of random values, sampled with bilinear
// interpolation and a smoothstep curve.
function makeNoise(rng, cell) {
  const gw = Math.ceil(W / cell) + 2;
  const gh = Math.ceil(H / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) grid[i] = rng();
  const smooth = (t) => t * t * (3 - 2 * t);
  return function (x, y) {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = smooth(gx - x0);
    const fy = smooth(gy - y0);
    const v = (xx, yy) => grid[yy * gw + xx];
    const top = v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx;
    const bot = v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
}

function generate(seed = 1337) {
  const rng = mulberry32(seed);
  const continent = makeNoise(rng, 256);
  const hills = makeNoise(rng, 80);
  const detail = makeNoise(rng, 18);
  const forest = makeNoise(rng, 28);
  const forestFine = makeNoise(rng, 9);
  const dryness = makeNoise(rng, 320);

  const tiles = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const edge = Math.max(Math.abs(dx), Math.abs(dy));
      const dome = 0.16 * (1 - Math.min(1, Math.hypot(dx, dy)));
      const e = continent(x, y) * 0.5 + hills(x, y) * 0.3 + detail(x, y) * 0.2 +
        dome - Math.pow(edge, 3) * 0.65;

      // The southeast bakes under the sun, the far north lies under snow,
      // and the rest of the island is green.
      const dry = dryness(x, y) * 0.6 + Math.max(0, (dx + dy) / 2) * 0.5;
      const cold = -dy * 0.75 + dryness(y, x) * 0.3 - 0.45;

      let t;
      if (e < 0.34) t = TILE.WATER;
      else if (e < 0.37) t = TILE.SAND;
      else if (e > 0.72) t = TILE.ROCK;
      else if (cold > 0.12) {
        // The frozen north: snowfields and frosted pines.
        if (forest(x, y) * 0.55 + forestFine(x, y) * 0.45 > 0.56 && e > 0.42) t = TILE.SNOWTREE;
        else t = TILE.SNOW;
      } else if (dry > 0.6) {
        // Desert: open sand, scattered rocks, the rare hardy tree.
        if (forestFine(x, y) > 0.85) t = TILE.TREE;
        else if (detail(x * 3 + 7, y * 3) > 0.88) t = TILE.ROCK;
        else t = TILE.SAND;
      } else if (forest(x, y) * 0.55 + forestFine(x, y) * 0.45 > 0.58 && e > 0.42) t = TILE.TREE;
      else t = TILE.GRASS;
      tiles[y * W + x] = t;
    }
  }

  const idx = (x, y) => y * W + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const set = (x, y, t) => { if (inBounds(x, y)) tiles[idx(x, y)] = t; };
  const get = (x, y) => (inBounds(x, y) ? tiles[idx(x, y)] : TILE.WATER);

  // How much of the box around (x, y) is dry land?
  const landScore = (cx, cy, r) => {
    let land = 0;
    let total = 0;
    for (let y = cy - r; y <= cy + r; y += 2) {
      for (let x = cx - r; x <= cx + r; x += 2) {
        total++;
        const t = get(x, y);
        if (t !== TILE.WATER) land++;
      }
    }
    return land / total;
  };

  // Find the most land-locked spot near (x, y).
  const settle = (cx, cy, search, r) => {
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < 60; i++) {
      const x = Math.round(cx + (rng() - 0.5) * 2 * search);
      const y = Math.round(cy + (rng() - 0.5) * 2 * search);
      if (!inBounds(x, y)) continue;
      const s = landScore(x, y, r);
      if (s > bestScore) { bestScore = s; best = { x, y }; }
      if (s === 1) break;
    }
    return bestScore > 0.85 ? best : null;
  };

  const flatten = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) > r) continue;
        if (get(x, y) !== TILE.WATER) set(x, y, TILE.GRASS);
      }
    }
  };

  const buildings = []; // { x, y, w, h } — used by the client to draw roofs
  const vendors = [];
  const spawners = [];
  const secrets = [];

  const props = []; // decorative furniture, rendered by the client

  const building = (x0, y0, w, h, doorX, doorY) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const isEdge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        set(x, y, isEdge ? TILE.WALL : TILE.PLANKS);
      }
    }
    set(doorX, doorY, TILE.PLANKS);
    buildings.push({ x: x0, y: y0, w, h });
  };

  const road = (x0, y0, x1, y1) => {
    // L-shaped: horizontal then vertical (or the reverse), like old trade routes.
    const horizFirst = rng() > 0.5;
    // Roads never pave over town stonework, walls or shrines.
    const pave = (x, y) => {
      const t = get(x, y);
      if (t !== TILE.FLOOR && t !== TILE.WALL && t !== TILE.SHRINE) set(x, y, TILE.ROAD);
    };
    const carve = (xa, ya, xb, yb) => {
      const sx = Math.sign(xb - xa) || 0;
      const sy = Math.sign(yb - ya) || 0;
      let x = xa;
      let y = ya;
      pave(x, y);
      while (x !== xb || y !== yb) {
        if (x !== xb) x += sx;
        else y += sy;
        pave(x, y);
      }
    };
    if (horizFirst) { carve(x0, y0, x1, y0); carve(x1, y0, x1, y1); }
    else { carve(x0, y0, x0, y1); carve(x0, y1, x1, y1); }
  };

  // ---- Briarhaven: the capital at the heart of the island ---------------------
  const CX = W / 2;
  const CY = H / 2;
  flatten(CX, CY, 22);
  for (let y = CY - 12; y <= CY + 12; y++) {
    for (let x = CX - 12; x <= CX + 12; x++) set(x, y, TILE.FLOOR);
  }
  building(CX - 11, CY - 11, 8, 6, CX - 7, CY - 6);  // smithy
  building(CX + 4, CY - 11, 8, 6, CX + 8, CY - 6);   // inn
  building(CX - 11, CY + 6, 8, 6, CX - 7, CY + 6);   // healer
  building(CX + 4, CY + 6, 8, 6, CX + 8, CY + 6);    // mage tower
  set(CX, CY - 7, TILE.SHRINE);
  props.push({ x: CX + 6, y: CY - 2, name: 'prop.well' });
  props.push({ x: CX - 6, y: CY + 2, name: 'prop.table' });  // market stall
  props.push({ x: CX - 5, y: CY + 3, name: 'prop.stool' });
  props.push({ x: CX - 9, y: CY - 9, name: 'prop.table' });  // smithy workbench
  props.push({ x: CX + 7, y: CY - 9, name: 'prop.table' });  // the inn's common table
  props.push({ x: CX + 8, y: CY - 8, name: 'prop.stool' });
  vendors.push({
    name: 'Bren the Blacksmith', x: CX - 8, y: CY - 8, forge: true,
    goods: [
      { type: 'weapon', item: 'dagger', q: 1 },
      { type: 'weapon', item: 'dagger', q: 2 },
      { type: 'weapon', item: 'sword', q: 1 },
      { type: 'weapon', item: 'sword', q: 2 },
      { type: 'weapon', item: 'mace', q: 1 },
      { type: 'weapon', item: 'battleaxe', q: 1 },
      { type: 'weapon', item: 'greatsword', q: 1 },
    ],
  });
  vendors.push({
    name: 'Mira the Alchemist', x: CX - 7, y: CY + 9,
    goods: [
      { item: 'heal', name: 'Greater Heal Potion', price: 45, desc: 'Restores 25-40 health.' },
      { item: 'mana', name: 'Mana Potion', price: 35, desc: 'Restores 20-30 mana.' },
    ],
  });
  const spawn = { x: CX, y: CY + 2 };

  // ---- Villages scattered across the island, joined to the capital by roads ----
  const VILLAGE_NAMES = ['Northhold', 'Saltmere', 'Eastgate', 'Wyrmwick', 'Thornbury',
    'Duskwell', 'Ferndale', 'Mossgrove', 'Amberford', 'Greyharbor'];
  const villages = [];
  let tries = 0;
  while (villages.length < 9 && tries++ < 400) {
    const a = rng() * Math.PI * 2;
    const d = 350 + rng() * 580;
    const vx = Math.round(CX + Math.cos(a) * d);
    const vy = Math.round(CY + Math.sin(a) * d);
    if (!inBounds(vx, vy)) continue;
    if (villages.some((v) => Math.hypot(v.x - vx, v.y - vy) < 320)) continue;
    const spot = settle(vx, vy, 90, 14);
    if (!spot) continue;
    villages.push({ ...spot, name: VILLAGE_NAMES[villages.length] });
  }

  for (const v of villages) {
    flatten(v.x, v.y, 15);
    for (let y = v.y - 6; y <= v.y + 6; y++) {
      for (let x = v.x - 8; x <= v.x + 8; x++) set(x, y, TILE.FLOOR);
    }
    // Every village is built a little differently.
    const w1 = 7 + Math.floor(rng() * 3);
    const h1 = 5 + Math.floor(rng() * 2);
    building(v.x - 7, v.y - 5, w1, h1, v.x - 7 + (w1 >> 1), v.y - 5 + h1 - 1); // shop
    const w2 = 5 + Math.floor(rng() * 3);
    const h2 = 6 + Math.floor(rng() * 2);
    building(v.x + 3, v.y - 5, w2, h2, v.x + 3 + (w2 >> 1), v.y - 5 + h2 - 1); // lodge
    if (rng() > 0.45) {
      building(v.x - 7, v.y + 2, 5, 4, v.x - 5, v.y + 2); // a humble hut
    }
    set(v.x, v.y + 4, TILE.SHRINE);
    props.push({ x: v.x + 1, y: v.y + 4, name: 'prop.table' }); // market stall
    props.push({ x: v.x + 2, y: v.y + 5, name: 'prop.stool' });
    const lcx = v.x + 3 + (w2 >> 1);
    const lcy = v.y - 5 + (h2 >> 1);
    if (lcy < v.y - 5 + h2 - 1) props.push({ x: lcx, y: lcy, name: 'prop.table' });
    spawners.push({ kind: 'villager', count: 3, x: v.x, y: v.y, r: 6 });
    // Livestock graze around every village.
    for (let k = 0; k < 2; k++) {
      const kind = ['sheep', 'pig', 'chicken'][Math.floor(rng() * 3)];
      const past = settle(v.x + (rng() - 0.5) * 70, v.y + (rng() - 0.5) * 70, 30, 6);
      if (past) spawners.push({ kind, count: 4, x: past.x, y: past.y, r: 7 });
    }
    const jitter = Math.floor(rng() * 11) - 5;
    vendors.push({
      name: `${['Aldric', 'Bryn', 'Cedany', 'Doran', 'Elspeth', 'Fenwick', 'Gilda', 'Hamon', 'Isolde'][vendors.length % 9]} of ${v.name}`,
      x: v.x - 3, y: v.y - 3,
      goods: [
        { item: 'heal', name: 'Greater Heal Potion', price: 45 + jitter, desc: 'Restores 25-40 health.' },
        { item: 'mana', name: 'Mana Potion', price: 35 + jitter, desc: 'Restores 20-30 mana.' },
        { type: 'weapon', item: 'dagger', q: 1 },
        { type: 'weapon', item: 'sword', q: 1 },
      ],
    });
    road(v.x, v.y + 5, CX, CY + 11);
    // A goblin camp lurks a little way outside every village.
    const camp = settle(v.x + (rng() - 0.5) * 240, v.y + (rng() - 0.5) * 240, 60, 10);
    if (camp) spawners.push({ kind: 'goblin', count: 6, x: camp.x, y: camp.y, r: 12 });
  }

  // ---- Ruined keeps with graveyards, haunted by the restless dead ---------------
  for (let k = 0; k < 4; k++) {
    const spot = settle(CX + (rng() - 0.5) * 1500, CY + (rng() - 0.5) * 1500, 120, 12);
    if (!spot) continue;
    flatten(spot.x, spot.y, 12);
    for (let y = spot.y - 6; y <= spot.y + 6; y++) {
      for (let x = spot.x - 8; x <= spot.x + 8; x++) {
        const isEdge = x === spot.x - 8 || x === spot.x + 8 || y === spot.y - 6 || y === spot.y + 6;
        if (isEdge) {
          if ((x * 7 + y * 13) % 5 !== 0) set(x, y, TILE.WALL);
        } else if ((x + y) % 6 === 0) set(x, y, TILE.ROCK);
      }
    }
    set(spot.x, spot.y - 6, TILE.GRASS); // the fallen gate
    spawners.push({ kind: 'skeleton', count: 7, x: spot.x, y: spot.y, r: 9 });
    if (k === 0) {
      // The Bone Lord holds court in the first keep.
      spawners.push({ kind: 'bonelord', count: 1, x: spot.x, y: spot.y, r: 4, respawnMs: 300_000 });
    }
    // The dead guard their treasure.
    secrets.push({ type: 'cache', x: spot.x, y: spot.y,
      loot: [['gold', 80, 200], ['heal', 1, 2]] });
  }

  // ---- Wilderness mob camps -----------------------------------------------------
  const camps = [
    ['orc', 6, 14, 16],
    ['orc', 5, 12, 12],
    ['ettin', 3, 10, 8],
    ['goblin', 7, 14, 10],
    ['skeleton', 5, 10, 6],
  ];
  for (const [kind, count, r, n] of camps) {
    for (let i = 0; i < n; i++) {
      const spot = settle(CX + (rng() - 0.5) * 1700, CY + (rng() - 0.5) * 1700, 100, r);
      if (spot && Math.hypot(spot.x - CX, spot.y - CY) > 120) {
        spawners.push({ kind, count, x: spot.x, y: spot.y, r });
      }
    }
  }

  // ---- Wildlife: deer in the woods, wolves prowling the wilds --------------------
  const scatter = (n, spread, fn) => {
    for (let i = 0; i < n; i++) {
      const spot = settle(CX + (rng() - 0.5) * spread, CY + (rng() - 0.5) * spread, 100, 8);
      if (spot) fn(spot);
    }
  };
  scatter(60, 1750, (s) => spawners.push({ kind: 'deer', count: 3, x: s.x, y: s.y, r: 10 }));
  scatter(34, 1800, (s) => {
    if (Math.hypot(s.x - CX, s.y - CY) > 150) {
      spawners.push({ kind: 'wolf', count: 2, x: s.x, y: s.y, r: 9 });
    }
  });

  // ---- Wilderness dangers: warrens, warbands, barrows, mounds ---------------------
  scatter(28, 1750, (s) => spawners.push({ kind: 'goblin', count: 5, x: s.x, y: s.y, r: 11 }));
  scatter(20, 1800, (s) => {
    if (Math.hypot(s.x - CX, s.y - CY) > 250) {
      spawners.push({ kind: 'orc', count: 5, x: s.x, y: s.y, r: 12 });
    }
  });
  scatter(16, 1800, (s) => {
    // A barrow of the restless dead, marked by standing stones.
    for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      if (get(s.x + ox, s.y + oy) !== TILE.WATER) set(s.x + ox, s.y + oy, TILE.ROCK);
    }
    spawners.push({ kind: 'skeleton', count: 4, x: s.x, y: s.y, r: 8 });
    if (rng() > 0.5) {
      secrets.push({ type: 'cache', x: s.x, y: s.y, loot: [['gold', 40, 120], ['heal', 0, 1]] });
    }
  });
  scatter(10, 1700, (s) => {
    if (Math.hypot(s.x - CX, s.y - CY) > 300) {
      spawners.push({ kind: 'ettin', count: 2, x: s.x, y: s.y, r: 9 });
    }
  });

  // ---- Farmsteads: a lonely hut, a well, and livestock ----------------------------
  scatter(12, 1500, (s) => {
    flatten(s.x, s.y, 7);
    building(s.x - 2, s.y - 2, 5, 4, s.x, s.y + 1);
    props.push({ x: s.x + 3, y: s.y, name: 'prop.well' });
    const kind = ['sheep', 'pig', 'chicken'][Math.floor(rng() * 3)];
    spawners.push({ kind, count: 3, x: s.x + 5, y: s.y + 4, r: 5 });
    spawners.push({ kind: 'villager', count: 1, x: s.x, y: s.y + 2, r: 4 });
  });

  // ---- Campsites: a fire still burning, but whose? ---------------------------------
  scatter(15, 1700, (s) => {
    flatten(s.x, s.y, 4);
    props.push({ x: s.x, y: s.y, name: 'fx.campfire' });
    props.push({ x: s.x + 1, y: s.y + 1, name: 'prop.stool' });
    if (rng() > 0.5) {
      secrets.push({ type: 'cache', x: s.x - 1, y: s.y, loot: [['gold', 20, 70], [rng() > 0.5 ? 'heal' : 'mana', 1, 1]] });
      spawners.push({ kind: rng() > 0.5 ? 'wolf' : 'goblin', count: 3, x: s.x + 6, y: s.y + 6, r: 6 });
    }
  });

  // ---- Quarries: rich rock, guarded ------------------------------------------------
  scatter(6, 1600, (s) => {
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const d = 2 + rng() * 3;
      const x = Math.round(s.x + Math.cos(a) * d);
      const y = Math.round(s.y + Math.sin(a) * d);
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROCK);
    }
    spawners.push({ kind: 'ettin', count: 2, x: s.x, y: s.y, r: 8 });
    secrets.push({ type: 'cache', x: s.x, y: s.y, loot: [['gold', 60, 140], ['gems', 0, 1]] });
  });

  // ---- Menhirs: lone stones that remember things -----------------------------------
  const MENHIR_WHISPERS = [
    'The stone is warm, though the sun is not.',
    'Something is buried here. Best leave it be.',
    'Runes spiral down the stone, older than any tongue you know.',
    'The grass refuses to grow in the stone\'s shadow.',
    'A traveller scratched a tally here: forty-one days. Then nothing.',
    'The stone hums when you press your ear to it. You step back.',
  ];
  let menhirs = 0;
  scatter(20, 1850, (s) => {
    if (get(s.x, s.y) === TILE.WATER) return;
    set(s.x, s.y, TILE.ROCK);
    secrets.push({ type: 'whisper', x: s.x, y: s.y, text: MENHIR_WHISPERS[menhirs++ % MENHIR_WHISPERS.length] });
  });
  // The capital's own pastures and nearby deer, so the world greets you alive.
  spawners.push({ kind: 'villager', count: 5, x: CX, y: CY, r: 9 });
  spawners.push({ kind: 'sheep', count: 4, x: CX - 24, y: CY + 18, r: 6 });
  spawners.push({ kind: 'chicken', count: 4, x: CX + 22, y: CY + 16, r: 5 });
  spawners.push({ kind: 'deer', count: 3, x: CX + 28, y: CY - 22, r: 8 });
  spawners.push({ kind: 'goblin', count: 4, x: CX - 38, y: CY - 34, r: 8 });

  // ---- Crowned terrors of the wild --------------------------------------------------
  const kingSpot = settle(CX + (rng() - 0.5) * 1400, CY + (rng() - 0.5) * 1400, 200, 9);
  if (kingSpot) {
    spawners.push({ kind: 'goblinking', count: 1, x: kingSpot.x, y: kingSpot.y, r: 4, respawnMs: 300_000 });
    spawners.push({ kind: 'goblin', count: 8, x: kingSpot.x, y: kingSpot.y, r: 10 });
    secrets.push({ type: 'cache', x: kingSpot.x + 2, y: kingSpot.y,
      loot: [['gold', 150, 350], ['gems', 1, 2]] });
  }
  const wolfSpot = settle(CX + (rng() - 0.5) * 1000, CY - 600 - rng() * 300, 200, 9);
  if (wolfSpot) {
    spawners.push({ kind: 'wolfking', count: 1, x: wolfSpot.x, y: wolfSpot.y, r: 4, respawnMs: 300_000 });
    spawners.push({ kind: 'wolf', count: 5, x: wolfSpot.x, y: wolfSpot.y, r: 9 });
  }

  // ---- Dragons roost far from civilisation ---------------------------------------
  let dragons = 0;
  tries = 0;
  while (dragons < 5 && tries++ < 350) {
    const spot = settle(CX + (rng() - 0.5) * 1800, CY + (rng() - 0.5) * 1800, 120, 10);
    if (!spot) continue;
    if (Math.hypot(spot.x - CX, spot.y - CY) < 600) continue;
    if (villages.some((v) => Math.hypot(v.x - spot.x, v.y - spot.y) < 300)) continue;
    spawners.push({ kind: 'dragon', count: 1, x: spot.x, y: spot.y, r: 10 });
    // Every roost has a hoard nearby.
    secrets.push({ type: 'cache', x: spot.x + 3, y: spot.y,
      loot: [['gold', 300, 700], ['gems', 1, 3], ['heal', 1, 2], ['mana', 1, 2]] });
    dragons++;
  }

  // ---- Secrets and surprises ------------------------------------------------------
  // Twin stone circles: step into one and the old magic carries you to its twin.
  const circles = [];
  tries = 0;
  while (circles.length < 10 && tries++ < 600) {
    const spot = settle(CX + (rng() - 0.5) * 1700, CY + (rng() - 0.5) * 1700, 110, 7);
    if (!spot) continue;
    if (circles.some((c) => Math.hypot(c.x - spot.x, c.y - spot.y) < 500)) continue;
    flatten(spot.x, spot.y, 7);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      set(Math.round(spot.x + Math.cos(a) * 4), Math.round(spot.y + Math.sin(a) * 4), TILE.ROCK);
    }
    set(spot.x, spot.y, TILE.FLOOR);
    circles.push(spot);
  }
  for (let i = 0; i + 1 < circles.length; i += 2) {
    const a = circles[i];
    const b = circles[i + 1];
    secrets.push({ type: 'portal', x: a.x, y: a.y, tx: b.x, ty: b.y });
    secrets.push({ type: 'portal', x: b.x, y: b.y, tx: a.x, ty: a.y });
  }

  // Hermits: lone huts deep in the wilds with suspiciously cheap potions.
  const HERMIT_NAMES = ['Old Wendel', 'Mother Issel', 'Cranky Tobben'];
  for (let hermits = 0; hermits < 3; hermits++) {
  const hermitSpot = settle(CX + (rng() - 0.5) * (1200 + hermits * 300), CY + (rng() - 0.5) * (1200 + hermits * 300), 150, 8);
  if (hermitSpot) {
    flatten(hermitSpot.x, hermitSpot.y, 6);
    building(hermitSpot.x - 2, hermitSpot.y - 2, 5, 4, hermitSpot.x, hermitSpot.y + 1);
    vendors.push({
      name: HERMIT_NAMES[hermits], x: hermitSpot.x, y: hermitSpot.y - 1,
      goods: [
        { item: 'heal', name: 'Greater Heal Potion', price: 25, desc: 'They will not say where they get them.' },
        { item: 'mana', name: 'Mana Potion', price: 20, desc: 'Tastes faintly of moss.' },
      ],
    });
    secrets.push({ type: 'whisper', x: hermitSpot.x, y: hermitSpot.y + 2,
      text: 'A trail of crushed herbs leads to a crooked hut. Someone lives out here.' });
  }
  }

  // Treasure caches buried in the far corners of the world.
  tries = 0;
  let caches = 0;
  while (caches < 20 && tries++ < 700) {
    const spot = settle(CX + (rng() - 0.5) * 1900, CY + (rng() - 0.5) * 1900, 80, 4);
    if (!spot) continue;
    if (Math.hypot(spot.x - CX, spot.y - CY) < 500) continue;
    secrets.push({ type: 'cache', x: spot.x, y: spot.y,
      loot: [['gold', 50, 150], ['gems', 0, 1], [rng() > 0.5 ? 'heal' : 'mana', 1, 1]] });
    caches++;
  }

  // Whispering places: flavour for travellers who wander off the roads.
  const WHISPERS = [
    'You feel watched. The trees here grow too close together.',
    'An old battle was fought here. The earth remembers.',
    'Sailors say a serpent sleeps beneath these waters.',
    'A circle of mushrooms. You decide not to step inside it.',
    'Someone carved a heart and two names into this rock, long ago.',
    'The wind carries a melody — gone the moment you listen for it.',
  ];
  tries = 0;
  let whispers = 0;
  while (whispers < WHISPERS.length && tries++ < 200) {
    const spot = settle(CX + (rng() - 0.5) * 1700, CY + (rng() - 0.5) * 1700, 90, 3);
    if (!spot) continue;
    secrets.push({ type: 'whisper', x: spot.x, y: spot.y, text: WHISPERS[whispers] });
    whispers++;
  }

  // ---- Watchtowers where the main roads leave the capital ------------------------
  for (const [ox, oy] of [[0, -60], [0, 60], [-60, 0], [60, 0]]) {
    const tx = CX + ox;
    const ty = CY + oy;
    flatten(tx, ty, 3);
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) set(x, y, TILE.WALL);
    }
  }

  return { w: W, h: H, tiles, buildings, vendors, spawners, secrets, spawn, villages, props };
}

function isWalkable(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  return WALKABLE.has(map.tiles[y * map.w + x]);
}

function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return TILE.WATER;
  return map.tiles[y * map.w + x];
}

// Find the nearest walkable tile to (x, y), spiralling outward.
function nearestWalkable(map, x, y) {
  for (let r = 0; r < 64; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(map, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return { x: map.w / 2, y: map.h / 2 + 2 };
}

module.exports = { TILE, generate, isWalkable, tileAt, nearestWalkable, W, H };
