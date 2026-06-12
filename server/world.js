'use strict';

// World generation: a 128x128 tile map, deterministically generated from a
// seed so every server boot produces the same Britannia-ish landmass.

const W = 128;
const H = 128;

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
  const elevation = makeNoise(rng, 16);
  const detail = makeNoise(rng, 6);
  const forest = makeNoise(rng, 9);

  const tiles = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Push elevation down near the map edges so the world is an island.
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const edge = Math.max(Math.abs(dx), Math.abs(dy));
      let e = elevation(x, y) * 0.75 + detail(x, y) * 0.25 - Math.pow(edge, 3) * 0.55;

      let t;
      if (e < 0.32) t = TILE.WATER;
      else if (e < 0.36) t = TILE.SAND;
      else if (e > 0.72) t = TILE.ROCK;
      else if (forest(x, y) > 0.62 && e > 0.42) t = TILE.TREE;
      else t = TILE.GRASS;
      tiles[y * W + x] = t;
    }
  }

  const set = (x, y, t) => {
    if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = t;
  };
  const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : TILE.WATER);

  // Roads: a north-south and east-west cross through the town. Roads bridge
  // water so the whole island stays reachable.
  for (let y = 8; y < H - 8; y++) set(64, y, TILE.ROAD);
  for (let x = 8; x < W - 8; x++) set(x, 64, TILE.ROAD);

  // The town of Briarhaven: a stone plaza with a few buildings and a shrine.
  for (let y = 54; y <= 74; y++) {
    for (let x = 54; x <= 74; x++) set(x, y, TILE.FLOOR);
  }
  const building = (x0, y0, w, h, doorX, doorY) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const isEdge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        set(x, y, isEdge ? TILE.WALL : TILE.FLOOR);
      }
    }
    set(doorX, doorY, TILE.FLOOR);
  };
  building(55, 55, 6, 5, 58, 59); // smithy
  building(68, 55, 6, 5, 70, 59); // inn
  building(55, 69, 6, 5, 58, 69); // healer
  building(68, 69, 6, 5, 70, 69); // mage tower

  set(64, 58, TILE.SHRINE); // ankh of resurrection

  // A ruined graveyard to the northwest where the dead are restless.
  for (let y = 28; y <= 38; y++) {
    for (let x = 24; x <= 38; x++) {
      if (get(x, y) !== TILE.WATER) set(x, y, (x + y) % 7 === 0 ? TILE.ROCK : TILE.GRASS);
    }
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
  return { x: 64, y: 66 };
}

module.exports = { TILE, generate, isWalkable, tileAt, nearestWalkable, W, H };
