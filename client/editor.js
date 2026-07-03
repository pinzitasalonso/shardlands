'use strict';

// The world builder. Top-down view of the whole 2048x2048 world with two
// rendering modes: a fast 1px-per-tile overview, and — once you zoom past
// SPRITE_ZOOM — the game's own renderer (tiles-render.js + assets.js), so
// what you see here is exactly what players see.
//
// Everything you change is an *edit overlay*; Save sends the full overlay
// and the server applies the delta to the RUNNING world (no restart) and
// persists it on the data volume. Publish commits it to GitHub.

const TILE_COLORS = [
  [38, 70, 110], [86, 125, 70], [40, 80, 42], [120, 116, 108], [150, 124, 86],
  [170, 150, 110], [90, 86, 80], [196, 178, 128], [240, 220, 130], [225, 228, 235],
  [180, 195, 205], [140, 105, 65], [70, 90, 60], [50, 70, 48], [28, 24, 32],
];
const SPRITE_ZOOM = 20; // px per tile where the art view takes over

const cv = document.getElementById('map');
const ctx = cv.getContext('2d');
const coordsEl = document.getElementById('coords');
const statusEl = document.getElementById('status');

const view = { x: 1024, y: 1024, scale: 0.4 }; // world tile at canvas centre
let world = null;   // { w, h, tiles: Uint8Array, props, spawners, secrets, ... }
let base = null;    // offscreen canvas, 1px per tile
let tool = 'pan';
let paintTile = 4;  // road
let propName = null; // selected catalog prop, e.g. 'prop.trees0'
let dirty = false;
let tileNames = [];
let portalFrom = null; // first click of the portal tool
let cursor = { x: -1, y: -1 };

// The edit overlay being built. Tiles use a Map for dedupe ("x,y" -> tile).
const edits = {
  tiles: new Map(),
  props: [], removeProps: [],
  spawners: [], removeSpawners: [],
  secrets: [], removeSecrets: [],
  buildings: [],
};
const undoStack = [];

function setStatus(text) {
  statusEl.innerHTML = (dirty ? '<span id="dirty">● unsaved changes</span><br>' : '') + text;
}

// ---- loading -------------------------------------------------------------------

async function load() {
  const [metaRes, tilesRes] = await Promise.all([fetch('/editor/meta'), fetch('/editor/tiles')]);
  if (metaRes.status === 401) { location.href = '/editor-login.html'; return; }
  if (!metaRes.ok) {
    setStatus((await metaRes.json()).error || 'editor API refused');
    return;
  }
  const meta = await metaRes.json();
  world = { ...meta, tiles: new Uint8Array(await tilesRes.arrayBuffer()) };
  tileNames = Object.entries(meta.tileNames || {})
    .sort((a, b) => a[0] - b[0]).map(([, n]) => n.toLowerCase());

  // resume the saved overlay so editing is cumulative
  if (meta.edits) {
    for (const [x, y, v] of meta.edits.tiles || []) edits.tiles.set(x + ',' + y, v);
    edits.props = meta.edits.props || [];
    edits.removeProps = meta.edits.removeProps || [];
    edits.spawners = meta.edits.spawners || [];
    edits.removeSpawners = meta.edits.removeSpawners || [];
    edits.secrets = meta.edits.secrets || [];
    edits.removeSecrets = meta.edits.removeSecrets || [];
    edits.buildings = meta.edits.buildings || [];
  }

  base = document.createElement('canvas');
  base.width = world.w;
  base.height = world.h;
  const img = new ImageData(world.w, world.h);
  for (let i = 0; i < world.tiles.length; i++) {
    const c = TILE_COLORS[world.tiles[i]] || [255, 0, 255];
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  base.getContext('2d').putImageData(img, 0, 0);

  buildSidebar();
  const when = meta.savedAt ? new Date(meta.savedAt).toLocaleString() : 'never';
  setStatus(`World loaded: ${world.props.length} props, ${world.spawners.length} spawners, ` +
    `${world.secrets.length} secrets. Overlay last saved: ${when}.` +
    (meta.publishConfigured ? '' : '<br>Publish needs GITHUB_TOKEN + GITHUB_REPO on the server.'));
  draw();
}

function paintBasePixel(x, y, t) {
  const g = base.getContext('2d');
  const c = TILE_COLORS[t];
  g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  g.fillRect(x, y, 1, 1);
}

// ---- sidebar -------------------------------------------------------------------

function thumbnail(frameName, w = 34, h = 34) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  const f = Assets.state.manifest && Assets.state.manifest.frames[frameName];
  if (!f) return c;
  const k = Math.min(w / (f.w * 1.05), h / (f.h * 1.05), 2);
  g.setTransform(k, 0, 0, k, 0, 0);
  Assets.drawFrame(g, frameName, (w / k) / 2, (h / k) - 1);
  return c;
}

function buildPropPalette(filter = '') {
  const pal = document.getElementById('prop-palette');
  pal.innerHTML = '';
  const cats = (Assets.state.manifest && Assets.state.manifest.propCategories) || {};
  // classic hand-placed props stay available under their own heading
  const groups = { classics: ['well', 'table', 'stool', 'chest', 'lamp', 'statue', 'signpost',
    'kiosk', 'fountain', 'flowers0', 'flowers1', 'flowers2', 'bush0', 'bush1',
    'cottage0', 'cottage1', 'cottage2', 'cottage3', 'stairsup', 'torch',
    'keep', 'ruins', 'graveyard', 'dragoncity', 'snakelair', 'daemoncave',
    'dwarffortress', 'bloodtemple', 'citycastle', 'citytower', 'citystronghold',
    'cityrampart'], ...cats };
  let first = true;
  for (const [cat, names] of Object.entries(groups)) {
    const shown = names.filter((n) => !filter || n.includes(filter));
    if (!shown.length) continue;
    const det = document.createElement('details');
    det.open = !!filter || first;
    first = false;
    const sum = document.createElement('summary');
    sum.textContent = `${cat} (${shown.length})`;
    det.appendChild(sum);
    const grid = document.createElement('div');
    grid.className = 'prop-grid';
    for (const n of shown) {
      const b = document.createElement('button');
      b.title = n;
      b.dataset.prop = 'prop.' + n;
      b.appendChild(thumbnail('td.o.' + n));
      if (propName === 'prop.' + n) b.classList.add('on');
      b.onclick = () => {
        propName = 'prop.' + n;
        for (const o of pal.querySelectorAll('button')) o.classList.remove('on');
        b.classList.add('on');
        pickTool('prop');
      };
      grid.appendChild(b);
    }
    det.appendChild(grid);
    pal.appendChild(det);
  }
  // the one non-prop placeable
  const fireBtn = document.createElement('button');
  fireBtn.textContent = '🔥 campfire';
  fireBtn.style.width = '100%';
  fireBtn.onclick = () => { propName = 'fx.campfire'; pickTool('prop'); };
  pal.appendChild(fireBtn);
}

function drawMobThumb() {
  const kind = document.getElementById('mob-kind').value;
  const c = document.getElementById('mob-thumb');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = false;
  const cr = Assets.creature(kind);
  if (!cr) return;
  const k = Math.min(44 / cr.cellW, 44 / cr.cellH, 1);
  g.setTransform(k, 0, 0, k, 0, 0);
  Assets.drawCreature(g, kind, 2, 'stance', 0, (c.width / k) / 2, (c.height / k) - 2, 1);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function buildSidebar() {
  const pal = document.getElementById('palette');
  tileNames.forEach((name, i) => {
    const b = document.createElement('button');
    const c = TILE_COLORS[i];
    b.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    b.title = name;
    b.innerHTML = `<span>${name}</span>`;
    if (i === paintTile) b.classList.add('on');
    b.onclick = () => {
      paintTile = i;
      for (const o of pal.children) o.classList.remove('on');
      b.classList.add('on');
      pickTool('paint');
    };
    pal.appendChild(b);
  });
  buildPropPalette();
  document.getElementById('prop-search').oninput = (ev) =>
    buildPropPalette(ev.target.value.trim().toLowerCase());
  const mobSel = document.getElementById('mob-kind');
  for (const k of world.mobKinds) mobSel.add(new Option(k, k));
  mobSel.onchange = drawMobThumb;
  drawMobThumb();
  const bSel = document.getElementById('building-kind');
  for (const k of world.buildingKinds || []) bSel.add(new Option(k, k));
  const go = document.getElementById('goto');
  go.add(new Option('— jump to —', ''));
  for (const c of world.cities || []) go.add(new Option('🏰 ' + c.name, c.x + ',' + c.y));
  for (const v of world.villages || []) go.add(new Option('🏠 ' + v.name, v.x + ',' + v.y));
  go.onchange = () => {
    if (!go.value) return;
    const [x, y] = go.value.split(',').map(Number);
    view.x = x;
    view.y = y;
    view.scale = Math.max(view.scale, SPRITE_ZOOM);
    draw();
  };
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.onclick = () => pickTool(b.dataset.tool);
  }
  document.getElementById('undo').onclick = undo;
  document.getElementById('save').onclick = save;
  document.getElementById('publish').onclick = publish;
  document.getElementById('download').onclick = () => { location.href = '/editor/edits'; };
  document.getElementById('logout').onclick = async () => {
    await fetch('/editor/logout', { method: 'POST' });
    location.href = '/editor-login.html';
  };
}

function pickTool(t) {
  tool = t;
  portalFrom = null;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === t);
  }
  cv.style.cursor = t === 'pan' ? 'grab' : 'crosshair';
}

// ---- view & drawing --------------------------------------------------------------

function resize() {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = cv.clientHeight * devicePixelRatio;
  draw();
}
window.addEventListener('resize', resize);

function worldToScreen(x, y) {
  return {
    x: cv.width / 2 + (x - view.x) * view.scale * devicePixelRatio,
    y: cv.height / 2 + (y - view.y) * view.scale * devicePixelRatio,
  };
}

function screenToWorld(px, py) {
  return {
    x: view.x + (px * devicePixelRatio - cv.width / 2) / (view.scale * devicePixelRatio),
    y: view.y + (py * devicePixelRatio - cv.height / 2) / (view.scale * devicePixelRatio),
  };
}

const removedPair = (list, x, y) => list.some(([rx, ry]) => rx === x && ry === y);

function visibleRange(pad = 2) {
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cv.clientWidth, cv.clientHeight);
  return {
    x0: Math.max(0, Math.floor(tl.x) - pad),
    y0: Math.max(0, Math.floor(tl.y) - pad),
    x1: Math.min(world.w - 1, Math.ceil(br.x) + pad),
    y1: Math.min(world.h - 1, Math.ceil(br.y) + pad),
  };
}

// The art view: the game's own ground pass plus every entity as its sprite.
function drawSprites() {
  const s = view.scale * devicePixelRatio;
  const k = s / 48;
  const { x0, y0, x1, y1 } = visibleRange(3);
  const tileAt = (x, y) =>
    (x < 0 || y < 0 || x >= world.w || y >= world.h) ? 0 : world.tiles[y * world.w + x];
  const drawables = [];
  const sink = { underworld: false, push: (d) => drawables.push(d) };
  const time = performance.now();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingEnabled = false;
  for (let ty = y0; ty <= y1; ty++) {
    sink.underworld = ty < 64;
    for (let tx = x0; tx <= x1; tx++) {
      const o = worldToScreen(tx, ty);
      GroundRender.drawCell(ctx, tileAt, tx, ty, o.x / k, o.y / k, time, sink);
    }
  }
  // entities join the same depth sort so buildings overlap like in-game
  const pushProp = (p, bright) => {
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return;
    const o = worldToScreen(p.x, p.y);
    const suffix = p.name.split('.')[1];
    if (p.name === 'fx.campfire') {
      drawables.push({ depth: p.y, kind: 'sprite', name: 'td.o.torch', x: o.x / k + 24, y: o.y / k + 48, bright });
    } else {
      drawables.push({ depth: p.y, kind: 'sprite', name: 'td.o.' + suffix, x: o.x / k + 24, y: o.y / k + 48, bright });
    }
  };
  for (const p of world.props) if (!removedPair(edits.removeProps, p.x, p.y)) pushProp(p, false);
  for (const p of edits.props) pushProp(p, true);
  for (const b of edits.buildings) pushProp({ x: b.x, y: b.y, name: 'prop.' + b.name }, true);
  const pushMob = (sp, bright) => {
    if (sp.x < x0 || sp.x > x1 || sp.y < y0 || sp.y > y1) return;
    const o = worldToScreen(sp.x, sp.y);
    drawables.push({ depth: sp.y, kind: 'mob', mob: sp.kind, x: o.x / k + 24, y: o.y / k + 46, bright, r: sp.r });
  };
  for (const sp of world.spawners) if (!removedPair(edits.removeSpawners, sp.x, sp.y)) pushMob(sp, false);
  for (const sp of edits.spawners) pushMob(sp, true);

  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) {
    ctx.globalAlpha = d.bright === false ? 0.85 : 1;
    if (d.kind === 'mob') {
      Assets.drawCreature(ctx, d.mob, 2, 'stance', 0, d.x, d.y, 1);
    } else if (d.kind === 'sprite') {
      Assets.drawFrame(ctx, d.name, d.x, d.y);
    } else if (d.kind === 'shrine') {
      ctx.fillStyle = '#ffe9a8';
      ctx.font = '28px serif';
      ctx.textAlign = 'center';
      ctx.fillText('☥', d.x, d.y + 8);
    }
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // spawner radii for your own spawners
  for (const sp of edits.spawners) {
    const p = worldToScreen(sp.x + 0.5, sp.y + 0.5);
    ctx.strokeStyle = 'rgba(255,106,90,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, sp.r * s, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function draw() {
  if (!base) return;
  const s = view.scale * devicePixelRatio;
  const spriteMode = view.scale >= SPRITE_ZOOM && Assets.state.ok;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, cv.width, cv.height);

  if (spriteMode) {
    drawSprites();
  } else {
    ctx.imageSmoothingEnabled = view.scale < 4; // crisp pixels when zoomed in
    const o = worldToScreen(0, 0);
    ctx.drawImage(base, o.x, o.y, world.w * s, world.h * s);
  }

  // tile grid when close enough to care about single tiles
  if (view.scale >= 10 && !spriteMode) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    const { x0, y0, x1, y1 } = visibleRange(0);
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      const p = worldToScreen(x, 0);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, cv.height);
    }
    for (let y = y0; y <= y1 + 1; y++) {
      const p = worldToScreen(0, y);
      ctx.moveTo(0, p.y);
      ctx.lineTo(cv.width, p.y);
    }
    ctx.stroke();
  }

  // entity markers from medium zoom; in sprite mode only the abstract ones
  // (secrets, vendors) still need glyphs
  if (view.scale >= 1.5) {
    const mark = (x, y, color, glyph, bright) => {
      const p = worldToScreen(x + 0.5, y + 0.5);
      if (p.x < -20 || p.y < -20 || p.x > cv.width + 20 || p.y > cv.height + 20) return;
      ctx.globalAlpha = bright ? 1 : 0.55;
      ctx.fillStyle = color;
      ctx.font = `${Math.max(10, Math.min(18, view.scale * 1.6)) * devicePixelRatio}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, p.x, p.y);
      ctx.globalAlpha = 1;
    };
    if (!spriteMode) {
      for (const p of world.props) {
        if (!removedPair(edits.removeProps, p.x, p.y)) mark(p.x, p.y, '#ffb347', '▲', false);
      }
      for (const sp of world.spawners) {
        if (!removedPair(edits.removeSpawners, sp.x, sp.y)) mark(sp.x, sp.y, '#ff6a5a', '●', false);
      }
      for (const p of edits.props) mark(p.x, p.y, '#ffb347', '▲', true);
      for (const sp of edits.spawners) mark(sp.x, sp.y, '#ff6a5a', '●', true);
      for (const b of edits.buildings) mark(b.x, b.y, '#ffd060', '⌂', true);
    }
    for (const sc of world.secrets) {
      if (sc.dead || removedPair(edits.removeSecrets, sc.x, sc.y)) continue;
      mark(sc.x, sc.y, '#c08aff', '◆', false);
    }
    for (const v of world.vendors) mark(v.x, v.y, '#7ad07a', '■', false);
    for (const sc of edits.secrets) mark(sc.x, sc.y, '#c08aff', '◆', true);
    // portal lines to their twins, so links read at a glance
    ctx.strokeStyle = 'rgba(192,138,255,0.45)';
    ctx.lineWidth = 1.5;
    const portalLine = (sc) => {
      if (sc.type !== 'portal') return;
      const a = worldToScreen(sc.x + 0.5, sc.y + 0.5);
      const b = worldToScreen(sc.tx + 0.5, sc.ty + 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    for (const sc of edits.secrets) portalLine(sc);
  }

  // ghost preview of the thing about to be placed
  if (cursor.x >= 0 && tool !== 'pan' && tool !== 'erase') {
    const p = worldToScreen(cursor.x, cursor.y);
    if (view.scale >= SPRITE_ZOOM && Assets.state.ok) {
      const k = s / 48;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.55;
      if (tool === 'prop' && propName) {
        Assets.drawFrame(ctx, propName === 'fx.campfire' ? 'td.o.torch' : 'td.o.' + propName.split('.')[1],
          p.x / k + 24, p.y / k + 48);
      } else if (tool === 'building') {
        Assets.drawFrame(ctx, 'td.o.' + document.getElementById('building-kind').value,
          p.x / k + 24, p.y / k + 48);
      } else if (tool === 'spawner') {
        Assets.drawCreature(ctx, document.getElementById('mob-kind').value, 2, 'stance', 0,
          p.x / k + 24, p.y / k + 46, 1);
      } else if (tool === 'paint') {
        ctx.globalAlpha = 0.4;
        const c = TILE_COLORS[paintTile];
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        const size = +document.getElementById('brush').value;
        const half = size >> 1;
        ctx.fillRect(p.x / k - half * 48, p.y / k - half * 48, size * 48, size * 48);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.strokeStyle = 'rgba(255,233,168,0.8)';
      ctx.strokeRect(p.x, p.y, Math.max(2, s), Math.max(2, s));
    }
  }
  if (tool === 'portal' && portalFrom) {
    const a = worldToScreen(portalFrom.x + 0.5, portalFrom.y + 0.5);
    ctx.strokeStyle = '#c08aff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(6, s / 2), 0, Math.PI * 2);
    ctx.stroke();
  }

  // settlement labels at overview zoom
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4e9c8';
  for (const c of world.cities || []) {
    const p = worldToScreen(c.x, c.y);
    ctx.font = `bold ${13 * devicePixelRatio}px Georgia`;
    ctx.fillText(c.name, p.x, p.y - 8 * devicePixelRatio);
  }
  if (view.scale >= 0.8) {
    ctx.fillStyle = '#d9cba6';
    for (const v of world.villages || []) {
      const p = worldToScreen(v.x, v.y);
      ctx.font = `${11 * devicePixelRatio}px Georgia`;
      ctx.fillText(v.name, p.x, p.y - 6 * devicePixelRatio);
    }
  }
}

// ---- editing actions ---------------------------------------------------------------

function paintAt(wx, wy) {
  const size = +document.getElementById('brush').value;
  const half = size >> 1;
  const cells = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = wx + dx;
      const y = wy + dy;
      if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
      const key = x + ',' + y;
      if (world.tiles[y * world.w + x] === paintTile && !edits.tiles.has(key)) continue;
      cells.push([x, y, edits.tiles.has(key) ? edits.tiles.get(key) : null,
        world.tiles[y * world.w + x]]);
      edits.tiles.set(key, paintTile);
      world.tiles[y * world.w + x] = paintTile;
      paintBasePixel(x, y, paintTile);
    }
  }
  if (cells.length) {
    strokeCells.push(...cells);
    dirty = true;
    setStatus('painting…');
  }
}

// Mirror placeBuilding's surface tiles locally, so the preview is honest.
function stampBuildingTiles(bx, by) {
  const cells = [];
  const setT = (x, y, t) => {
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) return;
    cells.push([x, y, world.tiles[y * world.w + x]]);
    world.tiles[y * world.w + x] = t;
    paintBasePixel(x, y, t);
  };
  for (let y = by - 1; y <= by + 1; y++) {
    for (let x = bx - 1; x <= bx + 2; x++) setT(x, y, 1); // grass lawn
  }
  setT(bx, by, 6);      // wall footprint
  setT(bx + 1, by, 6);
  setT(bx, by + 1, 4);  // the worn doorstep
  return cells;
}

function placeAt(wx, wy) {
  if (tool === 'prop') {
    if (!propName) return setStatus('pick a prop from the catalog first');
    edits.props.push({ x: wx, y: wy, name: propName });
    undoStack.push({ kind: 'prop' });
  } else if (tool === 'spawner') {
    edits.spawners.push({
      kind: document.getElementById('mob-kind').value,
      count: +document.getElementById('mob-count').value || 4,
      x: wx, y: wy,
      r: +document.getElementById('mob-r').value || 8,
    });
    undoStack.push({ kind: 'spawner' });
  } else if (tool === 'building') {
    const name = document.getElementById('building-kind').value;
    const cells = stampBuildingTiles(wx, wy);
    edits.buildings.push({ x: wx, y: wy, name });
    undoStack.push({ kind: 'building', cells });
  } else if (tool === 'portal') {
    if (!portalFrom) {
      portalFrom = { x: wx, y: wy };
      setStatus(`portal from ${wx}, ${wy} — now click the destination`);
      return draw();
    }
    const style = document.getElementById('portal-kind').value;
    const flags = style ? { [style]: true } : {};
    edits.secrets.push({ type: 'portal', x: portalFrom.x, y: portalFrom.y, tx: wx, ty: wy, ...flags });
    let n = 1;
    if (document.getElementById('portal-two').checked) {
      edits.secrets.push({ type: 'portal', x: wx, y: wy, tx: portalFrom.x, ty: portalFrom.y, ...flags });
      n = 2;
    }
    undoStack.push({ kind: 'portal', n });
    setStatus(`portal ${portalFrom.x},${portalFrom.y} ⇄ ${wx},${wy}`);
    portalFrom = null;
  } else if (tool === 'whisper') {
    const text = prompt('What does this place whisper to travellers?');
    if (!text || !text.trim()) return;
    edits.secrets.push({ type: 'whisper', x: wx, y: wy, text: text.trim() });
    undoStack.push({ kind: 'secret' });
  } else if (tool === 'cache') {
    edits.secrets.push({ type: 'cache', x: wx, y: wy });
    undoStack.push({ kind: 'secret' });
  }
  dirty = true;
  setStatus('placed at ' + wx + ', ' + wy);
  draw();
}

function eraseAt(wx, wy) {
  const near = (e) => Math.abs(e.x - wx) <= 1 && Math.abs(e.y - wy) <= 1;
  // hand edits go first — they simply vanish from the overlay
  const editLists = [['props', 'prop'], ['spawners', 'spawner'], ['secrets', 'secret'],
    ['buildings', 'building']];
  for (const [listName, what] of editLists) {
    const i = edits[listName].findIndex(near);
    if (i >= 0) {
      const [gone] = edits[listName].splice(i, 1);
      undoStack.push({ kind: 'unerase-edit', listName, gone });
      dirty = true;
      setStatus(`removed your ${what} at ${gone.x}, ${gone.y}` +
        (listName === 'buildings' ? ' (its tiles settle at the next restart)' : ''));
      return draw();
    }
  }
  // then generated entities — recorded as removals in the overlay
  for (const [srcName, rmName] of [['props', 'removeProps'], ['spawners', 'removeSpawners'],
    ['secrets', 'removeSecrets']]) {
    const hit = world[srcName].find((e) => near(e) && !e.dead &&
      !edits[rmName].some(([x, y]) => x === e.x && y === e.y));
    if (hit) {
      edits[rmName].push([hit.x, hit.y]);
      undoStack.push({ kind: 'unerase-world', rmName });
      dirty = true;
      setStatus(`marked generated ${srcName.slice(0, -1)} at ${hit.x}, ${hit.y} for removal`);
      return draw();
    }
  }
  setStatus('nothing here to erase');
}

function undo() {
  const op = undoStack.pop();
  if (!op) return setStatus('nothing to undo');
  if (op.kind === 'tiles' || op.kind === 'building') {
    if (op.kind === 'building') edits.buildings.pop();
    for (const cell of op.cells) {
      const [x, y] = cell;
      if (op.kind === 'tiles') {
        const [, , prevEdit, prevWorld] = cell;
        if (prevEdit === null) edits.tiles.delete(x + ',' + y);
        else edits.tiles.set(x + ',' + y, prevEdit);
        world.tiles[y * world.w + x] = prevWorld;
        paintBasePixel(x, y, prevWorld);
      } else {
        const prev = cell[2];
        world.tiles[y * world.w + x] = prev;
        paintBasePixel(x, y, prev);
      }
    }
  } else if (op.kind === 'prop') edits.props.pop();
  else if (op.kind === 'spawner') edits.spawners.pop();
  else if (op.kind === 'secret') edits.secrets.pop();
  else if (op.kind === 'portal') for (let i = 0; i < op.n; i++) edits.secrets.pop();
  else if (op.kind === 'unerase-edit') edits[op.listName].push(op.gone);
  else if (op.kind === 'unerase-world') edits[op.rmName].pop();
  dirty = true;
  setStatus('undone');
  draw();
}

function payload() {
  return {
    tiles: [...edits.tiles.entries()].map(([k, v]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, v];
    }),
    props: edits.props,
    removeProps: edits.removeProps,
    spawners: edits.spawners,
    removeSpawners: edits.removeSpawners,
    secrets: edits.secrets,
    removeSecrets: edits.removeSecrets,
    buildings: edits.buildings,
  };
}

async function save() {
  setStatus('saving…');
  const res = await fetch('/editor/save', { method: 'POST', body: JSON.stringify(payload()) });
  if (res.status === 401) { location.href = '/editor-login.html'; return; }
  const out = await res.json();
  dirty = !res.ok;
  setStatus(res.ok
    ? `Saved & live: +${out.counts.tiles} tiles, +${out.counts.props} props, ` +
      `+${out.counts.spawners} spawners, +${out.counts.secrets} secrets, ` +
      `+${out.counts.buildings} buildings, ${out.counts.removed} removals.<br>${out.note}`
    : 'Save failed: ' + (out.error || res.status));
}

async function publish() {
  if (dirty && !confirm('You have unsaved changes — publish the last SAVED state?')) return;
  const message = prompt('Commit message for GitHub:', 'World builder: publish world edits');
  if (message === null) return;
  setStatus('publishing to GitHub…');
  const res = await fetch('/editor/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (res.status === 401) { location.href = '/editor-login.html'; return; }
  const out = await res.json();
  setStatus(res.ok && out.ok
    ? `Published: <a href="${out.url}" target="_blank" style="color:#d8b35e">${(out.commit || '').slice(0, 10)}</a>`
    : 'Publish failed: ' + (out.error || res.status));
}

// ---- mouse ---------------------------------------------------------------------

let panning = false;
let painting = false;
let strokeCells = [];
let last = { x: 0, y: 0 };
let spaceHeld = false;

cv.addEventListener('mousedown', (ev) => {
  last = { x: ev.clientX, y: ev.clientY };
  const usePan = tool === 'pan' || ev.button === 1 || ev.button === 2 || spaceHeld;
  if (usePan) {
    panning = true;
    cv.style.cursor = 'grabbing';
    return;
  }
  const w = screenToWorld(ev.clientX, ev.clientY);
  const wx = Math.floor(w.x);
  const wy = Math.floor(w.y);
  if (tool === 'paint') {
    painting = true;
    strokeCells = [];
    paintAt(wx, wy);
    draw();
  } else if (tool === 'erase') eraseAt(wx, wy);
  else placeAt(wx, wy);
});

window.addEventListener('mousemove', (ev) => {
  const w = screenToWorld(ev.clientX, ev.clientY);
  const wx = Math.floor(w.x);
  const wy = Math.floor(w.y);
  if (world && wx >= 0 && wy >= 0 && wx < world.w && wy < world.h) {
    coordsEl.textContent = `${wx}, ${wy} · ${tileNames[world.tiles[wy * world.w + wx]] || '?'} · ×${view.scale.toFixed(1)}`;
    if (wx !== cursor.x || wy !== cursor.y) {
      cursor = { x: wx, y: wy };
      if (!panning && !painting) draw();
    }
  }
  if (panning) {
    view.x -= (ev.clientX - last.x) / view.scale;
    view.y -= (ev.clientY - last.y) / view.scale;
    last = { x: ev.clientX, y: ev.clientY };
    draw();
  } else if (painting) {
    paintAt(wx, wy);
    draw();
  }
});

window.addEventListener('mouseup', () => {
  if (painting && strokeCells.length) {
    undoStack.push({ kind: 'tiles', cells: strokeCells });
    strokeCells = [];
    setStatus('stroke done — remember to Save');
  }
  painting = false;
  if (panning) {
    panning = false;
    cv.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  }
});

cv.addEventListener('contextmenu', (ev) => ev.preventDefault());

cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = screenToWorld(ev.clientX, ev.clientY);
  view.scale = Math.max(0.18, Math.min(64, view.scale * (ev.deltaY < 0 ? 1.25 : 0.8)));
  const after = screenToWorld(ev.clientX, ev.clientY);
  view.x += before.x - after.x; // zoom toward the cursor
  view.y += before.y - after.y;
  draw();
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === ' ') spaceHeld = true;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
  }
  if (ev.key === 'Escape' && portalFrom) {
    portalFrom = null;
    setStatus('portal cancelled');
    draw();
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') spaceHeld = false;
});
window.addEventListener('beforeunload', (ev) => {
  if (dirty) ev.preventDefault();
});

resize();
Assets.load().catch(() => setStatus('sprite atlases failed to load — colour view only'))
  .then(load);
