'use strict';

// The one true ground renderer. The game's world pass and the world
// builder's WYSIWYG preview both draw terrain cells through drawCell(),
// so what the keeper sees in the builder IS what players see in the game.
//
// drawCell paints the flat parts (ground, water animation, peaks, fringes,
// autowalls) directly, and hands anything y-sorted (trees, decor, torches,
// shrines) to the caller through `sink` callbacks.

const GroundRender = (() => {
  const TP = 48;
  const HT = TP / 2;

  const T = { WATER: 0, GRASS: 1, TREE: 2, ROCK: 3, ROAD: 4, FLOOR: 5, WALL: 6, SAND: 7, SHRINE: 8, SNOW: 9, SNOWTREE: 10, PLANKS: 11, SWAMP: 12, SWAMPTREE: 13, CAVE: 14, STONEROAD: 15 };

  // Soft biome seams: tile id -> [fringe art kind (null = never spills),
  // priority]. The higher-priority side lays its tufts onto the lower;
  // water and roads receive fringes but never spill their own.
  const FRINGES = {
    [T.WATER]: [null, 0], [T.ROAD]: [null, 0.5], [T.STONEROAD]: [null, 0.5], [T.FLOOR]: [null, 0.4],
    [T.SAND]: ['sand', 1],
    [T.SWAMP]: ['swamp', 2], [T.SWAMPTREE]: ['swamp', 2],
    [T.GRASS]: ['grass', 3], [T.TREE]: ['grass', 3],
    [T.SNOW]: ['snow', 4], [T.SNOWTREE]: ['snow', 4],
  };

  // Curved shores: the wet-sand colour each biome shows at the waterline.
  // Any of these meeting WATER gets a wavy, foam-lined coast instead of a
  // grid-straight seam (see the coast pass in drawCell).
  const COAST = {
    [T.SAND]: '#bda876', [T.GRASS]: '#4c7a3a', [T.TREE]: '#4c7a3a',
    [T.SWAMP]: '#556541', [T.SWAMPTREE]: '#4c5c3a',
    [T.SNOW]: '#e2e8ef', [T.SNOWTREE]: '#dbe2ea',
  };
  const COAST_WET = '#2f77ad';  // shallow water biting into the shore
  const COAST_FOAM = '#dcefff'; // the pale foam line riding the waterline

  // Signed displacement of the waterline (px) along a seam, keyed to a
  // WORLD coordinate so the curve flows unbroken from tile to tile. A few
  // stacked sines read as an organic, non-repeating shoreline; the last,
  // slow term lets the foam breathe with time.
  function shoreWave(coord, time) {
    return Math.sin(coord * 0.055 + 1.7) * 6.5
      + Math.sin(coord * 0.021 + 0.5) * 4.5
      + Math.sin(coord * 0.129) * 2.2
      + Math.sin(time * 0.0011 + coord * 0.028) * 1.4;
  }

  // Chebyshev distance from a water tile to the nearest land, capped at 8.
  // Memoised: the sea is large and mostly permanent. clearWaterDepth() lets
  // the editor and live tile edits invalidate it.
  let depthCache = new Map();

  function waterDepth(tileAt, tx, ty) {
    const key = tx + ',' + ty;
    const hit = depthCache.get(key);
    if (hit !== undefined) return hit;
    let d = 8;
    outer:
    for (let r = 1; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (tileAt(tx + dx, ty + dy) !== T.WATER) { d = r; break outer; }
        }
      }
    }
    if (depthCache.size > 30000) depthCache = new Map();
    depthCache.set(key, d);
    return d;
  }

  function clearWaterDepth() {
    depthCache = new Map();
    biomeCache = new Map();
  }

  // Pick a banded-block cell (crowns/flanks/feet x left/interior/right) by
  // NEIGHBOURS of the same tile kind — shared by mountains and forests.
  function bandedFrame(prefix, tileAt, tx, ty, tile) {
    const same = (nx, ny) => tileAt(nx, ny) === tile;
    const up = same(tx, ty - 1);
    const dn = same(tx, ty + 1);
    if (!up && !dn) return prefix + '.lone';
    const band = !up ? 't' : !dn ? 'b' : 'm';
    const ci = !same(tx - 1, ty) ? 0 : !same(tx + 1, ty) ? 3 : 1 + (tx % 2);
    return prefix + '.' + band + '.' + ci;
  }

  // Which country does this mountain stand in? First special biome found in
  // the near rings decides; memoised beside the water depths.
  let biomeCache = new Map();

  function nearbyBiome(tileAt, tx, ty) {
    const key = tx + ',' + ty;
    const hit = biomeCache.get(key);
    if (hit !== undefined) return hit;
    let found = 'default';
    outer:
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const t = tileAt(tx + dx, ty + dy);
          if (t === T.SNOW || t === T.SNOWTREE) { found = 'snow'; break outer; }
          if (t === T.SWAMP || t === T.SWAMPTREE) { found = 'swamp'; break outer; }
          if (t === T.SAND) { found = 'sand'; break outer; }
        }
      }
    }
    if (biomeCache.size > 30000) biomeCache = new Map();
    biomeCache.set(key, found);
    return found;
  }

  function hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // sink: {
  //   underworld: bool           — apply the deeps' overrides & torches
  //   push(drawable)             — y-sorted scenery ({depth, kind, name, x, y})
  //   torch(x, y)                — a lit wall torch (for the night pass)
  //   waterGlint(tx,ty,sx,sy,t)  — optional sparkle effect on open water
  // }
  function drawCell(ctx, tileAt, tx, ty, sx, sy, time, sink) {
    const tile = tileAt(tx, ty);
    const h = hash(tx, ty);
    const under = sink.underworld && Assets.tileTD('u' + tile);
    const recipe = under || Assets.tileTD(tile) || Assets.tileTD(T.WATER);

    if (recipe.autoroadq) {
      // Roads autotile by CORNER (blob autotiling): each tile is four 8px
      // quadrants, and each quadrant picks its piece from the three
      // neighbours touching that corner — two cardinals and the diagonal.
      // This is what makes crossroads, T-junctions and plaza corners join
      // cleanly instead of pinching to a flat borderless box. `q`/`c` name
      // this road's quadrant and corridor frame sets (tan or stone); both
      // road kinds count as road so a tan/stone seam meets surface-to-surface.
      const ar = recipe.autoroadq;
      const rd = (nx, ny) => { const t = tileAt(nx, ny); return t === T.ROAD || t === T.STONEROAD; };
      const n = rd(tx, ty - 1), s = rd(tx, ty + 1), e = rd(tx + 1, ty), w = rd(tx - 1, ty);
      if (n && s && !e && !w) {
        Assets.drawFrame(ctx, `${ar.c}.vmid`, sx, sy); // clean vertical straight
      } else if (e && w && !n && !s) {
        Assets.drawFrame(ctx, `${ar.c}.hmid`, sx, sy); // clean horizontal straight
      } else {
        const q = 24; // one 8px quadrant drawn at 3x
        // [pos, vertical cardinal road?, horizontal cardinal road?, diagonal road?, dx, dy]
        const quads = [
          ['nw', n, w, rd(tx - 1, ty - 1), 0, 0],
          ['ne', n, e, rd(tx + 1, ty - 1), q, 0],
          ['sw', s, w, rd(tx - 1, ty + 1), 0, q],
          ['se', s, e, rd(tx + 1, ty + 1), q, q],
        ];
        for (const [pos, cardH, cardV, diag, dx, dy] of quads) {
          const t = (cardH && cardV) ? (diag ? 'int' : 'inner')
            : (cardH && !cardV) ? 'edgeV'   // side neighbour is grass
            : (!cardH && cardV) ? 'edgeH'   // top/bottom neighbour is grass
            : 'outer';
          Assets.drawFrame(ctx, `${ar.q}.${pos}.${t}`, sx + dx, sy + dy);
        }
      }
    } else if (recipe.wanim) {
      // The living sea, read by DEPTH the way the pack's own maps paint it:
      // bright lattice in the shallows along the shore, mid water beyond,
      // dark blobs out at sea. Each tile's distance to the nearest land is
      // measured once and remembered; the band's frames shimmer in place.
      const W = recipe.wanim;
      let set;
      if (Array.isArray(W)) {
        // stale cached manifest: the old row-striped ocean
        set = W[((ty % W.length) + W.length) % W.length];
      } else {
        const d = waterDepth(tileAt, tx, ty);
        // dither the contour a little so depth edges wander organically
        const dd = d + (hash(tx * 3 + 1, ty * 5 + 2) < 0.35 ? 1 : 0);
        const group = dd <= 2 ? W.shallow : dd <= 5 ? W.mid : W.deep;
        set = group[((ty % group.length) + group.length) % group.length];
      }
      Assets.drawFrame(ctx, set[Math.floor(time / 180) % set.length], sx, sy);
    } else {
      // A hand-picked ground variant overrides the position hash; anything
      // else (or an out-of-range pick) falls back to the shuffled default.
      const v = sink.tileVariant ? sink.tileVariant(tx, ty) : -1;
      if (v >= 0 && recipe.ground && v < recipe.ground.length) {
        Assets.drawFrame(ctx, recipe.ground[v], sx, sy);
      } else {
        Assets.drawGround(ctx, recipe, h, sx, sy);
      }
    }
    // Mountain ranges: the pack's peak block is a complete range with
    // feathered edges, so cells are picked by NEIGHBOURS, not raw position —
    // crowns where no rock stands above, feet where none stands below,
    // flank cells at the sides, and interlocking interior in between.
    if (recipe.peaks) {
      const P = recipe.peaks;
      if (Array.isArray(P)) {
        // a stale cached manifest still carries the old 3x3 block
        Assets.drawFrame(ctx, P[(tx % 3) + (ty % 3) * 3], sx, sy);
      } else if (P.variants) {
        // the range wears the country it stands in
        const block = P.variants[nearbyBiome(tileAt, tx, ty)] || P.variants.default;
        Assets.drawFrame(ctx, bandedFrame('td.blk.' + block, tileAt, tx, ty, tile), sx, sy);
      } else {
        // older structured manifest: a single brown block
        const rock = (nx, ny) => tileAt(nx, ny) === tile;
        const up = rock(tx, ty - 1);
        const dn = rock(tx, ty + 1);
        let f;
        if (!up && !dn) {
          f = P.lone;
        } else {
          const band = !up ? P.t : !dn ? P.b : P.m;
          f = !rock(tx - 1, ty) ? band[0]
            : !rock(tx + 1, ty) ? band[3]
            : band[1 + (tx % 2)];
        }
        Assets.drawFrame(ctx, f, sx, sy);
      }
    }

    // Forests as the pack paints them: solid interlocking canopy masses.
    // Multi-block biomes (the mire) pick their grove per coarse region, so
    // toadstool patches clump amid the blossom-trees instead of dithering.
    if (recipe.canopy) {
      const blocks = recipe.canopy;
      const block = blocks.length === 1 ? blocks[0]
        : blocks[Math.floor(hash((tx >> 3) * 11 + 5, (ty >> 3) * 7 + 3) * blocks.length)];
      Assets.drawFrame(ctx, bandedFrame('td.blk.' + block, tileAt, tx, ty, tile), sx, sy);
    }

    // Soft biome seams: a higher-priority neighbour lays its tufty
    // fringe over this tile's edge — grass over sand, snow over grass.
    // autotiled roads bring their own grass shoulders; don't double them
    const fr = FRINGES[tile];
    if (fr && !sink.underworld && !recipe.autoroadq && tile !== T.WATER) {
      const pr = fr[1];
      const spill = (fx, fy) => {
        const f = FRINGES[tileAt(fx, fy)];
        return f && f[0] && f[1] > pr ? f[0] : null;
      };
      const n = spill(tx, ty - 1);
      const s = spill(tx, ty + 1);
      const w = spill(tx - 1, ty);
      const e = spill(tx + 1, ty);
      if (n) Assets.drawFrame(ctx, 'td.fr.' + n + '.n', sx, sy);
      if (s) Assets.drawFrame(ctx, 'td.fr.' + s + '.s', sx, sy);
      if (w) Assets.drawFrame(ctx, 'td.fr.' + w + '.w', sx, sy);
      if (e) Assets.drawFrame(ctx, 'td.fr.' + e + '.e', sx, sy);
      // corner nubs where only the diagonal is higher ground, so the
      // seams round off instead of stair-stepping
      let d;
      if (!n && !w && (d = spill(tx - 1, ty - 1))) Assets.drawFrame(ctx, 'td.fr.' + d + '.nw', sx, sy);
      if (!n && !e && (d = spill(tx + 1, ty - 1))) Assets.drawFrame(ctx, 'td.fr.' + d + '.ne', sx, sy);
      if (!s && !w && (d = spill(tx - 1, ty + 1))) Assets.drawFrame(ctx, 'td.fr.' + d + '.sw', sx, sy);
      if (!s && !e && (d = spill(tx + 1, ty + 1))) Assets.drawFrame(ctx, 'td.fr.' + d + '.se', sx, sy);
    }

    // Curved shores. Every land/water seam is repainted along a wavy
    // waterline that wanders ACROSS the tile grid rather than tracing it:
    // on the crests the land bulges into the water, in the troughs the
    // water bites back into the land, and a foam line rides the boundary.
    // The wave is keyed to world pixels and drawn from BOTH sides of the
    // seam, so the same curve is stamped identically by the water tile and
    // its land neighbour and the two halves meet seamlessly.
    if (!sink.underworld && !recipe.autoroadq) {
      const meIsWater = tile === T.WATER;
      const STEP = 3; // one source-pixel: keeps the shoreline chunky, not smooth
      const q3 = (v) => Math.round(v / STEP) * STEP;
      // seam across one edge: `nt` is the neighbour tile, `horiz` true when
      // the seam runs left-right (wave keyed to world x), `nearZero` true
      // when this tile lies on the low-coordinate side of the seam.
      const paintSeam = (nt, horiz, nearZero) => {
        const landWater = meIsWater && COAST[nt] != null;      // land bulges in
        const waterLand = !meIsWater && COAST[tile] != null && nt === T.WATER; // water bites in
        if (!landWater && !waterLand) return;
        const fill = meIsWater ? COAST[nt] : COAST_WET;
        for (let a = 0; a < TP; a += STEP) {
          const world = (horiz ? tx : ty) * TP + a + STEP / 2;
          const off = q3(shoreWave(world, time));
          // boundary distance from THIS tile's edge, measured inward
          const depth = nearZero ? off : -off; // low side fills [0,depth]; high side fills [TP+off,TP]
          if (depth <= 0) continue;
          const d = Math.min(depth, TP);
          const b = nearZero ? d : TP - d; // foam-line position along the axis
          if (horiz) {
            ctx.fillStyle = fill;
            ctx.fillRect(sx + a, sy + (nearZero ? 0 : TP - d), STEP, d);
            ctx.fillStyle = COAST_FOAM;
            ctx.fillRect(sx + a, sy + b - (nearZero ? STEP : 0), STEP, STEP);
          } else {
            ctx.fillStyle = fill;
            ctx.fillRect(sx + (nearZero ? 0 : TP - d), sy + a, d, STEP);
            ctx.fillStyle = COAST_FOAM;
            ctx.fillRect(sx + b - (nearZero ? STEP : 0), sy + a, STEP, STEP);
          }
        }
      };
      paintSeam(tileAt(tx, ty - 1), true, true);   // north edge
      paintSeam(tileAt(tx, ty + 1), true, false);  // south edge
      paintSeam(tileAt(tx - 1, ty), false, true);  // west edge
      paintSeam(tileAt(tx + 1, ty), false, false); // east edge
    }

    const belowT = tileAt(tx, ty + 1);
    if (under && recipe.torch && (belowT === T.CAVE || belowT === T.PLANKS) && hash(tx * 7, ty * 3) < 0.14) {
      sink.push({ depth: ty, kind: 'sprite', name: 'td.o.torch', x: sx + HT, y: sy + TP + 12 });
      if (sink.torch) sink.torch(tx + 0.5, ty + 0.8);
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
      sink.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
    } else if (recipe.object) {
      const name = recipe.object[Math.floor(hash(tx * 5 + 1, ty) * recipe.object.length)];
      sink.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
    } else if (recipe.decor && hash(tx, ty * 3 + 1) < recipe.decor.chance) {
      const name = recipe.decor.objects[Math.floor(h * recipe.decor.objects.length)];
      sink.push({ depth: ty, kind: 'sprite', name, x: sx + HT + jx, y: sy + TP + jy });
    }
    if (recipe.effect === 'water' && sink.waterGlint) sink.waterGlint(tx, ty, sx, sy, time);
    if (recipe.effect === 'shrine') sink.push({ depth: ty, kind: 'shrine', x: sx + HT, y: sy + HT });
  }

  return { T, FRINGES, TP, HT, hash, drawCell, clearWaterDepth };
})();
