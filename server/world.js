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
  SWAMP: 12,
  SWAMPTREE: 13,
  CAVE: 14,
  STONEROAD: 15,
};

const WALKABLE = new Set([TILE.GRASS, TILE.ROAD, TILE.FLOOR, TILE.SAND, TILE.SHRINE, TILE.SNOW, TILE.PLANKS, TILE.SWAMP, TILE.CAVE, TILE.STONEROAD]);

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

// Buildings the world builder may place. Kept in worldgen's vocabulary so
// the editor, applyEdits and the live server all agree on one list.
const BUILDING_KINDS = ['smithy', 'inn', 'healer', 'magetower', 'shop', 'lodge'];

// Interior rooms live on row 54 of the dead strip. Worldgen allocates
// slots from x=24 rightward (~35 rooms); edit-placed buildings allocate
// from here rightward. The barrow-deeps stay in rows 8-44, so the row is
// otherwise untouched ocean.
const EDIT_INTERIOR_X0 = 1200;
const EDIT_INTERIOR_MAX = 50;

// Stamp a complete shopfront onto a world: snug lawn, two-tile solid base,
// worn doorstep, the sprite prop, and a furnished interior room in the
// dead strip joined by a door-portal pair. `ctx` is anything shaped like
// { w, h, tiles, props, secrets } — worldgen's locals during generation,
// or the live map at edit time. `onTile` (optional) hears every tile
// write so a running server can broadcast them. Returns the room centre.
function placeBuilding(ctx, bx, by, name, interiorX, onTile) {
  const set = (x, y, t) => {
    if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) return;
    ctx.tiles[y * ctx.w + x] = t;
    if (onTile) onTile(x, y, t);
  };
  for (let y = by - 1; y <= by + 1; y++) {
    for (let x = bx - 1; x <= bx + 2; x++) set(x, y, TILE.GRASS);
  }
  set(bx, by, TILE.WALL);
  set(bx + 1, by, TILE.WALL);
  ctx.props.push({ x: bx, y: by, name: 'prop.' + name });
  // the interior: stone shell, plank floor, a hearth against the north wall
  const ix = interiorX;
  const iy = 54;
  for (let y = iy - 3; y <= iy + 3; y++) {
    for (let x = ix - 4; x <= ix + 4; x++) {
      const edge = y === iy - 3 || y === iy + 3 || x === ix - 4 || x === ix + 4;
      set(x, y, edge ? TILE.ROCK : TILE.PLANKS);
    }
  }
  const door = { x: bx, y: by + 1 };
  const entry = { x: ix, y: iy + 2 };
  set(door.x, door.y, TILE.ROAD); // a worn doorstep marks the way in
  ctx.secrets.push({ type: 'portal', x: door.x, y: door.y, tx: entry.x, ty: entry.y, door: true });
  ctx.secrets.push({ type: 'portal', x: entry.x, y: entry.y, tx: door.x, ty: door.y, door: true });
  ctx.props.push({ x: ix, y: iy - 2, name: 'fx.campfire' });
  ctx.props.push({ x: ix - 2, y: iy, name: 'prop.table' });
  ctx.props.push({ x: ix - 1, y: iy + 1, name: 'prop.stool' });
  if (name === 'inn' || name === 'lodge') {
    // a common room seats more than one traveller
    ctx.props.push({ x: ix + 2, y: iy, name: 'prop.table' });
    ctx.props.push({ x: ix + 2, y: iy + 1, name: 'prop.stool' });
    ctx.props.push({ x: ix - 2, y: iy - 1, name: 'prop.stool' });
  }
  if (name === 'smithy' || name === 'shop') {
    ctx.props.push({ x: ix + 2, y: iy - 1, name: 'prop.chest' });
  }
  // every lawn is kept: daisy beds by the door, trimmed bushes behind
  ctx.props.push({ x: bx - 1, y: by + 1, name: 'prop.flowers' + ((bx + by) % 3) });
  ctx.props.push({ x: bx + 2, y: by + 1, name: 'prop.flowers' + ((bx * 3 + by) % 3) });
  ctx.props.push({ x: bx - 1, y: by - 1, name: 'prop.bush' + (bx % 2) });
  ctx.props.push({ x: bx + 2, y: by - 1, name: 'prop.bush' + ((bx + 1) % 2) });
  return { x: ix, y: iy };
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
      else if (e > 0.74) t = TILE.ROCK;
      else if (cold > 0.12) {
        // The frozen north: snowfields and frosted pines.
        if (forest(x, y) * 0.55 + forestFine(x, y) * 0.45 > 0.58 && e > 0.42) t = TILE.SNOWTREE;
        else t = TILE.SNOW;
      } else if (e < 0.45 && dry < 0.33) {
        // Lowland mires: sodden ground and drowned trees.
        t = forestFine(x, y) > 0.72 ? TILE.SWAMPTREE : TILE.SWAMP;
      } else if (dry > 0.6) {
        // Desert: open sand, scattered rocks, the rare hardy tree.
        if (forestFine(x, y) > 0.85) t = TILE.TREE;
        else if (detail(x * 3 + 7, y * 3) > 0.88) t = TILE.ROCK;
        else t = TILE.SAND;
      } else if (forest(x, y) * 0.55 + forestFine(x, y) * 0.45 > 0.6 && e > 0.42) t = TILE.TREE;
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

  // Worldgen consumes interior slots from x=24 rightward; the world
  // builder's edit-placed buildings consume from EDIT_INTERIOR_X0 (far
  // side of the strip) so the two can never collide.
  let interiorX = 24;
  const shopfront = (bx, by, name) => {
    const r = placeBuilding({ w: W, h: H, tiles, props, secrets }, bx, by, name, interiorX);
    interiorX += 16; // roomy gaps, so one hearth's light never shows the next room
    return r;
  };

  const building = (x0, y0, w, h, doorX, doorY) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const isEdge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        set(x, y, isEdge ? TILE.WALL : TILE.PLANKS);
      }
    }
    set(doorX, doorY, TILE.PLANKS);
    buildings.push({ x: x0, y: y0, w, h, dx: doorX, dy: doorY });
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
  flatten(CX, CY, 30);
  for (let y = CY - 9; y <= CY + 9; y++) {
    for (let x = CX - 9; x <= CX + 9; x++) set(x, y, TILE.FLOOR);
  }
  const smithyRoom = shopfront(CX - 7, CY - 6, 'smithy');
  const innRoom = shopfront(CX + 6, CY - 6, 'inn');
  const healerRoom = shopfront(CX - 7, CY + 6, 'healer');
  shopfront(CX + 6, CY + 6, 'magetower');
  set(CX, CY - 7, TILE.SHRINE);
  props.push({ x: CX + 6, y: CY - 2, name: 'prop.well' });
  props.push({ x: CX - 6, y: CY + 2, name: 'prop.table' });  // market stall
  props.push({ x: CX - 5, y: CY + 3, name: 'prop.stool' });
  props.push({ x: CX - 6, y: CY - 7, name: 'prop.table' });  // smithy workbench
  props.push({ x: CX + 5, y: CY - 7, name: 'prop.table' });  // the inn's yard table
  props.push({ x: CX + 6, y: CY - 6, name: 'prop.stool' });
  vendors.push({
    name: 'Bren the Blacksmith', x: smithyRoom.x + 1, y: smithyRoom.y - 1, forge: true, model: 'smith',
    goods: [
      { type: 'weapon', item: 'dagger', q: 1 },
      { type: 'weapon', item: 'dagger', q: 2 },
      { type: 'weapon', item: 'sword', q: 1 },
      { type: 'weapon', item: 'sword', q: 2 },
      { type: 'weapon', item: 'mace', q: 1 },
      { type: 'weapon', item: 'battleaxe', q: 1 },
      { type: 'weapon', item: 'greatsword', q: 1 },
      { type: 'weapon', item: 'longbow', q: 1 },
      { type: 'weapon', item: 'leatherarmor', q: 1 },
      { type: 'weapon', item: 'chainmail', q: 1 },
      { type: 'weapon', item: 'buckler', q: 1 },
      { type: 'weapon', item: 'kiteshield', q: 1 },
      { item: 'arrow', name: 'Bundle of Arrows (20)', price: 15, desc: 'For the longbow.' },
    ],
  });
  vendors.push({
    name: 'Mira the Alchemist', x: healerRoom.x + 1, y: healerRoom.y - 1,
    goods: [
      { item: 'heal', name: 'Greater Heal Potion', price: 45, desc: 'Restores 25-40 health.' },
      { item: 'mana', name: 'Mana Potion', price: 35, desc: 'Restores 20-30 mana.' },
      { item: 'herbs', name: 'Bundle of Herbs (4)', price: 14, desc: 'For brewing your own at my bench.' },
    ],
  });
  // ---- the capital's ramparts: the crown city finally wears its walls ---------
  for (let x = CX - 12; x <= CX + 12; x++) {
    if (Math.abs(x - CX) <= 1) set(x, CY + 12, TILE.ROAD); // south gate
    else set(x, CY + 12, TILE.WALL);
    set(x, CY - 12, TILE.WALL); // north face runs into the castle precinct
  }
  for (let y = CY - 12; y <= CY + 12; y++) {
    if (Math.abs(y - CY) <= 1) {
      set(CX - 12, y, TILE.ROAD); // west gate
      set(CX + 12, y, TILE.ROAD); // east gate
    } else {
      set(CX - 12, y, TILE.WALL);
      set(CX + 12, y, TILE.WALL);
    }
  }
  // the plaza dressed for a capital: a winged fountain, braziers down the
  // king's way and at the market, a statue by the shrine, a market kiosk
  props.push({ x: CX, y: CY - 2, name: 'prop.fountain' });
  props.push({ x: CX + 2, y: CY - 8, name: 'prop.statue' });
  props.push({ x: CX - 5, y: CY + 3, name: 'prop.kiosk' });
  for (const [lx, ly] of [[CX - 2, CY + 4], [CX + 2, CY + 4], [CX - 2, CY + 8], [CX + 2, CY + 8],
                          [CX - 7, CY - 2], [CX + 7, CY - 2]]) {
    props.push({ x: lx, y: ly, name: 'prop.lamp' });
  }
  // the outer ring: cottages, stalls and townsfolk between plaza and wall
  props.push({ x: CX - 10, y: CY + 7, name: 'prop.cottage0' });
  props.push({ x: CX + 10, y: CY - 5, name: 'prop.cottage1' });
  props.push({ x: CX + 10, y: CY + 8, name: 'prop.cottage2' });
  props.push({ x: CX - 10, y: CY - 6, name: 'prop.cottage3' });
  props.push({ x: CX - 10, y: CY + 10, name: 'prop.table' });
  props.push({ x: CX - 9, y: CY + 10, name: 'prop.stool' });
  props.push({ x: CX + 10, y: CY + 10, name: 'prop.well' });
  spawners.push({ kind: 'villager', count: 3, x: CX - 9, y: CY + 8, r: 3 });
  spawners.push({ kind: 'chicken', count: 3, x: CX + 10, y: CY + 6, r: 2 });
  // the king's road runs out the south gate to meet the world
  road(CX, CY + 21, CX, CY + 11);

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
    // Whole pre-drawn buildings: a shop and a lodge front the green.
    v.shopRoom = shopfront(v.x - 5, v.y - 3, 'shop');
    v.lodgeRoom = shopfront(v.x + 4, v.y - 3, 'lodge');
    if (rng() > 0.45) {
      props.push({ x: v.x - 5, y: v.y + 4, name: 'prop.cottage' + Math.floor(rng() * 4) });
    }
    set(v.x, v.y + 4, TILE.SHRINE);
    props.push({ x: v.x + 1, y: v.y + 4, name: 'prop.table' }); // market stall
    props.push({ x: v.x + 2, y: v.y + 5, name: 'prop.stool' });
    // village green dressing: a signpost, lamps by the shrine, daisies
    props.push({ x: v.x - 1, y: v.y + 6, name: 'prop.signpost' });
    props.push({ x: v.x - 2, y: v.y + 3, name: 'prop.lamp' });
    props.push({ x: v.x + 3, y: v.y + 3, name: 'prop.lamp' });
    props.push({ x: v.x - 3, y: v.y + 5, name: 'prop.flowers' + (v.x % 3) });
    props.push({ x: v.x + 4, y: v.y + 6, name: 'prop.flowers' + ((v.x + 1) % 3) });
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
      x: v.shopRoom.x + 1, y: v.shopRoom.y - 1,
      goods: [
        { item: 'heal', name: 'Greater Heal Potion', price: 45 + jitter, desc: 'Restores 25-40 health.' },
        { item: 'mana', name: 'Mana Potion', price: 35 + jitter, desc: 'Restores 20-30 mana.' },
        { type: 'weapon', item: 'dagger', q: 1 },
        { type: 'weapon', item: 'sword', q: 1 },
        { type: 'weapon', item: 'leatherarmor', q: 1 },
        { item: 'arrow', name: 'Bundle of Arrows (20)', price: 15, desc: 'For the longbow.' },
      ],
    });
    road(v.x, v.y + 5, CX, CY + 21);
    // A goblin camp lurks a little way outside every village.
    const camp = settle(v.x + (rng() - 0.5) * 240, v.y + (rng() - 0.5) * 240, 60, 10);
    if (camp) spawners.push({ kind: 'goblin', count: 6, x: camp.x, y: camp.y, r: 12 });
  }

  // ---- Walled cities: bastions of the crown, safe ground in a wild world --------
  // Bigger than villages: stone walls with gates, a full plaza of services,
  // guards on patrol. Mobs will not hunt you inside the walls, and touching
  // a city shrine binds your recall there.
  const CITY_DEFS = [
    { name: 'Frosthelm', angle: -Math.PI / 2 },   // under the northern snows
    { name: 'Sunwatch', angle: Math.PI / 4 },     // facing the burning southeast
    { name: 'Mirehold', angle: (3 * Math.PI) / 4 }, // holding the swamp road
  ];
  const cities = [];
  for (const def of CITY_DEFS) {
    let spot = null;
    for (let i = 0; i < 80 && !spot; i++) {
      const a = def.angle + (rng() - 0.5) * 0.6;
      const d = 520 + rng() * 220;
      const c = settle(CX + Math.cos(a) * d, CY + Math.sin(a) * d, 110, 17);
      if (c && !villages.some((v) => Math.hypot(v.x - c.x, v.y - c.y) < 120)) spot = c;
    }
    if (!spot) continue;
    const { x: cx, y: cy } = spot;
    flatten(cx, cy, 20);
    for (let y = cy - 7; y <= cy + 7; y++) {
      for (let x = cx - 8; x <= cx + 8; x++) set(x, y, TILE.FLOOR);
    }
    // The wall, with a gate in each face.
    for (let y = cy - 10; y <= cy + 10; y++) {
      for (let x = cx - 11; x <= cx + 11; x++) {
        const onEdge = x === cx - 11 || x === cx + 11 || y === cy - 10 || y === cy + 10;
        if (!onEdge) continue;
        const gate = (Math.abs(x - cx) <= 1 && (y === cy - 10 || y === cy + 10)) ||
          (Math.abs(y - cy) <= 1 && (x === cx - 11 || x === cx + 11));
        set(x, y, gate ? TILE.ROAD : TILE.WALL);
      }
    }
    const citySmithy = shopfront(cx - 7, cy - 6, 'smithy');
    shopfront(cx + 6, cy - 6, 'inn');
    const cityHealer = shopfront(cx - 7, cy + 6, 'healer');
    set(cx, cy - 2, TILE.SHRINE);
    // civic pride: a fountain, a statue, braziers at the gates
    props.push({ x: cx, y: cy + 1, name: 'prop.fountain' });
    props.push({ x: cx + 2, y: cy - 2, name: 'prop.statue' });
    for (const [lx, ly] of [[cx - 2, cy + 8], [cx + 2, cy + 8],
                            [cx - 2, cy - 8], [cx + 2, cy - 8],
                            [cx - 9, cy], [cx + 9, cy]]) {
      props.push({ x: lx, y: ly, name: 'prop.lamp' });
    }
    props.push({ x: cx + 5, y: cy + 3, name: 'prop.well' });
    props.push({ x: cx - 4, y: cy + 1, name: 'prop.table' });
    props.push({ x: cx - 3, y: cy + 2, name: 'prop.stool' });
    props.push({ x: cx + 4, y: cy - 4, name: 'prop.table' }); // the inn's yard
    props.push({ x: cx + 5, y: cy - 3, name: 'prop.stool' });
    vendors.push({
      name: `Garrick of ${def.name}`, x: citySmithy.x + 1, y: citySmithy.y - 1, forge: true, model: 'smith',
      goods: [
        { type: 'weapon', item: 'dagger', q: 1 },
        { type: 'weapon', item: 'sword', q: 1 },
        { type: 'weapon', item: 'sword', q: 2 },
        { type: 'weapon', item: 'mace', q: 1 },
        { type: 'weapon', item: 'longbow', q: 1 },
        { type: 'weapon', item: 'leatherarmor', q: 1 },
        { type: 'weapon', item: 'chainmail', q: 1 },
        { type: 'weapon', item: 'buckler', q: 1 },
        { item: 'arrow', name: 'Bundle of Arrows (20)', price: 15, desc: 'For the longbow.' },
      ],
    });
    vendors.push({
      name: `Apothecary of ${def.name}`, x: cityHealer.x + 1, y: cityHealer.y - 1,
      goods: [
        { item: 'heal', name: 'Greater Heal Potion', price: 45, desc: 'Restores 25-40 health.' },
        { item: 'mana', name: 'Mana Potion', price: 35, desc: 'Restores 20-30 mana.' },
        { item: 'herbs', name: 'Bundle of Herbs (4)', price: 14, desc: 'For brewing your own at the bench.' },
      ],
    });
    spawners.push({ kind: 'villager', count: 4, x: cx, y: cy, r: 6 });
    spawners.push({ kind: 'guard', count: 4, x: cx, y: cy, r: 8 });
    road(cx, cy + 11, CX, CY + 21);
    // every city gets its landmark hall, rising behind the north wall —
    // solid stone underneath, so nobody walks through it
    const hall = { Frosthelm: 'citytower', Sunwatch: 'cityrampart', Mirehold: 'citystronghold' }[def.name];
    for (let y = cy - 13; y <= cy - 11; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) set(x, y, TILE.WALL);
    }
    props.push({ x: cx, y: cy - 11, name: 'prop.' + hall });
    // sx,sy mark the resurrection ankh, so the shard can guarantee it survives
    cities.push({ name: def.name, x: cx, y: cy, r: 12, sx: cx, sy: cy - 2 });
  }
  // The capital is the first city of all: guarded and safe within the plaza.
  spawners.push({ kind: 'guard', count: 6, x: CX, y: CY, r: 9 });
  cities.push({ name: 'Briarhaven', x: CX, y: CY, r: 13, sx: CX, sy: CY - 7 });

  // ---- The barrow-deeps: caverns beneath the world ------------------------------
  // Carved in the dead ocean strip along the top edge; reachable only through
  // cave mouths at the ruined keeps. Dark, dense with the dead, rich at the end.
  const dungeons = [];
  // Each dungeon gets its own slab in the strip and a theme: who keeps its
  // halls, what waits at the deepest point, and how the carving wanders.
  const carveDungeon = (idx, theme = {}) => {
    const cx = theme.cx || (220 + idx * 300);
    const cy = 26;
    // a sealed slab of rock
    for (let y = cy - 18; y <= cy + 18; y++) {
      for (let x = cx - 30; x <= cx + 30; x++) set(x, y, TILE.ROCK);
    }
    // drunkard's walk carves the halls; warrens run tight, grottos open wide
    const wander = theme.wander || 0.5;
    let wx = cx - 24;
    let wy = cy;
    set(wx, wy, TILE.CAVE);
    let far = { x: wx, y: wy };
    for (let i = 0; i < (theme.steps || 700); i++) {
      const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rng() * 4)];
      wx = Math.max(cx - 28, Math.min(cx + 28, wx + d[0]));
      wy = Math.max(cy - 16, Math.min(cy + 16, wy + d[1]));
      set(wx, wy, TILE.CAVE);
      if (rng() > wander) set(wx + 1, wy, TILE.CAVE);
      if (rng() > 0.85) set(wx, wy + 1, TILE.CAVE);
      if (wx > far.x) far = { x: wx, y: wy };
    }
    const entry = { x: cx - 24, y: cy };
    dungeons.push({ entry, far });
    // keepers: [kind, count, 'mid'|'far', radius]
    const keepers = theme.keepers ||
      [['skeleton', 7, 'mid', 20], ['skeleton', 5, 'far', 8]];
    for (const [kind, count, where, r] of keepers) {
      const at = where === 'far' ? far : { x: cx, y: cy };
      spawners.push({ kind, count, x: at.x, y: at.y, r: r || 12 });
    }
    // and a hoard waits at the deepest point
    secrets.push({ type: 'cache', x: far.x, y: far.y,
      loot: theme.loot || [['gold', 150, 350], ['gems', 1, 2], ['heal', 1, 2]] });
    return entry;
  };

  // Connect a surface mouth to a freshly carved dungeon.
  const openMouth = (mouth, idx, theme, whisperText) => {
    const entry = carveDungeon(idx, theme);
    set(mouth.x, mouth.y, TILE.CAVE);
    secrets.push({ type: 'portal', x: mouth.x, y: mouth.y, tx: entry.x, ty: entry.y, cave: true });
    secrets.push({ type: 'portal', x: entry.x, y: entry.y, tx: mouth.x, ty: mouth.y, cave: true });
    // mark the way home: stairs on the arrival tile, torchlight beside it
    props.push({ x: entry.x, y: entry.y, name: 'prop.stairsup' });
    secrets.push({ type: 'whisper', x: mouth.x - 1, y: mouth.y, text: whisperText });
  };

  // Hunt the wilds for a tile of the given kind to break open.
  const findGround = (kinds, x0, x1, y0, y1) => {
    for (let i = 0; i < 4000; i++) {
      const x = Math.round(x0 + rng() * (x1 - x0));
      const y = Math.round(y0 + rng() * (y1 - y0));
      if (kinds.includes(get(x, y)) && landScore(x, y, 4) === 1) return { x, y };
    }
    return null;
  };

  // ---- Ruined keeps with graveyards, haunted by the restless dead ---------------
  let keepIdx = 0;
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
    props.push({ x: spot.x - 3, y: spot.y - 1, name: 'prop.keep' });
    spawners.push({ kind: 'skeleton', count: 7, x: spot.x, y: spot.y, r: 9 });
    spawners.push({ kind: 'zombie', count: 3, x: spot.x, y: spot.y, r: 9 });
    // after dark, the keep's dead do not stay in the ground
    spawners.push({ kind: 'ghost', count: 3, x: spot.x, y: spot.y, r: 10, nightOnly: true });
    // a cave mouth descends into the barrow-deeps
    if (keepIdx < 4) {
      props.push({ x: spot.x + 2, y: spot.y + 3, name: 'prop.daemoncave' });
      // the second keep's deep is a crypt: the Crimson Count feeds below
      const crypt = keepIdx === 1;
      openMouth({ x: spot.x + 2, y: spot.y + 2 }, keepIdx++, crypt ? {
        keepers: [['zombie', 6, 'mid', 18], ['ghost', 4, 'mid', 14],
                  ['vampire', 1, 'far', 3]],
        loot: [['gold', 250, 500], ['gems', 2, 3], ['heal', 1, 2]],
      } : {}, crypt
        ? 'The stair below reeks of old blood. Something down there has slept long, and fed well.'
        : 'Cold air breathes up from a cracked stair descending into the dark.');
    }
    if (k === 0) {
      // The Bone Lord holds court in the first keep.
      spawners.push({ kind: 'bonelord', count: 1, x: spot.x, y: spot.y, r: 4, respawnMs: 300_000 });
    }
    // The dead guard their treasure.
    secrets.push({ type: 'cache', x: spot.x, y: spot.y,
      loot: [['gold', 80, 200], ['heal', 1, 2]] });
  }

  // ---- Two more dungeons, broken open in the wild biomes -------------------------
  // The wolfden grotto: a crack in the northern snows where the packs winter.
  const grottoMouth = findGround([TILE.SNOW], 200, W - 200, 150, 560);
  if (grottoMouth) {
    openMouth(grottoMouth, 4, {
      wander: 0.35, // wide, open chambers
      keepers: [['wolf', 6, 'mid', 16], ['wolf', 4, 'far', 8], ['skelmage', 2, 'far', 6]],
      loot: [['gold', 200, 400], ['gems', 2, 3], ['heal', 1, 2]],
    }, 'Pawprints by the hundred converge on a crack in the ice. A low growl rolls up from below.');
  }
  // The sunken warren: goblins tunnelled under the mires and met the serpents.
  const warrenMouth = findGround([TILE.SWAMP], 200, W - 200, H / 2 - 400, H - 200) ||
    findGround([TILE.SWAMP], 100, W - 100, 600, H - 100);
  if (warrenMouth) {
    openMouth(warrenMouth, 5, {
      wander: 0.7, // tight crooked tunnels
      steps: 850,
      // the goblins dug it; the lizardmen rose out of the deep water and took it
      keepers: [['goblin', 5, 'mid', 18], ['snake', 3, 'mid', 14],
                ['lizardman', 6, 'mid', 16], ['raptor', 3, 'mid', 14],
                ['lizardman', 5, 'far', 8]],
      loot: [['gold', 220, 450], ['gems', 1, 3], ['mana', 1, 2]],
    }, 'A goblin-dug shaft yawns out of the mire — but the tracks going down are clawed, and wet.');
    props.push({ x: warrenMouth.x + 1, y: warrenMouth.y + 1, name: 'prop.snakelair' });
  }

  // ---- The royal castle: a walled precinct north of Briarhaven's plaza. ---------
  // Its gate is a stair down into the crown's undercroft, the seventh and
  // richest of the deeps.
  flatten(CX, CY - 16, 6);
  for (let y = CY - 11; y <= CY - 10; y++) {
    for (let x = CX - 2; x <= CX + 2; x++) set(x, y, TILE.FLOOR); // forecourt
  }
  for (let y = CY - 14; y <= CY - 12; y++) {
    for (let x = CX - 1; x <= CX + 1; x++) set(x, y, TILE.WALL); // solid under the keep
  }
  // the precinct's flatten() grassed over the north rampart — re-stitch it
  // so the city wall runs shoulder-to-shoulder into the castle's flanks
  for (let x = CX - 12; x <= CX + 12; x++) {
    if (Math.abs(x - CX) > 1) set(x, CY - 12, TILE.WALL);
  }
  props.push({ x: CX, y: CY - 12, name: 'prop.citycastle' });
  openMouth({ x: CX, y: CY - 11 }, 6, {
    cx: 1870,
    steps: 800,
    keepers: [['skeleton', 8, 'mid', 18], ['skelmage', 3, 'mid', 14], ['skeleton', 5, 'far', 8]],
    loot: [['gold', 300, 600], ['gems', 2, 4], ['heal', 1, 2], ['mana', 1, 2]],
  }, 'A cold stair descends beneath the castle. The crown buries what it fears.');

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
        // goblin wolf-riders run with the bigger orc warbands
        if (kind === 'orc' && count >= 6) {
          spawners.push({ kind: 'wolfrider', count: 2, x: spot.x, y: spot.y, r });
        }
      }
    }
  }

  // ---- Harpy roosts on the high crags --------------------------------------------
  // The spawner sits on bare rock; spawnMob only places them on walkable
  // ground nearby, so they wheel around the peaks.
  for (let i = 0; i < 8; i++) {
    const crag = findGround([TILE.ROCK], 200, W - 200, 200, H - 200);
    if (crag && Math.hypot(crag.x - CX, crag.y - CY) > 200) {
      spawners.push({ kind: 'harpy', count: 3, x: crag.x, y: crag.y, r: 7 });
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
    props.push({ x: s.x, y: s.y - 1, name: 'prop.graveyard' });
    spawners.push({ kind: 'skeleton', count: 4, x: s.x, y: s.y, r: 8 });
    spawners.push({ kind: 'zombie', count: 2, x: s.x, y: s.y, r: 8 });
    spawners.push({ kind: 'ghost', count: 2, x: s.x, y: s.y, r: 9, nightOnly: true });
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
    // lonely means lonely: not against the capital's walls, not on a green
    if (Math.hypot(s.x - CX, s.y - CY) < 70) return;
    if (villages.some((v) => Math.hypot(v.x - s.x, v.y - s.y) < 40)) return;
    flatten(s.x, s.y, 7);
    props.push({ x: s.x, y: s.y + 1, name: 'prop.cottage' + Math.floor(rng() * 4) });
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

  // ---- Quarries: rich rock, worked or overrun ---------------------------------------
  // Half the quarries are dwarf-worked: miners at the rock, halberdier
  // wardens at the gate, a rune-priest by the fire. The rest the clans
  // lost to the ettins, and they'd pay to see them retaken.
  let quarryIdx = 0;
  scatter(6, 1600, (s) => {
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const d = 2 + rng() * 3;
      const x = Math.round(s.x + Math.cos(a) * d);
      const y = Math.round(s.y + Math.sin(a) * d);
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROCK);
    }
    props.push({ x: s.x + 1, y: s.y - 2, name: 'prop.dwarffortress' });
    if (quarryIdx++ % 2 === 0) {
      spawners.push({ kind: 'dwarf', count: 4, x: s.x, y: s.y, r: 7 });
      spawners.push({ kind: 'dwarfguard', count: 2, x: s.x, y: s.y, r: 6 });
      spawners.push({ kind: 'dwarfpriest', count: 1, x: s.x, y: s.y, r: 5 });
      props.push({ x: s.x - 2, y: s.y + 2, name: 'fx.campfire' });
      secrets.push({ type: 'whisper', x: s.x, y: s.y + 4,
        text: 'Hammer-song rings off the rock. The wardens watch you over their beards.' });
    } else {
      spawners.push({ kind: 'ettin', count: 2, x: s.x, y: s.y, r: 8 });
      secrets.push({ type: 'whisper', x: s.x, y: s.y + 4,
        text: 'Broken pick-hafts and a cold forge. Whatever drove the dwarves out is still here.' });
    }
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

  // ---- Wandering packs fill the long quiet stretches between landmarks ----------
  scatter(36, 1850, (sp) => {
    if (Math.hypot(sp.x - CX, sp.y - CY) < 120) return;
    const kind = ['wolf', 'goblin', 'skeleton', 'orc', 'deer'][Math.floor(rng() * 5)];
    spawners.push({ kind, count: 3, x: sp.x, y: sp.y, r: 10 });
  });

  // Old fire pits dot the wilderness — travellers came this way once.
  scatter(40, 1850, (sp) => {
    props.push({ x: sp.x, y: sp.y, name: 'fx.campfire' });
    if (rng() > 0.7) props.push({ x: sp.x + 1, y: sp.y + 1, name: 'prop.stool' });
  });

  // ---- The deep pinewood belongs to the elves ---------------------------------------
  // Where the trees grow thickest, the wood-folk keep their groves: rangers
  // in the branches, dryads among the blossom, an elder treant at the heart.
  // They suffer no trespass.
  let groves = 0;
  for (let gy = 96; gy < H - 96 && groves < 5; gy += 80) {
    for (let gx = 96; gx < W - 96 && groves < 5; gx += 80) {
      if (Math.hypot(gx - CX, gy - CY) < 250) continue;
      let wood = 0;
      for (let dy = -7; dy <= 7; dy += 2) {
        for (let dx = -7; dx <= 7; dx += 2) {
          const t = get(gx + dx, gy + dy);
          if (t === TILE.TREE || t === TILE.SNOWTREE) wood++;
        }
      }
      if (wood >= 26) {
        spawners.push({ kind: 'elfranger', count: 3, x: gx, y: gy, r: 9 });
        spawners.push({ kind: 'dryad', count: 3, x: gx, y: gy, r: 8 });
        spawners.push({ kind: 'treant', count: 1, x: gx, y: gy, r: 5, respawnMs: 120_000 });
        secrets.push({ type: 'whisper', x: gx, y: gy + 6,
          text: 'The birdsong stops. Every tree here seems to be watching you.' });
        secrets.push({ type: 'cache', x: gx, y: gy,
          loot: [['gold', 70, 160], ['mana', 1, 2], ['gems', 0, 2]] });
        groves++;
      }
    }
  }

  // ---- The mires breed their own trouble -------------------------------------------
  const swampKinds = ['snake', 'crab', 'boar', 'lizardman', 'raptor'];
  let swampSpawners = 0;
  for (let gy = 64; gy < H - 64 && swampSpawners < 16; gy += 96) {
    for (let gx = 64; gx < W - 64 && swampSpawners < 16; gx += 96) {
      let wet = 0;
      for (let dy = -6; dy <= 6; dy += 2) {
        for (let dx = -6; dx <= 6; dx += 2) {
          const t = get(gx + dx, gy + dy);
          if (t === TILE.SWAMP || t === TILE.SWAMPTREE) wet++;
        }
      }
      if (wet >= 20) {
        spawners.push({ kind: swampKinds[swampSpawners % swampKinds.length], count: 4, x: gx, y: gy, r: 9 });
        swampSpawners++;
      }
    }
  }

  // ---- Rare beasts for the patient ---------------------------------------------------
  for (let i = 0; i < 3; i++) {
    const spot = settle(CX + (rng() - 0.5) * 1500, CY + (rng() - 0.5) * 1500, 150, 8);
    if (spot) {
      spawners.push({ kind: 'whitestag', count: 1, x: spot.x, y: spot.y, r: 14, respawnMs: 20 * 60_000 });
    }
  }

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
  // Gruk's warcamp: the orc warbands answer to one banner, planted far out
  // in the wastes with his brutes and outriders camped around it.
  const grukSpot = settle(CX + (rng() - 0.5) * 1600, CY + 500 + rng() * 400, 200, 10);
  if (grukSpot) {
    flatten(grukSpot.x, grukSpot.y, 8);
    props.push({ x: grukSpot.x, y: grukSpot.y - 2, name: 'fx.campfire' });
    props.push({ x: grukSpot.x - 4, y: grukSpot.y + 3, name: 'fx.campfire' });
    props.push({ x: grukSpot.x + 4, y: grukSpot.y + 3, name: 'fx.campfire' });
    spawners.push({ kind: 'orcwarlord', count: 1, x: grukSpot.x, y: grukSpot.y, r: 4, respawnMs: 300_000 });
    spawners.push({ kind: 'orcbrute', count: 4, x: grukSpot.x, y: grukSpot.y, r: 8 });
    spawners.push({ kind: 'wolfrider', count: 3, x: grukSpot.x, y: grukSpot.y, r: 10 });
    spawners.push({ kind: 'orc', count: 5, x: grukSpot.x, y: grukSpot.y, r: 12 });
    secrets.push({ type: 'cache', x: grukSpot.x + 2, y: grukSpot.y,
      loot: [['gold', 180, 400], ['gems', 1, 3], ['heal', 1, 2]] });
    secrets.push({ type: 'whisper', x: grukSpot.x, y: grukSpot.y - 8,
      text: 'War-drums. Banner poles. Every orc track in the wastes bends toward this place.' });
  }

  // ---- At the rim of the world, something older than the dragons sleeps ----------
  let rim = null;
  tries = 0;
  while (!rim && tries++ < 400) {
    const a = rng() * Math.PI * 2;
    const d = 940 - tries * 0.5; // hug the edge, fall back inland if it must
    const spot = settle(CX + Math.cos(a) * d, CY + Math.sin(a) * d, 50, 7);
    if (spot && Math.hypot(spot.x - CX, spot.y - CY) > 700) rim = spot;
  }
  if (rim) {
    flatten(rim.x, rim.y, 7);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = Math.round(rim.x + Math.cos(a) * 5);
      const y = Math.round(rim.y + Math.sin(a) * 5);
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROCK);
    }
    props.push({ x: rim.x, y: rim.y - 2, name: 'prop.bloodtemple' });
    spawners.push({ kind: 'vyrmaur', count: 1, x: rim.x, y: rim.y, r: 3, respawnMs: 30 * 60_000 });
    secrets.push({ type: 'whisper', x: rim.x, y: rim.y - 9,
      text: 'The air shimmers with heat, and the very stones seem afraid.' });
  }

  // ---- Dragons roost far from civilisation ---------------------------------------
  let dragons = 0;
  tries = 0;
  while (dragons < 5 && tries++ < 350) {
    const spot = settle(CX + (rng() - 0.5) * 1800, CY + (rng() - 0.5) * 1800, 120, 10);
    if (!spot) continue;
    if (Math.hypot(spot.x - CX, spot.y - CY) < 600) continue;
    if (villages.some((v) => Math.hypot(v.x - spot.x, v.y - spot.y) < 300)) continue;
    props.push({ x: spot.x, y: spot.y - 1, name: 'prop.dragoncity' });
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
  const hermitSpots = [];
  for (let hermits = 0; hermits < 3; hermits++) {
  const hermitSpot = settle(CX + (rng() - 0.5) * (1200 + hermits * 300), CY + (rng() - 0.5) * (1200 + hermits * 300), 150, 8);
  if (hermitSpot) {
    flatten(hermitSpot.x, hermitSpot.y, 6);
    building(hermitSpot.x - 2, hermitSpot.y - 2, 5, 4, hermitSpot.x, hermitSpot.y + 1);
    vendors.push({
      name: HERMIT_NAMES[hermits], x: hermitSpot.x, y: hermitSpot.y - 1, model: 'hermit',
      goods: [
        { item: 'heal', name: 'Greater Heal Potion', price: 25, desc: 'They will not say where they get them.' },
        { item: 'mana', name: 'Mana Potion', price: 20, desc: 'Tastes faintly of moss.' },
        { item: 'herbs', name: 'Bundle of Herbs (4)', price: 8, desc: 'Picked at moonrise, they claim.' },
      ],
    });
    secrets.push({ type: 'whisper', x: hermitSpot.x, y: hermitSpot.y + 2,
      text: 'A trail of crushed herbs leads to a crooked hut. Someone lives out here.' });
    hermitSpots.push(hermitSpot);
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

  // ---- Storytellers: their tales are drawn from the world itself ---------------
  // Some stories are true. Some are tavern nonsense. The teller won't say which.
  const compass = (fx, fy, tx, ty) => {
    const o = ((Math.round(Math.atan2(ty - fy, tx - fx) / (Math.PI / 4)) % 8) + 8) % 8;
    return ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][o];
  };
  const travel = (d) => d < 150 ? 'a short walk' : d < 400 ? "a day's march"
    : d < 800 ? "many days' travel" : 'at the very rim of the world';
  const nearestVillage = (x, y) => villages.reduce((b, v) =>
    Math.hypot(v.x - x, v.y - y) < Math.hypot(b.x - x, b.y - y) ? v : b, villages[0]);

  // ---- The Dawn-Knight's road: a story you can walk, not a quest you are given.
  // A bard's rumor leads to a survivor; the survivor names a heading; waymark
  // stones confirm the road; the road ends where the songs end.
  let squire = null;
  if (rim) {
    squire = settle(CX + (rim.x - CX) * 0.45, CY + (rim.y - CY) * 0.45, 90, 5);
    if (squire) {
      flatten(squire.x, squire.y, 4);
      props.push({ x: squire.x, y: squire.y + 1, name: 'fx.campfire' });
      props.push({ x: squire.x + 1, y: squire.y + 2, name: 'prop.stool' });
      vendors.push({
        name: 'Caol the Grey', x: squire.x, y: squire.y, model: 'hermit', goods: [],
        stories: [
          ['They still sing of Ser Alarion, the Dawn-Knight, in the south. I do not sing.',
           'I was his squire. I polished the blade they called Dawnbreaker —',
           'it drank the morning light and gave it back as fire.',
           'He rode to end the thing at the rim of the world. The songs never say what I saw there.'],
          ['You want his road? Then mark me, and mark me once.',
           `From this fire, go ${compass(squire.x, squire.y, rim.x, rim.y)}, ${travel(Math.hypot(rim.x - squire.x, rim.y - squire.y))}.`,
           'Waymark stones stand where his column passed. They whisper yet.',
           'The last one is scorched black. Past it, no banner ever returned.'],
        ],
      });
      const WAYMARKS = [
        'A rising sun is scratched into this waymark stone. It points onward.',
        'Bones of a warhorse lie beneath this waymark. The column was failing here.',
        'The last waymark, scorched black. The air beyond shimmers. Turn back — or do not.',
      ];
      [0.3, 0.55, 0.8].forEach((f, i) => {
        const wp = settle(
          Math.round(squire.x + (rim.x - squire.x) * f),
          Math.round(squire.y + (rim.y - squire.y) * f), 50, 3);
        if (wp) {
          if (get(wp.x, wp.y) !== TILE.WATER) set(wp.x, wp.y, TILE.ROCK);
          secrets.push({ type: 'whisper', x: wp.x, y: wp.y, text: WAYMARKS[i] });
        }
      });
    }
  }

  const stories = [];
  const cacheSecrets = secrets.filter((sc) => sc.type === 'cache');
  for (let i = 0; i < 4 && cacheSecrets.length; i++) {
    const c = cacheSecrets[Math.floor(rng() * cacheSecrets.length)];
    const v = nearestVillage(c.x, c.y);
    stories.push([
      'A paymaster fled the old war with a chest he never came back for.',
      `They say he buried it ${travel(Math.hypot(c.x - v.x, c.y - v.y))} to the ${compass(v.x, v.y, c.x, c.y)} of ${v.name}.`,
      'Dig where the ground whispers, and tell no one I told you.',
    ]);
  }
  const portalSecrets = secrets.filter((sc) => sc.type === 'portal');
  for (let i = 0; i + 1 < portalSecrets.length && i < 4; i += 2) {
    const a = portalSecrets[i];
    const va = nearestVillage(a.x, a.y);
    const vb = nearestVillage(a.tx, a.ty);
    stories.push([
      'The standing stones are doors, traveller. Paired, like lovers.',
      `Step into the circle that lies ${travel(Math.hypot(a.x - va.x, a.y - va.y))} ${compass(va.x, va.y, a.x, a.y)} of ${va.name},`,
      `and you will draw your next breath near ${vb.name}, half a world away.`,
    ]);
  }
  for (const sp of spawners.filter((q) => q.kind === 'dragon').slice(0, 2)) {
    stories.push([
      'I watched a dragon blot out the sun once. I do not wish that on you.',
      `It roosts ${travel(Math.hypot(sp.x - CX, sp.y - CY))} to the ${compass(CX, CY, sp.x, sp.y)} of Briarhaven,`,
      'sleeping on more gold than this town will see in a century.',
    ]);
  }
  for (const h of hermitSpots.slice(0, 2)) {
    const v = nearestVillage(h.x, h.y);
    stories.push([
      `There is a crooked hut ${travel(Math.hypot(h.x - v.x, h.y - v.y))} ${compass(v.x, v.y, h.x, h.y)} of ${v.name}.`,
      'The one who lives there sells potions cheaper than any guild dares.',
      'Do not ask where they come from.',
    ]);
  }
  if (typeof kingSpot !== 'undefined' && kingSpot) {
    stories.push([
      'The goblins crowned themselves a king, if you can believe it.',
      `Skarg holds his filthy court ${travel(Math.hypot(kingSpot.x - CX, kingSpot.y - CY))} to the ${compass(CX, CY, kingSpot.x, kingSpot.y)}.`,
      'His crown is paid for in stolen gems. Someone should collect.',
    ]);
  }
  if (typeof wolfSpot !== 'undefined' && wolfSpot) {
    stories.push([
      `Shepherds up north speak of Greyfang — a wolf the size of an ox.`,
      `Follow the snow ${compass(CX, CY, wolfSpot.x, wolfSpot.y)} and you will hear the howling before you see him.`,
    ]);
  }
  if (rim) {
    stories.push([
      "My grandmother swore the sailors' charts end where the fear begins.",
      `Far to the ${compass(CX, CY, rim.x, rim.y)}, at the very rim of the world, the air burns.`,
      'She called the thing that sleeps there Vyrmaur. Pray she was lying.',
    ]);
  }
  // And some tales that are only tales. Probably.
  stories.push([
    'They say the first king of Briarhaven was a chicken farmer.',
    'The crown still smells faintly of feathers. So I am told.',
  ]);
  stories.push([
    'A fish in Saltmere once swallowed a wedding ring and a marriage with it.',
    'The fish is said to live there still, smug as anything.',
  ]);
  stories.push([
    'Never whistle in a stone circle at midnight.',
    'No reason. Just never do it.',
  ]);

  const BARD_NAMES = ['Loremaster Edda', 'Finch the Wanderer', 'Old Maren', 'Quill'];
  const mkBard = (name, x, y, guaranteed = []) => {
    const pool = stories.slice();
    const own = guaranteed.slice();
    while (own.length < Math.min(6, guaranteed.length + pool.length)) {
      own.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    vendors.push({ name, x, y, goods: [], stories: own, model: 'bard' });
  };
  const eddaKnows = [];
  if (squire) {
    eddaKnows.push([
      'Every child knows how Ser Alarion, the Dawn-Knight, rode against the rim and never came home.',
      `What the songs forget: his squire lives. A grey old man keeps a lonely fire ${travel(Math.hypot(squire.x - CX, squire.y - CY))} to the ${compass(CX, CY, squire.x, squire.y)} of Briarhaven.`,
      'He will not sing, that one. But he might speak.',
    ]);
  }
  mkBard(BARD_NAMES[0], innRoom.x - 1, innRoom.y, eddaKnows); // holds court in the capital inn
  villages.filter((v, i) => i % 3 === 0).slice(0, 3).forEach((v, i) => {
    mkBard(BARD_NAMES[1 + i], v.lodgeRoom.x + 1, v.lodgeRoom.y); // by the lodge hearth
  });

  // tileVariants: sparse "x,y" -> ground-variant index, hand-picked in the
  // builder. Worldgen leaves it empty; the overlay fills it.
  return { w: W, h: H, tiles, buildings, vendors, spawners, secrets, spawn, villages, cities, props,
    tileVariants: new Map() };
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

// Hand-made map edits from the visual editor (serve the game with EDITOR=1
// and open /editor.html) are stamped on top of the generated world — the
// same philosophy as art/overrides: regeneration never clobbers hand work.
// Shape: { tiles: [[x,y,tile]], props: [{x,y,name}], removeProps: [[x,y]],
//          spawners: [{kind,count,x,y,r}], removeSpawners: [[x,y]],
//          secrets: [{type:'whisper'|'cache', x, y, text?, loot?}] }
// What loot rows and shop goods may reference. Weapons are validated
// against the caller-supplied set (WEAPONS lives in game.js).
const LOOT_ITEMS = new Set(['gold', 'heal', 'mana', 'logs', 'ore', 'gems', 'food', 'meat', 'fish', 'herbs']);
const MISC_GOODS = {
  heal: 'Greater Heal Potion',
  mana: 'Mana Potion',
  arrow: 'Bundle of Arrows (20)',
  herbs: 'Bundle of Herbs (4)',
};

function sanitizeLoot(list, validWeapons) {
  const out = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, 10)) {
    if (!Array.isArray(e)) continue;
    const chance = Math.max(0.01, Math.min(1, +e[0] || 0));
    if (e[1] === 'tmap') { out.push([chance, 'tmap']); continue; }
    if (e[1] === 'weapon') {
      const pool = (Array.isArray(e[2]) ? e[2] : [e[2]])
        .filter((w) => !validWeapons || validWeapons.has(w));
      if (!pool.length) continue;
      const qMin = Math.max(0, Math.min(4, e[3] | 0));
      const qMax = Math.max(qMin, Math.min(4, e[4] | 0));
      out.push([chance, 'weapon', pool, qMin, qMax]);
      continue;
    }
    if (LOOT_ITEMS.has(e[1])) {
      const min = Math.max(0, e[2] | 0);
      const max = Math.max(min, e[3] | 0);
      out.push([chance, e[1], min, max]);
    }
  }
  return out;
}

function sanitizeGoods(list, validWeapons) {
  const out = [];
  for (const g of (Array.isArray(list) ? list : []).slice(0, 14)) {
    if (!g) continue;
    if (g.type === 'weapon') {
      if (!validWeapons || validWeapons.has(g.item)) {
        out.push({ type: 'weapon', item: g.item, q: Math.max(0, Math.min(4, g.q | 0)) });
      }
    } else if (MISC_GOODS[g.item]) {
      out.push({
        item: g.item,
        name: typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 40) : MISC_GOODS[g.item],
        price: Math.max(1, Math.min(100000, g.price | 0)),
        desc: typeof g.desc === 'string' ? g.desc.slice(0, 80) : '',
      });
    }
  }
  return out;
}

// Validate and normalise a raw overlay into exactly the shape applyEdits
// consumes. The boot path and the live-apply path both feed through this,
// so their validation can never drift apart. Keys are set only when they
// carry entries, keeping the saved file lean; v1 files pass unchanged.
function sanitizeEdits(map, edits, { validKinds, validWeapons } = {}) {
  const out = { v: 2 };
  if (!edits || typeof edits !== 'object') return out;
  if (Number.isFinite(edits.savedAt)) out.savedAt = edits.savedAt;
  const okXY = (x, y) => Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && y >= 0 && x < map.w && y < map.h;
  const pairs = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => Array.isArray(p) && okXY(p[0] | 0, p[1] | 0))
    .map((p) => [p[0] | 0, p[1] | 0]);
  const keep = (key, list) => { if (list.length) out[key] = list; };

  keep('removeProps', pairs(edits.removeProps));
  keep('removeSpawners', pairs(edits.removeSpawners));
  keep('removeSecrets', pairs(edits.removeSecrets));
  keep('tiles', (Array.isArray(edits.tiles) ? edits.tiles : [])
    .filter((t) => Array.isArray(t) && okXY(t[0], t[1]) &&
      Number.isInteger(t[2]) && t[2] >= 0 && t[2] <= TILE.STONEROAD)
    .map((t) => [t[0], t[1], t[2]]));
  // hand-picked ground variants: [x, y, index]; up to 8 variants per tile
  keep('tileVariants', (Array.isArray(edits.tileVariants) ? edits.tileVariants : [])
    .filter((t) => Array.isArray(t) && okXY(t[0], t[1]) &&
      Number.isInteger(t[2]) && t[2] >= 0 && t[2] <= 7)
    .map((t) => [t[0], t[1], t[2]]));
  keep('props', (Array.isArray(edits.props) ? edits.props : [])
    .filter((p) => p && okXY(p.x, p.y) && typeof p.name === 'string' && p.name.length <= 64)
    .map((p) => ({ x: p.x, y: p.y, name: p.name })));
  keep('spawners', (Array.isArray(edits.spawners) ? edits.spawners : [])
    .filter((s) => s && okXY(s.x, s.y) && (!validKinds || validKinds.has(s.kind)))
    .map((s) => {
      const o = { kind: s.kind, count: Math.max(1, Math.min(12, s.count | 0)),
        x: s.x, y: s.y, r: Math.max(1, Math.min(24, s.r | 0)) };
      if (s.nightOnly === true) o.nightOnly = true;
      // the keeper may give a camp its own voice and its own spoils
      if (Array.isArray(s.lines)) {
        const lines = s.lines.filter((l) => typeof l === 'string' && l.trim())
          .map((l) => l.trim().slice(0, 140)).slice(0, 8);
        if (lines.length) o.lines = lines;
      }
      if (Array.isArray(s.loot)) {
        const loot = sanitizeLoot(s.loot, validWeapons);
        if (loot.length) o.loot = loot;
      }
      return o;
    }));
  keep('vendors', (Array.isArray(edits.vendors) ? edits.vendors : [])
    .filter((v) => v && okXY(v.x, v.y) && typeof v.name === 'string' && v.name.trim())
    .map((v) => {
      const o = { x: v.x, y: v.y, name: v.name.trim().slice(0, 40),
        goods: sanitizeGoods(v.goods, validWeapons) };
      if (typeof v.model === 'string' && /^[a-z0-9]{1,24}$/.test(v.model)) o.model = v.model;
      if (v.forge === true) o.forge = true;
      if (typeof v.greeting === 'string' && v.greeting.trim()) {
        o.greeting = v.greeting.trim().slice(0, 140);
      }
      return o;
    })
    .slice(0, 40));
  keep('removeVendors', pairs(edits.removeVendors));
  keep('secrets', (Array.isArray(edits.secrets) ? edits.secrets : [])
    .map((sc) => {
      if (!sc || !okXY(sc.x, sc.y)) return null;
      if (sc.type === 'whisper' && typeof sc.text === 'string' && sc.text.trim()) {
        return { type: 'whisper', x: sc.x, y: sc.y, text: sc.text.slice(0, 200) };
      }
      if (sc.type === 'cache') {
        return { type: 'cache', x: sc.x, y: sc.y,
          loot: Array.isArray(sc.loot) && sc.loot.length ? sc.loot : [['gold', 50, 150], ['heal', 0, 1]] };
      }
      if (sc.type === 'portal' && okXY(sc.tx, sc.ty)) {
        const o = { type: 'portal', x: sc.x, y: sc.y, tx: sc.tx, ty: sc.ty };
        if (sc.door) o.door = true;
        if (sc.cave) o.cave = true;
        return o;
      }
      return null;
    })
    .filter(Boolean));
  keep('buildings', (Array.isArray(edits.buildings) ? edits.buildings : [])
    .filter((b) => b && okXY(b.x, b.y) && BUILDING_KINDS.includes(b.name))
    .map((b) => ({ x: b.x, y: b.y, name: b.name }))
    .slice(0, EDIT_INTERIOR_MAX));
  return out;
}

function applyEdits(map, edits, opts = {}) {
  const counts = { tiles: 0, props: 0, spawners: 0, secrets: 0, buildings: 0, vendors: 0, removed: 0 };
  const clean = sanitizeEdits(map, edits, opts);
  for (const [x, y] of clean.removeProps || []) {
    const i = map.props.findIndex((p) => p.x === x && p.y === y);
    if (i >= 0) { map.props.splice(i, 1); counts.removed++; }
  }
  for (const [x, y] of clean.removeSpawners || []) {
    const i = map.spawners.findIndex((s) => s.x === x && s.y === y);
    if (i >= 0) { map.spawners.splice(i, 1); counts.removed++; }
  }
  for (const [x, y] of clean.removeSecrets || []) {
    // boot-time only: nothing holds indexes into map.secrets yet
    const i = map.secrets.findIndex((s) => s.x === x && s.y === y);
    if (i >= 0) { map.secrets.splice(i, 1); counts.removed++; }
  }
  for (const [x, y] of clean.removeVendors || []) {
    const i = map.vendors.findIndex((v) => v.x === x && v.y === y);
    if (i >= 0) { map.vendors.splice(i, 1); counts.removed++; }
  }
  for (const v of clean.vendors || []) {
    map.vendors.push({ ...v });
    counts.vendors++;
  }
  // buildings stamp before hand paints, so manual touch-ups win
  (clean.buildings || []).forEach((b, i) => {
    placeBuilding(map, b.x, b.y, b.name, EDIT_INTERIOR_X0 + i * 16);
    counts.buildings++;
  });
  for (const [x, y, v] of clean.tiles || []) {
    map.tiles[y * map.w + x] = v;
    counts.tiles++;
  }
  if (!map.tileVariants) map.tileVariants = new Map();
  for (const [x, y, v] of clean.tileVariants || []) {
    map.tileVariants.set(x + ',' + y, v);
  }
  for (const p of clean.props || []) {
    map.props.push(p);
    counts.props++;
  }
  for (const s of clean.spawners || []) {
    map.spawners.push(s);
    counts.spawners++;
  }
  for (const sc of clean.secrets || []) {
    map.secrets.push(sc);
    counts.secrets++;
  }
  return counts;
}

module.exports = { TILE, generate, applyEdits, sanitizeEdits, placeBuilding,
  BUILDING_KINDS, EDIT_INTERIOR_X0, isWalkable, tileAt, nearestWalkable, W, H };
