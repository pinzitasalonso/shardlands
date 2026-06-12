'use strict';

// Internal visual map editor. Top-down view of the whole 2048x2048 world,
// pan/zoom, paint tiles, drop props/spawners/secrets, erase. Everything you
// change is an *edit overlay* (world/edits.json) stamped on top of worldgen
// at boot — regenerating the world never eats hand-made work.
//
// Keeper-only: the API refuses non-loopback callers unless EDITOR=1.

const TILE_NAMES = ['water', 'grass', 'tree', 'rock', 'road', 'floor', 'wall',
  'sand', 'shrine', 'snow', 'snowtree', 'planks', 'swamp', 'swamptree', 'cave'];
// same palette the in-game minimap uses, so the editor reads like the map
const TILE_COLORS = [
  [38, 70, 110], [86, 125, 70], [40, 80, 42], [120, 116, 108], [150, 124, 86],
  [170, 150, 110], [90, 86, 80], [196, 178, 128], [240, 220, 130], [225, 228, 235],
  [180, 195, 205], [140, 105, 65], [70, 90, 60], [50, 70, 48], [28, 24, 32],
];
const PROPS = ['prop.well', 'prop.table', 'prop.stool', 'fx.campfire'];

const cv = document.getElementById('map');
const ctx = cv.getContext('2d');
const coordsEl = document.getElementById('coords');
const statusEl = document.getElementById('status');

const view = { x: 1024, y: 1024, scale: 0.4 }; // world tile at canvas centre
let world = null;   // { w, h, tiles: Uint8Array, props, spawners, secrets, vendors, ... }
let base = null;    // offscreen canvas, 1px per tile
let tool = 'pan';
let paintTile = 4;  // road
let dirty = false;

// The edit overlay being built. Tiles use a Map for dedupe ("x,y" -> tile).
const edits = {
  tiles: new Map(),
  props: [], removeProps: [],
  spawners: [], removeSpawners: [],
  secrets: [],
};
const undoStack = []; // { kind: 'tiles', cells: [[x,y,prevEditOrNull]] } | entity ops

function setStatus(text) {
  statusEl.innerHTML = (dirty ? '<span id="dirty">● unsaved changes</span><br>' : '') + text;
}

// ---- loading -------------------------------------------------------------------

async function load() {
  const [metaRes, tilesRes] = await Promise.all([fetch('/editor/meta'), fetch('/editor/tiles')]);
  if (!metaRes.ok) {
    setStatus((await metaRes.json()).error || 'editor API refused');
    return;
  }
  const meta = await metaRes.json();
  world = { ...meta, tiles: new Uint8Array(await tilesRes.arrayBuffer()) };

  // resume the saved overlay so editing is cumulative
  if (meta.edits) {
    for (const [x, y, v] of meta.edits.tiles || []) edits.tiles.set(x + ',' + y, v);
    edits.props = meta.edits.props || [];
    edits.removeProps = meta.edits.removeProps || [];
    edits.spawners = meta.edits.spawners || [];
    edits.removeSpawners = meta.edits.removeSpawners || [];
    edits.secrets = meta.edits.secrets || [];
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
  setStatus(`World loaded: ${world.w}×${world.h}, ${world.props.length} props, ` +
    `${world.spawners.length} spawners, ${world.secrets.length} secrets.`);
  draw();
}

function paintBasePixel(x, y, t) {
  const g = base.getContext('2d');
  const c = TILE_COLORS[t];
  g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  g.fillRect(x, y, 1, 1);
}

// ---- sidebar -------------------------------------------------------------------

function buildSidebar() {
  const pal = document.getElementById('palette');
  TILE_NAMES.forEach((name, i) => {
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
  const propSel = document.getElementById('prop-kind');
  for (const p of PROPS) propSel.add(new Option(p.replace(/^.*\./, ''), p));
  const mobSel = document.getElementById('mob-kind');
  for (const k of world.mobKinds) mobSel.add(new Option(k, k));
  const go = document.getElementById('goto');
  go.add(new Option('— jump to —', ''));
  for (const c of world.cities || []) go.add(new Option('🏰 ' + c.name, c.x + ',' + c.y));
  for (const v of world.villages || []) go.add(new Option('🏠 ' + v.name, v.x + ',' + v.y));
  go.onchange = () => {
    if (!go.value) return;
    const [x, y] = go.value.split(',').map(Number);
    view.x = x;
    view.y = y;
    view.scale = Math.max(view.scale, 6);
    draw();
  };
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.onclick = () => pickTool(b.dataset.tool);
  }
  document.getElementById('undo').onclick = undo;
  document.getElementById('save').onclick = save;
}

function pickTool(t) {
  tool = t;
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

function draw() {
  if (!base) return;
  const s = view.scale * devicePixelRatio;
  ctx.imageSmoothingEnabled = view.scale < 4; // crisp pixels when zoomed in
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const o = worldToScreen(0, 0);
  ctx.drawImage(base, o.x, o.y, world.w * s, world.h * s);

  // tile grid when close enough to care about single tiles
  if (view.scale >= 10) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(cv.clientWidth, cv.clientHeight);
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(tl.x)); x <= Math.min(world.w, br.x); x++) {
      const p = worldToScreen(x, 0);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, cv.height);
    }
    for (let y = Math.max(0, Math.floor(tl.y)); y <= Math.min(world.h, br.y); y++) {
      const p = worldToScreen(0, y);
      ctx.moveTo(0, p.y);
      ctx.lineTo(cv.width, p.y);
    }
    ctx.stroke();
  }

  // entity markers from medium zoom; hand edits drawn bright, world dim
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
    const removed = (list, x, y) => list.some(([rx, ry]) => rx === x && ry === y);
    for (const p of world.props) {
      if (!removed(edits.removeProps, p.x, p.y)) mark(p.x, p.y, '#ffb347', '▲', false);
    }
    for (const s of world.spawners) {
      if (!removed(edits.removeSpawners, s.x, s.y)) mark(s.x, s.y, '#ff6a5a', '●', false);
    }
    for (const s of world.secrets) mark(s.x, s.y, '#c08aff', '◆', false);
    for (const v of world.vendors) mark(v.x, v.y, '#7ad07a', '■', false);
    for (const p of edits.props) mark(p.x, p.y, '#ffb347', '▲', true);
    for (const s of edits.spawners) mark(s.x, s.y, '#ff6a5a', '●', true);
    for (const s of edits.secrets) mark(s.x, s.y, '#c08aff', '◆', true);
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
    // one undo entry per stroke segment; merged per mouse-drag below
    strokeCells.push(...cells);
    dirty = true;
    setStatus('painting…');
  }
}

function placeAt(wx, wy) {
  if (tool === 'prop') {
    const name = document.getElementById('prop-kind').value;
    edits.props.push({ x: wx, y: wy, name });
    undoStack.push({ kind: 'prop' });
  } else if (tool === 'spawner') {
    edits.spawners.push({
      kind: document.getElementById('mob-kind').value,
      count: +document.getElementById('mob-count').value || 4,
      x: wx, y: wy,
      r: +document.getElementById('mob-r').value || 8,
    });
    undoStack.push({ kind: 'spawner' });
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
  for (const [listName, undoKind] of [['props', 'prop'], ['spawners', 'spawner'], ['secrets', 'secret']]) {
    const i = edits[listName].findIndex(near);
    if (i >= 0) {
      const [gone] = edits[listName].splice(i, 1);
      undoStack.push({ kind: 'unerase-edit', listName, gone });
      dirty = true;
      setStatus(`removed your ${undoKind} at ${gone.x}, ${gone.y}`);
      return draw();
    }
  }
  // then generated entities — recorded as removals in the overlay
  for (const [srcName, rmName] of [['props', 'removeProps'], ['spawners', 'removeSpawners']]) {
    const hit = world[srcName].find((e) => near(e) &&
      !edits[rmName].some(([x, y]) => x === e.x && y === e.y));
    if (hit) {
      edits[rmName].push([hit.x, hit.y]);
      undoStack.push({ kind: 'unerase-world', rmName });
      dirty = true;
      setStatus(`marked generated ${srcName.slice(0, -1)} at ${hit.x}, ${hit.y} for removal`);
      return draw();
    }
  }
  setStatus('nothing here to erase (secrets from worldgen cannot be removed)');
}

function undo() {
  const op = undoStack.pop();
  if (!op) return setStatus('nothing to undo');
  if (op.kind === 'tiles') {
    for (const [x, y, prevEdit, prevWorld] of op.cells) {
      if (prevEdit === null) edits.tiles.delete(x + ',' + y);
      else edits.tiles.set(x + ',' + y, prevEdit);
      world.tiles[y * world.w + x] = prevWorld;
      paintBasePixel(x, y, prevWorld);
    }
  } else if (op.kind === 'prop') edits.props.pop();
  else if (op.kind === 'spawner') edits.spawners.pop();
  else if (op.kind === 'secret') edits.secrets.pop();
  else if (op.kind === 'unerase-edit') edits[op.listName].push(op.gone);
  else if (op.kind === 'unerase-world') edits[op.rmName].pop();
  dirty = true;
  setStatus('undone');
  draw();
}

async function save() {
  const payload = {
    tiles: [...edits.tiles.entries()].map(([k, v]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, v];
    }),
    props: edits.props,
    removeProps: edits.removeProps,
    spawners: edits.spawners,
    removeSpawners: edits.removeSpawners,
    secrets: edits.secrets,
  };
  setStatus('saving…');
  const res = await fetch('/editor/save', { method: 'POST', body: JSON.stringify(payload) });
  const out = await res.json();
  dirty = !res.ok;
  setStatus(res.ok
    ? `Saved: ${payload.tiles.length} tiles, ${payload.props.length} props, ` +
      `${payload.spawners.length} spawners, ${payload.secrets.length} secrets, ` +
      `${payload.removeProps.length + payload.removeSpawners.length} removals.<br>${out.note}`
    : 'Save failed: ' + (out.error || res.status));
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
    coordsEl.textContent = `${wx}, ${wy} · ${TILE_NAMES[world.tiles[wy * world.w + wx]]} · ×${view.scale.toFixed(1)}`;
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
  view.scale = Math.max(0.18, Math.min(32, view.scale * (ev.deltaY < 0 ? 1.25 : 0.8)));
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
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') spaceHeld = false;
});
window.addEventListener('beforeunload', (ev) => {
  if (dirty) ev.preventDefault();
});

resize();
load();
