#!/usr/bin/env python3
"""Build the client sprite assets from freely licensed sources.

Downloads source sheets (cached in tools/asset-src/), slices and composites
them into the atlases under client/assets/, and writes manifest.json.

The game runs fine without ever running this script -- the generated assets
are committed. Re-run it when adding creatures or changing the slicing.

    python3 tools/build-assets.py

Requires: pillow, numpy.

Sources (see client/assets/CREDITS.md):
  - Terrain/buildings: "Isometric 64x64" tilesets by Yar (CC-BY 3.0)
  - Creatures/avatar:  Flare project art by Clint Bellanger (CC-BY-SA 3.0)
  - Dragon: "Whispers of Avalon: Dragon NPC" by Leonard Pabin (CC-BY 3.0)
"""

import json
import os
import re
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'asset-src')
OUT = os.path.join(ROOT, 'client', 'assets')

FLARE = 'https://raw.githubusercontent.com/flareteam/flare-game/master/mods'
OGA = 'https://opengameart.org/sites/default/files'

SOURCES = {
    'outside.png': f'{OGA}/iso-64x64-outside.png',
    'building.png': f'{OGA}/iso-64x64-building_2.png',
    'dragon.png': f'{OGA}/Dragon_NPC_2_0.png',
    'minotaur.png': f'{OGA}/minotaur_alpha.png',
    'skeleton.png': f'{FLARE}/fantasycore/images/enemies/skeleton.png',
    'skeleton.txt': f'{FLARE}/fantasycore/animations/enemies/skeleton.txt',
    'goblin.png': f'{FLARE}/fantasycore/images/enemies/goblin.png',
    'goblin.txt': f'{FLARE}/fantasycore/animations/enemies/goblin.txt',
    'hobgoblin.png': f'{FLARE}/empyrean_campaign/images/enemies/hobgoblin.png',
    'hobgoblin.txt': f'{FLARE}/empyrean_campaign/animations/enemies/hobgoblin.txt',
    'cloth_shirt.png': f'{FLARE}/fantasycore/images/avatar/male/cloth_shirt.png',
    'cloth_shirt.txt': f'{FLARE}/fantasycore/animations/avatar/male/cloth_shirt.txt',
    'cloth_pants.png': f'{FLARE}/fantasycore/images/avatar/male/cloth_pants.png',
    'cloth_pants.txt': f'{FLARE}/fantasycore/animations/avatar/male/cloth_pants.txt',
    'head_short.png': f'{FLARE}/fantasycore/images/avatar/male/head_short.png',
    'head_short.txt': f'{FLARE}/fantasycore/animations/avatar/male/head_short.txt',
    'mage_hood.png': f'{FLARE}/fantasycore/images/avatar/male/mage_hood.png',
    'mage_hood.txt': f'{FLARE}/fantasycore/animations/avatar/male/mage_hood.txt',
}

# Flare's calcDirection: dir = (round(theta / 45deg) + 5) % 8, theta in tile
# space. We store atlas rows in heading order h = octant(atan2(dy,dx)), so
# row h holds flare direction (h + 5) % 8.
def flare_dir_for_heading(h):
    return (h + 5) % 8


def fetch_all():
    os.makedirs(SRC, exist_ok=True)
    for name, url in SOURCES.items():
        path = os.path.join(SRC, name)
        if os.path.exists(path):
            continue
        print('fetch', url)
        urllib.request.urlretrieve(url, path)


def parse_flare_stance(path):
    """Parse [stance] frames: frame=index,direction,x,y,w,h,ox,oy."""
    frames = {}
    section = None
    for line in open(path):
        line = line.strip()
        m = re.match(r'\[(\w+)\]', line)
        if m:
            section = m.group(1)
            continue
        if section == 'stance' and line.startswith('frame='):
            v = [int(x) for x in line[len('frame='):].split(',')]
            idx, d, x, y, w, h, ox, oy = v
            frames[(idx, d)] = (x, y, w, h, ox, oy)
    n = 1 + max(i for i, _ in frames)
    return frames, n


def hue_shift(img, shift, sel=None):
    """Rotate hue by `shift` (0..1). sel=(lo,hi,minsat) limits to a hue band."""
    rgba = np.asarray(img.convert('RGBA')).astype(np.float32) / 255.0
    r, g, b, a = [rgba[..., i] for i in range(4)]
    mx = np.max(rgba[..., :3], axis=-1)
    mn = np.min(rgba[..., :3], axis=-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm, gm, bm = (mx == r) & nz, (mx == g) & nz & (mx != r), (mx == b) & nz & (mx != r) & (mx != g)
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    h /= 6
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    v = mx
    if sel:
        lo, hi, minsat = sel
        mask = (h >= lo) & (h <= hi) & (s >= minsat)
    else:
        mask = np.ones_like(h, dtype=bool)
    h = np.where(mask, (h + shift) % 1.0, h)
    # hsv -> rgb
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    out = np.zeros_like(rgba[..., :3])
    for idx, (rr, gg, bb) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == idx
        out[..., 0][m] = rr[m]
        out[..., 1][m] = gg[m]
        out[..., 2][m] = bb[m]
    res = np.dstack([out, a])
    return Image.fromarray((res * 255).astype(np.uint8), 'RGBA')


def colorize_red(img):
    """Recolor saturated pixels toward dragon-red, preserving shading."""
    rgba = np.asarray(img.convert('RGBA')).astype(np.float32) / 255.0
    r, g, b, a = [rgba[..., i] for i in range(4)]
    mx = np.max(rgba[..., :3], axis=-1)
    mn = np.min(rgba[..., :3], axis=-1)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    v = mx
    mask = s > 0.10
    ns = np.clip(s * 1.6, 0.55, 0.9)
    nr = v
    ng = v * (1 - ns * 0.82)
    nb = v * (1 - ns)
    out = np.dstack([np.where(mask, nr, r), np.where(mask, ng, g), np.where(mask, nb, b), a])
    return Image.fromarray((out * 255).astype(np.uint8), 'RGBA')


def crop_frame(sheet, rect):
    x, y, w, h, ox, oy = rect
    return sheet.crop((x, y, x + w, y + h)), ox, oy


def build_creature(name, layers, n_frames, hue=None, scale=1.0, frame_ms=200):
    """layers: list of (sheet Image, stance frames dict). Composites each
    stance frame from all layers, normalizes onto a uniform cell grid with a
    shared anchor, rows ordered by heading."""
    # Compute cell extents over every used frame/layer relative to the anchor.
    left = top = right = bottom = 0
    for img, frames in layers:
        for (idx, d), (x, y, w, h, ox, oy) in frames.items():
            if idx >= n_frames:
                continue
            left = max(left, ox)
            top = max(top, oy)
            right = max(right, w - ox)
            bottom = max(bottom, h - oy)
    cw, ch = left + right, top + bottom
    atlas = Image.new('RGBA', (cw * n_frames, ch * 8), (0, 0, 0, 0))
    for h_ in range(8):
        d = flare_dir_for_heading(h_)
        for idx in range(n_frames):
            cell = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            for img, frames in layers:
                if (idx, d) not in frames:
                    continue
                f, ox, oy = crop_frame(img, frames[(idx, d)])
                cell.alpha_composite(f, (left - ox, top - oy))
            atlas.alpha_composite(cell, (cw * idx, ch * h_))
    if hue:
        atlas = hue_shift(atlas, *hue)
    if scale != 1.0:
        atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
        cw, ch, left, top = (int(v * scale) for v in (cw, ch, left, top))
    atlas.save(os.path.join(OUT, 'creatures', f'{name}.png'))
    return {
        'img': name, 'cellW': cw, 'cellH': ch, 'ax': left, 'ay': top,
        'frames': n_frames, 'dirs': 8, 'frameMs': frame_ms,
    }


def build_minotaur(scale=1.0):
    """Old grid-format sheet: 128x128 cells, rows = flare dirs, stance = cols 0-3."""
    sheet = Image.open(os.path.join(SRC, 'minotaur.png')).convert('RGBA')
    cs = 128
    n = 4
    atlas = Image.new('RGBA', (cs * n, cs * 8), (0, 0, 0, 0))
    for h_ in range(8):
        d = flare_dir_for_heading(h_)
        for idx in range(n):
            f = sheet.crop((idx * cs, d * cs, (idx + 1) * cs, (d + 1) * cs))
            atlas.alpha_composite(f, (idx * cs, h_ * cs))
    if scale != 1.0:
        atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
    c = int(cs * scale)
    atlas.save(os.path.join(OUT, 'creatures', 'ettin.png'))
    # Anchor: feet are around (64, 100) in the 128 cell.
    return {'img': 'ettin', 'cellW': c, 'cellH': c, 'ax': int(64 * scale), 'ay': int(100 * scale),
            'frames': n, 'dirs': 8, 'frameMs': 240}


def build_dragon(scale=0.5):
    """Vertical strip of wing-flap frames, split on transparent rows."""
    sheet = Image.open(os.path.join(SRC, 'dragon.png')).convert('RGBA')
    alpha = np.asarray(sheet)[..., 3]
    rows = alpha.max(axis=1) > 8
    regions = []
    start = None
    for y, r in enumerate(list(rows) + [False]):
        if r and start is None:
            start = y
        elif not r and start is not None:
            if y - start > 90:  # skip the credit footer
                regions.append((start, y))
            start = None
    frames = []
    for (y0, y1) in regions[:5]:
        f = sheet.crop((0, y0, sheet.width, y1))
        bbox = f.getbbox()
        frames.append(f.crop(bbox))
    # Wing flap cycle: use up, mid, down, mid.
    frames = [frames[i] for i in (0, 1, 2, 1)] if len(frames) >= 3 else frames
    cw = max(f.width for f in frames)
    ch = max(f.height for f in frames)
    atlas = Image.new('RGBA', (cw * len(frames), ch), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        atlas.alpha_composite(f, (i * cw + (cw - f.width) // 2, ch - f.height))
    atlas = colorize_red(atlas)
    atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
    cw, ch = int(cw * scale), int(ch * scale)
    atlas.save(os.path.join(OUT, 'creatures', 'dragon.png'))
    return {'img': 'dragon', 'cellW': cw, 'cellH': ch, 'ax': cw // 2, 'ay': int(ch * 0.78),
            'frames': len(frames), 'dirs': 1, 'frameMs': 280}


# ---- terrain manifest ---------------------------------------------------------

def ground(col, row, img='terrain'):
    """A 64x32 ground diamond living in the bottom half of a 64x64 cell."""
    return {'img': img, 'x': col * 64, 'y': row * 64 + 32, 'w': 64, 'h': 32, 'ax': 0, 'ay': 0}


def trim_object(sheet, box, name, frames, img):
    """Crop `box`, trim to alpha bbox, anchor at bottom-center (the tile's
    bottom diamond corner sits 16px above the anchor in screen space)."""
    region = sheet.crop(box)
    bbox = region.getbbox()
    if not bbox:
        raise ValueError(f'empty object region for {name}: {box}')
    x0, y0 = box[0] + bbox[0], box[1] + bbox[1]
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    frames[name] = {'img': img, 'x': x0, 'y': y0, 'w': w, 'h': h, 'ax': w // 2, 'ay': h - 16}


def main():
    fetch_all()
    os.makedirs(os.path.join(OUT, 'creatures'), exist_ok=True)

    terrain = Image.open(os.path.join(SRC, 'outside.png')).convert('RGBA')
    building = Image.open(os.path.join(SRC, 'building.png')).convert('RGBA')
    terrain.save(os.path.join(OUT, 'terrain.png'))
    building.save(os.path.join(OUT, 'building.png'))

    frames = {}
    # Ground diamonds.
    for i in range(7):
        frames[f'grass.{i}'] = ground(i, 0)
    for i, (c, r) in enumerate([(4, 8), (5, 8)]):
        frames[f'water.{i}'] = ground(c, r)
    for i, c in enumerate([2, 3, 4]):
        frames[f'floor.{i}'] = ground(c, 0, 'building')
    frames['planks'] = ground(0, 5, 'building')

    # Objects: rocks, foliage, walls. Boxes are generous; trimmed to alpha.
    trim_object(terrain, (0, 320, 64, 384), 'rocks.0', frames, 'terrain')
    trim_object(terrain, (64, 320, 128, 384), 'rocks.1', frames, 'terrain')
    trim_object(terrain, (128, 320, 192, 384), 'rocks.2', frames, 'terrain')
    trim_object(terrain, (0, 704, 64, 768), 'tallgrass.0', frames, 'terrain')
    trim_object(terrain, (64, 704, 128, 768), 'tallgrass.1', frames, 'terrain')
    trim_object(terrain, (0, 768, 64, 832), 'bush.0', frames, 'terrain')
    trim_object(terrain, (64, 768, 128, 832), 'bush.1', frames, 'terrain')
    trim_object(terrain, (128, 768, 192, 896), 'tree.fir0', frames, 'terrain')
    trim_object(terrain, (192, 768, 256, 896), 'tree.fir1', frames, 'terrain')
    for i in range(4):
        trim_object(terrain, (i * 64, 896, (i + 1) * 64, 1024), f'tree.pine{i}', frames, 'terrain')
    trim_object(terrain, (256, 832, 448, 1024), 'tree.dead', frames, 'terrain')
    trim_object(terrain, (448, 832, 640, 1024), 'tree.oak', frames, 'terrain')
    trim_object(building, (0, 0, 64, 64), 'wall.0', frames, 'building')
    trim_object(building, (64, 0, 128, 64), 'wall.1', frames, 'building')

    # Tile id -> render recipe. Lists are hash-picked variants per tile.
    tiles = {
        '0': {'ground': ['water.0', 'water.1'], 'effect': 'water'},
        '1': {'ground': ['grass.0', 'grass.1', 'grass.2', 'grass.3', 'grass.4', 'grass.5', 'grass.6'],
              'decor': {'chance': 0.07, 'objects': ['tallgrass.0', 'tallgrass.1', 'bush.0', 'bush.1']}},
        # objectSets: the client picks one set per coarse map region, so
        # whole forests read as oakwood, pinewood or deadwood biomes.
        '2': {'ground': ['grass.1', 'grass.3', 'grass.5'],
              'object': ['tree.oak', 'tree.oak', 'tree.pine0', 'tree.pine1', 'tree.pine2',
                         'tree.fir0', 'tree.fir1', 'tree.dead'],
              'objectSets': [
                  ['tree.oak', 'tree.oak', 'tree.oak', 'tree.fir1', 'tree.dead'],
                  ['tree.pine0', 'tree.pine1', 'tree.pine2', 'tree.pine3', 'tree.fir0', 'tree.fir1'],
                  ['tree.dead', 'tree.dead', 'tree.pine3', 'tree.fir1'],
              ]},
        '3': {'groundProc': 'dirt', 'object': ['rocks.0', 'rocks.1', 'rocks.2']},
        '4': {'groundProc': 'dirt'},
        '5': {'ground': ['floor.0', 'floor.1', 'floor.2']},
        '6': {'ground': ['floor.0'], 'object': ['wall.0', 'wall.0', 'wall.0', 'wall.1']},
        '7': {'groundProc': 'sand'},
        '8': {'ground': ['floor.1'], 'effect': 'shrine'},
    }

    # Creatures.
    def packed(name):
        img = Image.open(os.path.join(SRC, f'{name}.png')).convert('RGBA')
        fr, n = parse_flare_stance(os.path.join(SRC, f'{name}.txt'))
        return img, fr, n

    # Scales keep creatures in proportion with the 64x32 tiles: a human is
    # about a tile-and-a-half tall, like classic UO.
    creatures = {}
    img, fr, n = packed('goblin')
    creatures['goblin'] = build_creature('goblin', [(img, fr)], n, scale=0.78)
    img, fr, n = packed('skeleton')
    creatures['skeleton'] = build_creature('skeleton', [(img, fr)], n, scale=0.6)
    img, fr, n = packed('hobgoblin')
    creatures['orc'] = build_creature('orc', [(img, fr)], n, scale=0.95)
    creatures['ettin'] = build_minotaur(scale=1.0)
    creatures['dragon'] = build_dragon(scale=0.5)

    pants = packed('cloth_pants')
    shirt = packed('cloth_shirt')
    head = packed('head_short')
    hood = packed('mage_hood')
    n = min(pants[2], shirt[2], head[2])
    creatures['player'] = build_creature(
        'player', [(pants[0], pants[1]), (shirt[0], shirt[1]), (head[0], head[1])], n,
        scale=0.66, frame_ms=260)
    n = min(pants[2], shirt[2], hood[2])
    creatures['vendor'] = build_creature(
        'vendor', [(pants[0], pants[1]), (shirt[0], shirt[1]), (hood[0], hood[1])], n,
        scale=0.66, frame_ms=320)

    manifest = {
        'tileW': 64, 'tileH': 32,
        'images': {
            'terrain': 'terrain.png',
            'building': 'building.png',
            **{c['img']: f"creatures/{c['img']}.png" for c in creatures.values()},
        },
        'frames': frames,
        'tiles': tiles,
        'creatures': creatures,
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print('wrote', os.path.join(OUT, 'manifest.json'))


if __name__ == '__main__':
    main()
