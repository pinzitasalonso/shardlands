'use strict';

// World generation: a 192x192 tile map, deterministically generated from a
// seed so every server boot produces the same Britannia-ish landmass.
//
// Biomes are carved out of three noise fields: elevation (water/land/rock),
// forest density, and dryness (the southeast of the island is a desert).
// On top of the terrain sit hand-placed structures: the town of Briarhaven
// at the crossroads, the village of Northhold, a ruined keep with its
// graveyard, watchtowers along the roads, a desert oasis and a stone circle.

const W = 192;
const H = 192;

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
};

const WALKABLE = new Set([TILE.GRASS, TILE.ROAD, TILE.FLOOR, TILE.SAND, TILE.SHRINE]);

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
  const grid = [];
  for (let i = 0; i < gw * gh; i++) grid.push(rng());
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
  const elevation = makeNoise(rng, 20);
  const detail = makeNoise(rng, 6);
  const forest = makeNoise(rng, 9);
  const dryness = makeNoise(rng, 28);

  const tiles = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Push elevation down near the map edges so the world is an island.
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const edge = Math.max(Math.abs(dx), Math.abs(dy));
      // A gentle dome keeps the heartland contiguous instead of archipelagic.
      const dome = 0.14 * (1 - Math.min(1, Math.hypot(dx, dy)));
      const e = elevation(x, y) * 0.66 + detail(x, y) * 0.26 + dome - Math.pow(edge, 3) * 0.62;

      // The southeast bakes under the sun; the rest of the island is green.
      const dry = dryness(x, y) * 0.6 + Math.max(0, (dx + dy) / 2) * 0.55;

      let t;
      if (e < 0.32) t = TILE.WATER;
      else if (e < 0.36) t = TILE.SAND;
      else if (e > 0.73) t = TILE.ROCK;
      else if (dry > 0.58) {
        // Desert: open sand, scattered rocks, the rare hardy tree.
        if (forest(x, y) > 0.78) t = TILE.TREE;
        else if (detail(x * 3 + 7, y * 3) > 0.86) t = TILE.ROCK;
        else t = TILE.SAND;
      } else if (forest(x, y) > 0.6 && e > 0.42) t = TILE.TREE;
      else t = TILE.GRASS;
      tiles[y * W + x] = t;
    }
  }

  const set = (x, y, t) => {
    if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = t;
  };
  const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : TILE.WATER);

  // Clear ground for a settlement: dry land in a radius becomes grass.
  const flatten = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) > r) continue;
        if (get(x, y) !== TILE.WATER) set(x, y, TILE.GRASS);
      }
    }
  };

  const building = (x0, y0, w, h, doorX, doorY) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const isEdge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        set(x, y, isEdge ? TILE.WALL : TILE.FLOOR);
      }
    }
    set(doorX, doorY, TILE.FLOOR);
  };

  // Roads: a north-south and east-west cross through Briarhaven, spurs to
  // the outlying settlements. Roads bridge water so everything is reachable.
  for (let y = 12; y < H - 12; y++) set(96, y, TILE.ROAD);
  for (let x = 12; x < W - 12; x++) set(x, 96, TILE.ROAD);
  for (let x = 56; x < 96; x++) set(x, 44, TILE.ROAD);   // to Northhold
  for (let y = 44; y < 96; y++) set(56, y, TILE.ROAD);
  for (let x = 44; x < 96; x++) set(x, 150, TILE.ROAD);  // to Saltmere

  // ---- Briarhaven: stone plaza, four buildings, the shrine ------------------
  flatten(96, 96, 14);
  for (let y = 86; y <= 106; y++) {
    for (let x = 86; x <= 106; x++) set(x, y, TILE.FLOOR);
  }
  building(87, 87, 6, 5, 90, 91);   // smithy
  building(100, 87, 6, 5, 102, 91); // inn
  building(87, 101, 6, 5, 90, 101); // healer (the alchemist lives here)
  building(100, 101, 6, 5, 102, 101); // mage tower
  set(96, 90, TILE.SHRINE); // ankh of resurrection

  // ---- Northhold: a logging village at the edge of the pinewoods ------------
  flatten(56, 44, 11);
  for (let y = 39; y <= 49; y++) {
    for (let x = 50; x <= 62; x++) set(x, y, TILE.FLOOR);
  }
  building(51, 40, 6, 5, 54, 44);   // herbalist
  building(58, 40, 5, 6, 60, 45);   // lodge
  set(56, 47, TILE.SHRINE); // a lesser ankh for northern travellers

  // ---- Saltmere: a fishing hamlet on the south road --------------------------
  flatten(44, 150, 8);
  for (let y = 147; y <= 153; y++) {
    for (let x = 40; x <= 49; x++) set(x, y, TILE.FLOOR);
  }
  building(41, 148, 5, 4, 43, 151);
  building(47, 147, 4, 5, 48, 151);

  // ---- The ruined keep and its graveyard (northwest) --------------------------
  flatten(38, 30, 12);
  for (let y = 24; y <= 36; y++) {
    for (let x = 30; x <= 46; x++) {
      const isEdge = x === 30 || x === 46 || y === 24 || y === 36;
      if (isEdge) {
        // Crumbled walls: gaps where time has won.
        if ((x * 7 + y * 13) % 5 !== 0) set(x, y, TILE.WALL);
        else set(x, y, TILE.GRASS);
      } else {
        set(x, y, (x + y) % 6 === 0 ? TILE.ROCK : TILE.GRASS);
      }
    }
  }
  set(38, 24, TILE.GRASS); // the old gate
  set(38, 36, TILE.GRASS);

  // ---- Watchtowers where the roads leave the heartland ------------------------
  const tower = (cx, cy) => {
    flatten(cx, cy, 3);
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) set(x, y, TILE.WALL);
    }
  };
  tower(92, 48);
  tower(92, 120);
  tower(48, 92);
  tower(148, 100);

  // ---- A desert oasis ----------------------------------------------------------
  for (let y = 146; y <= 150; y++) {
    for (let x = 142; x <= 146; x++) {
      if (Math.hypot(x - 144, y - 148) <= 2) set(x, y, TILE.WATER);
    }
  }
  for (const [ox, oy] of [[-3, -1], [3, 0], [0, 3], [-2, 2], [2, -3]]) {
    if (get(144 + ox, 148 + oy) === TILE.SAND) set(144 + ox, 148 + oy, TILE.TREE);
  }

  // ---- The standing stones on the north downs -----------------------------------
  flatten(96, 22, 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    set(Math.round(96 + Math.cos(a) * 4), Math.round(22 + Math.sin(a) * 4), TILE.ROCK);
  }

  return { w: W, h: H, tiles };
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
  for (let r = 0; r < 32; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(map, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return { x: 96, y: 98 };
}

module.exports = { TILE, generate, isWalkable, tileAt, nearestWalkable, W, H };
