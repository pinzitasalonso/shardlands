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
      const res = await fetch('assets/manifest.json');
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

  function drawFrame(ctx, name, sx, sy) {
    const f = state.manifest.frames[name];
    if (!f) return;
    ctx.drawImage(state.images[f.img], f.x, f.y, f.w, f.h,
      Math.round(sx - f.ax), Math.round(sy - f.ay), f.w, f.h);
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
  function drawCreature(ctx, kind, heading, anim, timeMs, sx, sy) {
    const c = state.manifest.creatures[kind];
    if (!c) return false;
    const a = c.anims[anim] || c.anims.stance;
    const row = c.dirs > 1 ? heading : 0;
    const col = a.start + animFrame(a, timeMs);
    ctx.drawImage(state.images[c.img],
      col * c.cellW, row * c.cellH, c.cellW, c.cellH,
      Math.round(sx - c.ax), Math.round(sy - c.ay), c.cellW, c.cellH);
    return true;
  }

  return { state, load, tile, creature, drawFrame, drawGround, drawCreature };
})();
