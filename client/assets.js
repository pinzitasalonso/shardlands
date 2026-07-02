'use strict';

// Sprite asset system. Loads assets/manifest.json plus the images it names,
// and exposes draw helpers for ground diamonds, scenery objects and animated
// creatures. Everything is data-driven: to reskin the game, edit the manifest
// (or regenerate it with tools/build-assets.py) — no code changes needed.
//
// If the manifest or an image fails to load the game still runs; game.js
// falls back to flat-shaded procedural rendering.

const Assets = (() => {
  const state = {
    ok: false,
    manifest: null,
    images: {},
    proc: {}, // name -> pre-rendered procedural ground canvas variants
  };

  async function load() {
    try {
      const res = await fetch('assets/manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('manifest http ' + res.status);
      const manifest = await res.json();
      const pairs = await Promise.all(Object.entries(manifest.images).map(
        ([key, src]) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve([key, img]);
          img.onerror = () => reject(new Error('failed to load ' + src));
          img.src = 'assets/' + src;
        })
      ));
      for (const [key, img] of pairs) state.images[key] = img;
      state.manifest = manifest;
      buildProcGrounds();
      state.ok = true;
    } catch (err) {
      console.warn('Sprite assets unavailable; using fallback rendering.', err);
    }
  }

  // Procedural pixel-noise diamonds for grounds with no sheet art (sand,
  // dirt roads). Drawn once into offscreen canvases, in palettes that sit
  // well next to the painted tiles.
  const PROC_PALETTES = {
    sand: ['#c8b478', '#c0ac70', '#d0bc84', '#bca868'],
    dirt: ['#9a7a52', '#8f714b', '#a5845a', '#856844'],
    snow: ['#e9eef3', '#dfe6ee', '#f2f6f9', '#d6dfe9'],
    grass: ['#76883e', '#6d7f38', '#7f9244', '#687a36'],
    swamp: ['#5a6b42', '#52613c', '#647549', '#4c5c3a'],
    cave: ['#4a443c', '#423d36', '#524c42', '#3a352e'],
    water: ['#5b87c8', '#5583c4', '#618fd0', '#5f8bcc'],
  };

  function buildProcGrounds() {
    for (const [name, palette] of Object.entries(PROC_PALETTES)) {
      state.proc[name] = [];
      for (let v = 0; v < 4; v++) {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 32;
        const g = c.getContext('2d');
        let seed = (v + 1) * 7919;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let y = 0; y < 32; y++) {
          const dy = y < 16 ? y : 31 - y;
          const x0 = 32 - 2 * (dy + 1);
          const x1 = 32 + 2 * (dy + 1);
          for (let x = x0; x < x1; x += 2) {
            g.fillStyle = palette[Math.floor(rnd() * palette.length)];
            g.fillRect(x, y, 2, 1);
          }
        }
        state.proc[name].push(c);
      }
    }
  }

  // Fringe canvases keyed by palette + edge (0 = upper-left, 1 = upper-right,
  // 2 = lower-right, 3 = lower-left), built lazily.
  const fringes = new Map();

  function fringeCanvas(pal, edge) {
    const key = pal + ':' + edge;
    let c = fringes.get(key);
    if (c) return c;
    const palette = PROC_PALETTES[pal];
    c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d');
    let seed = edge * 31337 + pal.length * 7919 + 17;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < 32; y++) {
      const dy = y < 16 ? y : 31 - y;
      const x0 = 32 - 2 * (dy + 1);
      const x1 = 32 + 2 * (dy + 1);
      for (let x = x0; x < x1; x += 2) {
        // Distance (in px) from this block to each diamond edge.
        const d = [
          x / 2 + y - 16,              // upper-left
          (64 - x) / 2 + y - 16,       // upper-right
          (64 - x) / 2 + (32 - y) - 16, // lower-right
          x / 2 + (32 - y) - 16,       // lower-left
        ][edge];
        const a = 1 - d / 9;
        if (a <= 0 || rnd() > a * 0.95) continue;
        g.fillStyle = palette[Math.floor(rnd() * palette.length)];
        g.fillRect(x, y, 2, 1);
      }
    }
    fringes.set(key, c);
    return c;
  }

  // Overlay the fringe of a neighbouring terrain along one diamond edge.
  function drawFringe(ctx, pal, edge, sx, sy) {
    if (!PROC_PALETTES[pal]) return;
    ctx.drawImage(fringeCanvas(pal, edge), Math.round(sx), Math.round(sy));
  }

  function drawFrame(ctx, name, sx, sy) {
    if (!state.ok) return;
    const f = state.manifest.frames[name];
    if (!f) return;
    const k = f.scale || 1;
    ctx.drawImage(state.images[f.img], f.x, f.y, f.w, f.h,
      Math.round(sx - f.ax * k), Math.round(sy - f.ay * k), f.w * k, f.h * k);
  }

  // Ground anchor is the top-left of the diamond's 64x32 bounding box.
  function drawGround(ctx, recipe, hashVal, sx, sy) {
    if (recipe.groundProc) {
      const variants = state.proc[recipe.groundProc];
      ctx.drawImage(variants[Math.floor(hashVal * variants.length)], Math.round(sx), Math.round(sy));
    } else {
      const names = recipe.ground;
      drawFrame(ctx, names[Math.floor(hashVal * names.length)], sx, sy);
    }
  }

  function tile(id) {
    return state.manifest.tiles[id];
  }

  // Top-down 16px recipes (the renderer's native format; the iso `tiles`
  // recipes above are kept for reference until the old sheets are retired).
  function tileTD(id) {
    return state.manifest.tilesTD && state.manifest.tilesTD[id];
  }

  function creature(kind) {
    return state.manifest.creatures[kind];
  }

  // Frame index within an animation band. 'back_forth' plays 0,1,2,3,2,1;
  // 'loop' wraps around.
  function animFrame(a, timeMs) {
    if (a.frames < 2) return 0;
    if (a.loop === 'back_forth') {
      const cycle = 2 * a.frames - 2;
      const k = Math.floor(timeMs / a.ms) % cycle;
      return k < a.frames ? k : cycle - k;
    }
    return Math.floor(timeMs / a.ms) % a.frames;
  }

  // (sx, sy) is the creature's feet — the centre of the tile it stands on.
  // anim is 'stance', 'run' or 'melee'; falls back to stance.
  // overlay names a geometry-identical atlas (e.g. an equipped weapon)
  // drawn over the base with the same frame indices.
  function drawCreature(ctx, kind, heading, anim, timeMs, sx, sy, scale = 1, overlay = null) {
    const c = state.manifest.creatures[kind];
    if (!c) return false;
    const a = c.anims[anim] || c.anims.stance;
    const row = c.dirs > 1 ? heading : 0;
    const col = a.start + animFrame(a, timeMs);
    const args = [
      col * c.cellW, row * c.cellH, c.cellW, c.cellH,
      Math.round(sx - c.ax * scale), Math.round(sy - c.ay * scale),
      c.cellW * scale, c.cellH * scale,
    ];
    ctx.drawImage(state.images[c.img], ...args);
    if (overlay && c.overlays) {
      for (const name of Array.isArray(overlay) ? overlay : [overlay]) {
        if (c.overlays[name]) ctx.drawImage(state.images[c.overlays[name]], ...args);
      }
    }
    return true;
  }

  return { state, load, tile, tileTD, creature, drawFrame, drawGround, drawCreature, drawFringe };
})();
