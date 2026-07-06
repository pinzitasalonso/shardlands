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

    if (recipe.wanim) {
      // The living sea: each map row wears its band of the pack's
      // vertically repeating ocean, and that band's frames shimmer in
      // place — the waves stay put, only the light moves.
      const rows = recipe.wanim;
      const set = rows[((ty % rows.length) + rows.length) % rows.length];
      Assets.drawFrame(ctx, set[Math.floor(time / 180) % set.length], sx, sy);
    } else {
      Assets.drawGround(ctx, recipe, h, sx, sy);
    }
    // mountain ranges: interlocking peak cells picked by map position,
    // grass showing through the gaps exactly like the pack's own maps
    if (recipe.peaks) {
      Assets.drawFrame(ctx, recipe.peaks[(tx % 3) + (ty % 3) * 3], sx, sy);
    }

    // Soft biome seams: a higher-priority neighbour lays its tufty
    // fringe over this tile's edge — grass over sand, snow over grass.
    const fr = FRINGES[tile];
    if (fr && !sink.underworld) {
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

  return { T, FRINGES, TP, HT, hash, drawCell };
})();
