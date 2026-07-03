#!/usr/bin/env python3
"""Build the client sprite assets from freely licensed sources.

Downloads source sheets (cached in tools/asset-src/), slices and composites
them into the atlases under client/assets/, and writes manifest.json.

The game runs fine without ever running this script -- the generated assets
are committed. Re-run it when adding creatures or changing the slicing.

    python3 tools/build-assets.py            # full build, then applies art/overrides/
    python3 tools/build-assets.py --export   # dump editable copies + grid guides to art/

Hand-editing art (Photoshop, Figma, Aseprite, ...): run with --export, edit
the PNGs under art/editable/ (the matching *.guide.png shows the frame grid),
save your version under art/overrides/ at the same relative path, and run the
build again. See art/README.md for the full workflow.

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
ART = os.path.join(ROOT, 'art')

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
    'leather_boots.png': f'{FLARE}/fantasycore/images/avatar/male/leather_boots.png',
    'leather_boots.txt': f'{FLARE}/fantasycore/animations/avatar/male/leather_boots.txt',
    'default_chest.png': f'{FLARE}/fantasycore/images/avatar/male/default_chest.png',
    'default_chest.txt': f'{FLARE}/fantasycore/animations/avatar/male/default_chest.txt',
    'default_hands.png': f'{FLARE}/fantasycore/images/avatar/male/default_hands.png',
    'default_hands.txt': f'{FLARE}/fantasycore/animations/avatar/male/default_hands.txt',
    'head_bald.png': f'{FLARE}/fantasycore/images/avatar/male/head_bald.png',
    'head_bald.txt': f'{FLARE}/fantasycore/animations/avatar/male/head_bald.txt',
    'leather_chest.png': f'{FLARE}/fantasycore/images/avatar/male/leather_chest.png',
    'leather_chest.txt': f'{FLARE}/fantasycore/animations/avatar/male/leather_chest.txt',
    'leather_pants.png': f'{FLARE}/fantasycore/images/avatar/male/leather_pants.png',
    'leather_pants.txt': f'{FLARE}/fantasycore/animations/avatar/male/leather_pants.txt',
    'leather_hood.png': f'{FLARE}/fantasycore/images/avatar/male/leather_hood.png',
    'leather_hood.txt': f'{FLARE}/fantasycore/animations/avatar/male/leather_hood.txt',
    'w_dagger.png': f'{FLARE}/fantasycore/images/avatar/male/dagger.png',
    'w_dagger.txt': f'{FLARE}/fantasycore/animations/avatar/male/dagger.txt',
    'w_longsword.png': f'{FLARE}/fantasycore/images/avatar/male/longsword.png',
    'w_longsword.txt': f'{FLARE}/fantasycore/animations/avatar/male/longsword.txt',
    'w_mace.png': f'{FLARE}/fantasycore/images/avatar/male/mace.png',
    'w_mace.txt': f'{FLARE}/fantasycore/animations/avatar/male/mace.txt',
    'w_battle_axe.png': f'{FLARE}/fantasycore/images/avatar/male/battle_axe.png',
    'w_battle_axe.txt': f'{FLARE}/fantasycore/animations/avatar/male/battle_axe.txt',
    'w_greatsword.png': f'{FLARE}/fantasycore/images/avatar/male/greatsword.png',
    'w_greatsword.txt': f'{FLARE}/fantasycore/animations/avatar/male/greatsword.txt',
    'w_longbow.png': f'{FLARE}/fantasycore/images/avatar/male/longbow.png',
    'w_longbow.txt': f'{FLARE}/fantasycore/animations/avatar/male/longbow.txt',
    'a_leather.png': f'{FLARE}/fantasycore/images/avatar/male/leather_chest.png',
    'a_leather.txt': f'{FLARE}/fantasycore/animations/avatar/male/leather_chest.txt',
    'a_chain.png': f'{FLARE}/fantasycore/images/avatar/male/chain_cuirass.png',
    'a_chain.txt': f'{FLARE}/fantasycore/animations/avatar/male/chain_cuirass.txt',
    'a_buckler.png': f'{FLARE}/fantasycore/images/avatar/male/buckler.png',
    'a_buckler.txt': f'{FLARE}/fantasycore/animations/avatar/male/buckler.txt',
    'a_kite_shield.png': f'{FLARE}/fantasycore/images/avatar/male/kite_shield.png',
    'a_kite_shield.txt': f'{FLARE}/fantasycore/animations/avatar/male/kite_shield.txt',
    'skeleton_mage.png': f'{FLARE}/fantasycore/images/enemies/skeleton_mage.png',
    'skeleton_mage.txt': f'{FLARE}/fantasycore/animations/enemies/skeleton_mage.txt',
    # Animals: Stendhal (GPL 2) and LPC farm animals by Daniel Eddeland
    # (CC-BY-SA 3.0 / GPL 3). 4-direction walk sheets, rows = up/right/down/left.
    'wolf.png': 'https://raw.githubusercontent.com/arianne/stendhal/master/data/sprites/monsters/animal/wolf.png',
    'deer.png': 'https://raw.githubusercontent.com/arianne/stendhal/master/data/sprites/monsters/animal/deer.png',
    'sheep.png': f'{OGA}/sheep_walk.png',
    'pig.png': f'{OGA}/pig_walk.png',
    'chicken.png': f'{OGA}/chicken_walk.png',
    'boar.png': 'https://raw.githubusercontent.com/arianne/stendhal/master/data/sprites/monsters/animal/boar.png',
    'crab.png': 'https://raw.githubusercontent.com/arianne/stendhal/master/data/sprites/monsters/animal/crab.png',
    'snake.png': 'https://raw.githubusercontent.com/arianne/stendhal/master/data/sprites/monsters/reptile/snake.png',
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


ANIM_SECTIONS = ('stance', 'run', 'melee', 'swing')

def parse_flare_anims(path):
    """Parse animation sections: frame=index,direction,x,y,w,h,ox,oy.
    Returns {section: (frames dict, frame count)}."""
    anims = {}
    section = None
    for line in open(path):
        line = line.strip()
        m = re.match(r'\[(\w+)\]', line)
        if m:
            section = m.group(1)
            continue
        if section in ANIM_SECTIONS and line.startswith('frame='):
            v = [int(x) for x in line[len('frame='):].split(',')]
            idx, d, x, y, w, h, ox, oy = v
            anims.setdefault(section, {})[(idx, d)] = (x, y, w, h, ox, oy)
    out = {}
    for sec, frames in anims.items():
        out[sec] = (frames, 1 + max(i for i, _ in frames))
    # "swing" is the avatar's name for melee.
    if 'melee' not in out and 'swing' in out:
        out['melee'] = out.pop('swing')
    return out


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


# Animation playback speeds and loop styles, per band.
ANIM_STYLE = {
    'stance': {'ms': 180, 'loop': 'back_forth'},
    'run': {'ms': 90, 'loop': 'loop'},
    'melee': {'ms': 110, 'loop': 'loop'},
}

def build_creature(name, layers, hue=None, scale=1.0, stance_ms=None, overlays=None):
    """layers: list of (sheet Image, anims dict from parse_flare_anims).
    Composites stance/run/melee bands side by side into one atlas with a
    uniform cell grid and shared anchor; rows ordered by heading.

    overlays: optional {key: (sheet, anims)} of extra layers (e.g. weapons)
    rendered as separate, geometry-identical atlases so the client can draw
    them over the base at runtime."""
    overlays = overlays or {}
    all_layer_sets = [layers] + [[ov] for ov in overlays.values()]

    # Bands available in every layer of every set, in canonical order.
    bands = [b for b in ('stance', 'run', 'melee')
             if all(b in anims for ls in all_layer_sets for _, anims in ls)]
    counts = {b: min(anims[b][1] for ls in all_layer_sets for _, anims in ls) for b in bands}

    # Cell extents over every used frame of every band and layer (overlays
    # included), so base and overlay atlases share one grid and anchor.
    left = top = right = bottom = 0
    for ls in all_layer_sets:
        for img, anims in ls:
            for b in bands:
                frames = anims[b][0]
                for (idx, d), (x, y, w, h, ox, oy) in frames.items():
                    if idx >= counts[b]:
                        continue
                    left = max(left, ox)
                    top = max(top, oy)
                    right = max(right, w - ox)
                    bottom = max(bottom, h - oy)
    cw, ch = left + right, top + bottom
    total = sum(counts[b] for b in bands)

    def render(layer_set):
        atlas = Image.new('RGBA', (cw * total, ch * 8), (0, 0, 0, 0))
        col = 0
        for b in bands:
            for h_ in range(8):
                d = flare_dir_for_heading(h_)
                for idx in range(counts[b]):
                    cell = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
                    for img, anims in layer_set:
                        frames = anims[b][0]
                        if (idx, d) not in frames:
                            continue
                        f, ox, oy = crop_frame(img, frames[(idx, d)])
                        cell.alpha_composite(f, (left - ox, top - oy))
                    atlas.alpha_composite(cell, (cw * (col + idx), ch * h_))
            col += counts[b]
        if scale != 1.0:
            atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
        return atlas

    atlas = render(layers)
    if hue:
        atlas = hue_shift(atlas, *hue)
    atlas.save(os.path.join(OUT, 'creatures', f'{name}.png'))

    overlay_meta = {}
    if overlays:
        os.makedirs(os.path.join(OUT, 'creatures', 'weapons'), exist_ok=True)
        for key, ov in overlays.items():
            render([ov]).save(os.path.join(OUT, 'creatures', 'weapons', f'{key}.png'))
            overlay_meta[key] = 'w_' + key

    cw, ch, left, top = (int(v * scale) for v in (cw, ch, left, top))
    anims_meta = {}
    col = 0
    for b in bands:
        style = dict(ANIM_STYLE[b])
        if b == 'stance' and stance_ms:
            style['ms'] = stance_ms
        anims_meta[b] = {'start': col, 'frames': counts[b], **style}
        col += counts[b]
    meta = {
        'img': name, 'cellW': cw, 'cellH': ch, 'ax': left, 'ay': top,
        'dirs': 8, 'anims': anims_meta,
    }
    if overlay_meta:
        meta['overlays'] = overlay_meta
    return meta


def build_minotaur(scale=1.0):
    """Old grid-format sheet: 128x128 cells, rows = flare dirs.
    Columns: stance 0-3, run 4-11, melee 12-15."""
    sheet = Image.open(os.path.join(SRC, 'minotaur.png')).convert('RGBA')
    cs = 128
    bands = [('stance', 0, 4), ('run', 4, 8), ('melee', 12, 4)]
    total = sum(n for _, _, n in bands)
    atlas = Image.new('RGBA', (cs * total, cs * 8), (0, 0, 0, 0))
    col = 0
    anims_meta = {}
    for bname, src0, n in bands:
        for h_ in range(8):
            d = flare_dir_for_heading(h_)
            for idx in range(n):
                f = sheet.crop(((src0 + idx) * cs, d * cs, (src0 + idx + 1) * cs, (d + 1) * cs))
                atlas.alpha_composite(f, ((col + idx) * cs, h_ * cs))
        anims_meta[bname] = {'start': col, 'frames': n, **ANIM_STYLE[bname]}
        anims_meta[bname]['ms'] = 240 if bname == 'stance' else anims_meta[bname]['ms']
        col += n
    if scale != 1.0:
        atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
    c = int(cs * scale)
    atlas.save(os.path.join(OUT, 'creatures', 'ettin.png'))
    return {'img': 'ettin', 'cellW': c, 'cellH': c, 'ax': int(64 * scale), 'ay': int(100 * scale),
            'dirs': 8, 'anims': anims_meta}


# Map our 8 headings onto a 4-direction sheet (rows: up, right, down, left):
# SE/S -> down, SW/W -> left, NW/N -> up, NE/E -> right.
DIR4_ROW_FOR_HEADING = [2, 2, 3, 3, 0, 0, 1, 1]

def build_dir4_creature(name, cols, cell_w, cell_h, scale=1.0, stance_ms=400, run_ms=140):
    """Animals from classic 4-row walk sheets. Stance = the middle column,
    run = the full walk cycle, melee reuses stance."""
    sheet = Image.open(os.path.join(SRC, f'{name}.png')).convert('RGBA')
    stand_col = 1 if cols >= 3 else 0
    total = 1 + cols
    atlas = Image.new('RGBA', (cell_w * total, cell_h * 8), (0, 0, 0, 0))
    for h_ in range(8):
        row = DIR4_ROW_FOR_HEADING[h_]
        def frame(col):
            return sheet.crop((col * cell_w, row * cell_h, (col + 1) * cell_w, (row + 1) * cell_h))
        atlas.alpha_composite(frame(stand_col), (0, h_ * cell_h))
        for c in range(cols):
            atlas.alpha_composite(frame(c), ((1 + c) * cell_w, h_ * cell_h))
    # Anchor at the visible feet of the standing frame (south row).
    probe = sheet.crop((stand_col * cell_w, 2 * cell_h, (stand_col + 1) * cell_w, 3 * cell_h))
    bbox = probe.getbbox() or (0, 0, cell_w, cell_h)
    ay = bbox[3] - 2
    if scale != 1.0:
        atlas = atlas.resize((int(atlas.width * scale), int(atlas.height * scale)), Image.LANCZOS)
    cw = int(cell_w * scale)
    ch = int(cell_h * scale)
    atlas.save(os.path.join(OUT, 'creatures', f'{name}.png'))
    stance = {'start': 0, 'frames': 1, 'ms': stance_ms, 'loop': 'loop'}
    run = {'start': 1, 'frames': cols, 'ms': run_ms, 'loop': 'loop'}
    return {'img': name, 'cellW': cw, 'cellH': ch, 'ax': cw // 2, 'ay': int(ay * scale),
            'dirs': 8, 'anims': {'stance': stance, 'run': run, 'melee': stance}}


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
    flap = {'start': 0, 'frames': len(frames), 'ms': 280, 'loop': 'loop'}
    return {'img': 'dragon', 'cellW': cw, 'cellH': ch, 'ax': cw // 2, 'ay': int(ch * 0.78),
            'dirs': 1, 'anims': {'stance': flap, 'run': flap, 'melee': flap}}


# ---- terrain manifest ---------------------------------------------------------

def ground(col, row, img='terrain'):
    """A 64x32 ground diamond living in the bottom half of a 64x64 cell."""
    return {'img': img, 'x': col * 64, 'y': row * 64 + 32, 'w': 64, 'h': 32, 'ax': 0, 'ay': 0}


def trim_object(sheet, box, name, frames, img, scale=None):
    """Crop `box`, trim to alpha bbox, anchor at bottom-center (the tile's
    bottom diamond corner sits 16px above the anchor in screen space).
    scale, if set, shrinks the sprite at draw time."""
    region = sheet.crop(box)
    bbox = region.getbbox()
    if not bbox:
        raise ValueError(f'empty object region for {name}: {box}')
    x0, y0 = box[0] + bbox[0], box[1] + bbox[1]
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    frames[name] = {'img': img, 'x': x0, 'y': y0, 'w': w, 'h': h, 'ax': w // 2, 'ay': h - 16}
    if scale:
        frames[name]['scale'] = scale


# ---- top-down 16px tileset -------------------------------------------------------
#
# The renderer is top-down square (16px art drawn at 3x = 48px tiles). When
# the purchased KingRabbit sheets are present in tools/asset-src/heroic/
# (gitignored — the raw packs must never be committed; the composed atlases
# ship "as part of a game", which the HAS license explicitly allows with
# attribution), build_topdown() slices them. Without the sheets it draws
# the procedural placeholder set in the same atlas + manifest shape.

TD = 16  # native pixel size of a top-down tile
TD_SCALE = 3  # drawn at 3x on screen

HEROIC = os.path.join(SRC, 'heroic', 'KingRabbit')

TD_PALETTES = {
    'grass':  ['#6d7f38', '#76883e', '#7f9244', '#687a36', '#5c6e30'],
    'water':  ['#4a76b8', '#4470b2', '#5080c0', '#3f6aaa', '#6890cc'],
    'sand':   ['#c8b478', '#c0ac70', '#d0bc84', '#bca868', '#b09c60'],
    'snow':   ['#e9eef3', '#dfe6ee', '#f2f6f9', '#d6dfe9', '#c8d4e2'],
    'swamp':  ['#5a6b42', '#52613c', '#647549', '#4c5c3a', '#42522f'],
    'dirt':   ['#9a7a52', '#8f714b', '#a5845a', '#856844', '#796040'],
    'floor':  ['#a89878', '#a08f70', '#b0a080', '#988866', '#887a5c'],
    'planks': ['#8a6a42', '#82633d', '#936f47', '#7a5c38', '#6e5334'],
    'cave':   ['#42403c', '#3a3834', '#4a4842', '#34322e', '#2c2a26'],
    'wall':   ['#8c8880', '#84807a', '#94908a', '#7a766e', '#6a665e'],
}


def hexrgb(s):
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def build_topdown(frames, images_out):
    if os.path.isdir(HEROIC):
        return build_topdown_heroic(frames, images_out)
    print('heroic sheets not found — using the procedural placeholder tileset')
    return build_topdown_placeholder(frames, images_out)


# ---- the real thing: slicing recipes for KingRabbit's HAS packs -------------------
# All cell references are (col, row) into 16px-grid sheets.

HAS_SHEETS = {
    'GB': 'HAS Overworld 2.1/GrassBiome/GB-LandTileset.png',
    'IB': 'HAS Overworld 2.1/IceBiome/IB-LandTileset.png',
    'MB': 'HAS Overworld 2.1/MarshBiome/MB-LandTileset.png',
    'SB': 'HAS Overworld 2.1/SandBiome/SB-LandTileset.png',
    'DB': 'HAS Overworld 2.1/DirtBiome/DB-LandTileset.png',
    'OCEAN': 'HAS Overworld 2.1/Universal/Universal-Ocean-Static.png',
    'ROAD': 'HAS Overworld 2.1/Universal/Universal-Road-Tileset.png',
    'TREES': 'HAS Overworld 2.1/Universal/Universal-Trees-And-Mountains.png',
    'BLDG': 'HAS Overworld 2.1/Universal/Universal-Buildings-and-walls.png',
    'DNG': 'HAS Dungeon (v.1.01)/Dungeon/Dungeon-Tileset.png',
}

# Ground variants (each biome LandTileset shares one template; the textured
# field block lives at cols 1-6, rows 14-16).
HAS_GROUNDS = {
    'grass':  [('GB', 1, 14), ('GB', 4, 14), ('GB', 5, 15), ('GB', 5, 16)],
    'snow':   [('IB', 1, 14), ('IB', 4, 14), ('IB', 5, 15), ('IB', 5, 16)],
    'swamp':  [('MB', 1, 14), ('MB', 4, 15), ('MB', 5, 15), ('MB', 5, 16)],
    'sand':   [('SB', 1, 14), ('SB', 4, 14), ('SB', 5, 15), ('SB', 5, 16)],
    'dirt':   [('DB', 1, 14), ('DB', 4, 14), ('DB', 5, 15), ('DB', 5, 16)],
    'water':  [('OCEAN', 0, 0), ('OCEAN', 1, 0), ('OCEAN', 2, 0), ('OCEAN', 6, 2)],
    'road':   [('ROAD', 6, 1)],                        # smooth tan road (the brown one is all boulders)
    'floor':  [('DNG', 1, 7), ('DNG', 1, 12)],         # dungeon stone slabs
    'planks': [('ROAD', 14, 6)],                       # pale cobbled boardwalk
    'cave':   [('DNG', 1, 19), ('DNG', 4, 19)],        # brown rubble floor
}

# Scenery stamps: 16px cells designed to fill their tile (HoMM-style forest
# clusters), so the client draws them un-jittered.
HAS_OBJECTS = {
    # each family block's (col+1, row) cell is a complete standalone tree;
    # the neighbouring cells are overlap pieces for hand-built dense woods
    'oak0':   ('TREES', 1, 0), 'oak1': ('TREES', 1, 0), 'oak2': ('TREES', 1, 0),
    'pine0':  ('TREES', 1, 9), 'pine1': ('TREES', 1, 9),
    'dead0':  ('TREES', 14, 0), 'dead1': ('TREES', 14, 0),
    'snowpine0': ('TREES', 40, 0), 'snowpine1': ('TREES', 40, 0),
    'swamptree0': ('TREES', 1, 12), 'swamptree1': ('TREES', 14, 12),
    'rock0':  ('TREES', 1, 22), 'rock1': ('TREES', 1, 22),
    'flower': ('GB', 2, 0), 'tuft': ('GB', 3, 0),
    'stone0': ('GB', 4, 0), 'twig': ('GB', 8, 1),
    'snowdecor0': ('IB', 2, 0), 'snowdecor1': ('IB', 4, 0),
    'sanddecor0': ('SB', 2, 0), 'sanddecor1': ('SB', 4, 0),
    'swampdecor0': ('MB', 2, 0), 'mushroom': ('TREES', 1, 28),
    'table':  ('BLDG', 2, 4), 'stool': ('BLDG', 1, 4),
    'well':   ('DNG', 15, 1),  # a stout barrel-well until a better match
    'chest':  ('DNG', 12, 0),
    # wall autotile pieces (grey stone set): the sheet's top strip is a
    # complete horizontal wall (capL, middle, capR), the left column a
    # complete vertical one, and the keep corners have little towers
    'wall.h': ('BLDG', 2, 0), 'wall.v': ('BLDG', 0, 2),
    'wall.tl': ('BLDG', 1, 1), 'wall.tr': ('BLDG', 3, 1),
    'wall.bl': ('BLDG', 1, 3), 'wall.br': ('BLDG', 3, 3),
    'wall.capL': ('BLDG', 1, 0), 'wall.capR': ('BLDG', 3, 0),
    'wall.capT': ('BLDG', 0, 1), 'wall.capB': ('BLDG', 0, 3),
}


def build_topdown_heroic(frames, images_out):
    sheets = {k: Image.open(os.path.join(HEROIC, p)).convert('RGBA')
              for k, p in HAS_SHEETS.items()}
    cell = lambda ref: sheets[ref[0]].crop(
        (ref[1] * TD, ref[2] * TD, ref[1] * TD + TD, ref[2] * TD + TD))

    kinds = list(HAS_GROUNDS)
    ground = Image.new('RGBA', (4 * TD, len(kinds) * TD), (0, 0, 0, 0))
    for row, kind in enumerate(kinds):
        refs = HAS_GROUNDS[kind]
        for v, ref in enumerate(refs):
            ground.paste(cell(ref), (v * TD, row * TD))
            frames[f'td.g.{kind}.{v}'] = {'img': 'ground16', 'x': v * TD, 'y': row * TD,
                                          'w': TD, 'h': TD, 'ax': 0, 'ay': 0, 'scale': TD_SCALE}

    names = list(HAS_OBJECTS)
    objects = Image.new('RGBA', (len(names) * TD, TD), (0, 0, 0, 0))
    for i, name in enumerate(names):
        objects.paste(cell(HAS_OBJECTS[name]), (i * TD, 0))
        if name.startswith('wall.'):
            # walls draw like ground: anchored at the tile's top-left
            frames[f'td.{name}'] = {'img': 'objects16', 'x': i * TD, 'y': 0, 'w': TD, 'h': TD,
                                    'ax': 0, 'ay': 0, 'scale': TD_SCALE}
        else:
            # stamps fill their tile: anchor bottom-centre of the cell
            frames[f'td.o.{name}'] = {'img': 'objects16', 'x': i * TD, 'y': 0, 'w': TD, 'h': TD,
                                      'ax': TD // 2, 'ay': TD, 'scale': TD_SCALE}

    ground.save(os.path.join(OUT, 'ground16.png'))
    objects.save(os.path.join(OUT, 'objects16.png'))
    images_out['ground16'] = 'ground16.png'
    images_out['objects16'] = 'objects16.png'

    # dungeon brick wall cells + a torch, straight from the dungeon tileset
    dng = sheets['DNG'] if False else Image.open(os.path.join(HEROIC, HAS_SHEETS['DNG'])).convert('RGBA')
    extra = Image.new('RGBA', (9 * TD, 2 * TD), (0, 0, 0, 0))
    # Facade pieces, laid out exactly as the keep block intends: windows are
    # TWO cells tall (top + bottom halves), plain columns beside them, and
    # the pack's own 16x32 door — all drawn per tile column at 3x.
    for i, (name, cx, cy) in enumerate([('wt', 1, 2), ('wb', 1, 3), ('pt', 3, 2), ('pb', 3, 3)]):
        extra.paste(dng.crop((cx * 16, cy * 16, cx * 16 + 16, cy * 16 + 16)), ((4 + i) * TD, 0))
        frames[f'td.f.{name}'] = {'img': 'extras16', 'x': (4 + i) * TD, 'y': 0,
                                  'w': TD, 'h': TD, 'ax': 0, 'ay': 0, 'scale': TD_SCALE}
    extra.paste(dng.crop((7 * 16, 3 * 16, 8 * 16, 5 * 16)), (8 * TD, 0))
    frames['td.f.door'] = {'img': 'extras16', 'x': 8 * TD, 'y': 0, 'w': TD, 'h': 2 * TD,
                           'ax': TD // 2, 'ay': 2 * TD, 'scale': TD_SCALE}
    for i, (cx, cy) in enumerate([(1, 5), (2, 5)]):
        extra.paste(dng.crop((cx * TD, cy * TD, cx * TD + TD, cy * TD + TD)), (i * TD, 0))
        frames[f'td.g.ubrick.{i}'] = {'img': 'extras16', 'x': i * TD, 'y': 0,
                                      'w': TD, 'h': TD, 'ax': 0, 'ay': 0, 'scale': TD_SCALE}
    extra.paste(dng.crop((12 * 16, 7 * 16, 12 * 16 + 16, 7 * 16 + 16)), (2 * TD, 0))
    frames['td.o.torch'] = {'img': 'extras16', 'x': 2 * TD, 'y': 0, 'w': TD, 'h': TD,
                            'ax': TD // 2, 'ay': TD, 'scale': TD_SCALE}
    # the way back up: dungeon staircase treads mark every arrival tile
    extra.paste(dng.crop((5 * 16, 8 * 16, 5 * 16 + 16, 8 * 16 + 16)), (3 * TD, 0))
    frames['td.o.stairsup'] = {'img': 'extras16', 'x': 3 * TD, 'y': 0, 'w': TD, 'h': TD,
                               'ax': TD // 2, 'ay': TD, 'scale': TD_SCALE}
    extra.save(os.path.join(OUT, 'extras16.png'))
    images_out['extras16'] = 'extras16.png'


    # ---- landmark structures: town centrepieces, treasures, cottages ----------
    bpk = os.path.join(HEROIC, 'HAS Buildings Pack 1.01', 'HAS Buildings Pack')
    structs = {
        'citycastle': ('Towns/Castle.png', None), 'citytower': ('Towns/Tower.png', None),
        'citystronghold': ('Towns/Stronghold.png', None), 'cityrampart': ('Towns/Rampart.png', None),
        'keep': ('Treasures/Keep.png', None), 'ruins': ('Treasures/Ruins.png', None),
        'graveyard': ('Treasures/Graveyard.png', None), 'dragoncity': ('Treasures/DragonCity.png', None),
        'snakelair': ('Treasures/SnakeLair.png', None), 'daemoncave': ('Treasures/DaemonCave.png', None),
        'dwarffortress': ('Treasures/DwarfFortress.png', None), 'bloodtemple': ('Treasures/BloodTemple.png', None),
    }
    imgs = {k: Image.open(os.path.join(bpk, p)).convert('RGBA') for k, (p, _) in structs.items()}
    bld = Image.open(os.path.join(HEROIC, HAS_SHEETS['BLDG'])).convert('RGBA')
    for i, (cx, cy) in enumerate([(3, 4), (5, 4), (4, 6), (4, 7)]):
        imgs[f'cottage{i}'] = bld.crop((cx * 16, cy * 16, cx * 16 + 16, cy * 16 + 16))
    sw = sum(im.width for im in imgs.values())
    sh = max(im.height for im in imgs.values())
    sheet = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
    x = 0
    for k, im in imgs.items():
        sheet.paste(im, (x, sh - im.height))
        # city halls tower over houses (5x); treasures loom (4x); cottages 3x
        # the crown's own castle dwarfs everything; other halls are grand
        z = 7 if k == 'citycastle' else 5 if k.startswith('city') else 3 if k.startswith('cottage') else 4
        frames[f'td.o.{k}'] = {'img': 'structures', 'x': x, 'y': sh - im.height,
                               'w': im.width, 'h': im.height,
                               'ax': im.width // 2, 'ay': im.height - 2, 'scale': z}
        x += im.width
    sheet.save(os.path.join(OUT, 'structures.png'))
    images_out['structures'] = 'structures.png'

    g = lambda kind: [f'td.g.{kind}.{v}' for v in range(len(HAS_GROUNDS[kind]))]
    autowall = {k: f'td.wall.{k}' for k in
                ('h', 'v', 'tl', 'tr', 'bl', 'br', 'capL', 'capR', 'capT', 'capB')}
    return {
        '0': {'ground': g('water'), 'effect': 'water'},
        '1': {'ground': g('grass'),
              'decor': {'chance': 0.05,
                        'objects': ['td.o.flower', 'td.o.tuft', 'td.o.stone0', 'td.o.twig']}},
        '2': {'ground': g('grass'),
              'object': ['td.o.oak0', 'td.o.oak1', 'td.o.oak2', 'td.o.pine0', 'td.o.dead0'],
              'objectSets': [
                  ['td.o.oak0', 'td.o.oak1', 'td.o.oak2', 'td.o.oak0', 'td.o.dead0'],
                  ['td.o.pine0', 'td.o.pine1', 'td.o.pine0', 'td.o.pine1', 'td.o.dead1'],
                  ['td.o.dead0', 'td.o.dead1', 'td.o.pine1'],
              ]},
        '3': {'ground': g('dirt'), 'object': ['td.o.rock0', 'td.o.rock1']},
        '4': {'ground': g('road')},
        '5': {'ground': g('floor')},
        '6': {'ground': g('grass'), 'autowall': autowall},
        '7': {'ground': g('sand'),
              'decor': {'chance': 0.04, 'objects': ['td.o.sanddecor0', 'td.o.sanddecor1']}},
        '8': {'ground': g('floor'), 'effect': 'shrine'},
        '9': {'ground': g('snow'),
              'decor': {'chance': 0.04, 'objects': ['td.o.snowdecor0', 'td.o.snowdecor1']}},
        '10': {'ground': g('snow'), 'object': ['td.o.snowpine0', 'td.o.snowpine1']},
        '11': {'ground': g('planks')},
        '12': {'ground': g('swamp'),
               'decor': {'chance': 0.05, 'objects': ['td.o.swampdecor0', 'td.o.mushroom']}},
        '13': {'ground': g('swamp'),
               'object': ['td.o.swamptree0', 'td.o.swamptree1']},
        '14': {'ground': g('cave')},
        # underground overrides (the barrow-deeps strip, y < 64): rock reads
        # as worked brick, and torches bracket the tunnel walls client-side
        'u3': {'ground': ['td.g.ubrick.0', 'td.g.ubrick.1'], 'torch': True},
    }


# ---- HAS creatures ------------------------------------------------------------
#
# Faction/creature sheets are 16px rows per unit with labelled bands:
# Idle @ cols 0-3, Walk @ 4-7, Attack @ 8-11 (Hit/Death follow; unused).
# Units face LEFT. We compose one atlas per game creature: 8 heading rows
# (octants of atan2: 0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE) x 12 anim cols
# (stance 0-3, run 4-7, melee 8-11), baked at 3x (or more for big monsters)
# so the client draws them 1:1 crisp.

HAS_CREATURE_SHEETS = {
    'stronghold': 'HAS CreaturePack (v.1.3)/HAS Creature Pack 1.2/Stronghold/StrongholdSpriteSheet.png',
    'necro': 'HAS CreaturePack (v.1.3)/HAS Creature Pack 1.2/Necromancer/NecromancerSpriteSheet.png',
    'castle': 'HAS CreaturePack (v.1.3)/HAS Creature Pack 1.2/Castle/CastleSpriteSheet.png',
    'rampart': 'HAS CreaturePack (v.1.3)/HAS Creature Pack 1.2/Rampart/RampartSpriteSheet.png',
    'inferno': 'HAS CreaturePack (v.1.3)/HAS Creature Pack 1.2/Inferno/InfernoSpriteSheet.png',
    'animals': 'HASWildlife (v.1.0)/Animals/AnimalsSheet.png',
    'dwarves': 'HAS Dwarves (v.1.1)/Creatures/DwarvesSpriteSheet.png',
    'orcsempire': 'HAS Orcs Empire (1.0)/OrcSpriteSheet.png',
    'woodelves': 'HASWoodElves(v.1.0)/Units/unitsSpriteSheet.png',
    'lizardmen': 'HAS Lizardmen Empire (v.1.1)/LizardmenSpriteSheet.png',
}

# The standalone faction packs put two 16px portrait cells before the
# animation bands, so their frames start at column 2 (WoodElves excepted).
HAS_SHEET_COL_OFFSET = {'dwarves': 2, 'orcsempire': 2, 'lizardmen': 2}

# kind -> (sheet, row, bake scale, recolor)
HAS_UNITS = {
    'goblin':   ('stronghold', 1, 3, None),
    'orc':      ('stronghold', 13, 3, None),
    'ettin':    ('stronghold', 14, 4, None),
    'skeleton': ('necro', 1, 3, None),
    'skelmage': ('necro', 14, 3, None),
    'bonelord': ('necro', 9, 4, None),
    'guard':    ('castle', 12, 3, None),
    'villager': ('castle', 5, 3, None),
    'villager2': ('castle', 2, 3, None),   # the village hunter
    'villager3': ('rampart', 4, 3, None),  # the ranger
    'vendor':   ('rampart', 6, 3, None),   # white-robed sorceress
    'smith':    ('rampart', 10, 3, None),  # dwarf with a hammer
    'bard':     ('rampart', 11, 3, None),  # a satyr, pipes and all
    'hermit':   ('rampart', 14, 3, None),  # green-robed druid
    'zombie':   ('necro', 2, 3, None),     # walking dead, cleaver and all
    'ghost':    ('necro', 12, 3, None),    # blue-white wraith
    'vampire':  ('necro', 5, 4, None),     # red-caped count, baked boss-big
    'harpy':    ('stronghold', 2, 3, None),
    'wolfrider': ('stronghold', 3, 3, None),  # goblin on a grey wolf
    'dragon':   ('inferno', 15, 5, None),  # the arch-fiend wears the crown
    'wolf':     ('inferno', 3, 3, None),   # hell hound, close enough to a hungry wolf
    'deer':     ('animals', 3, 3, None),
    'boar':     ('animals', 2, 3, None),
    'snake':    ('animals', 6, 3, None),
    # the mountain clans of the high quarries
    'dwarf':       ('dwarves', 1, 3, None),   # miner with his axe
    'dwarfguard':  ('dwarves', 6, 3, None),   # halberdier in red
    'dwarfpriest': ('dwarves', 7, 3, None),   # white-bearded rune-priest
    # the warlord's own, harder company than the common camps
    'orcbrute':    ('orcsempire', 3, 4, None),  # shield and club
    'orcwarlord':  ('orcsempire', 7, 4, None),  # white-crested chief
    # the deep-wood folk
    'elfranger':   ('woodelves', 13, 3, None),  # hooded archer
    'dryad':       ('woodelves', 1, 3, None),   # red-blossom guardian
    'treant':      ('woodelves', 2, 4, None),   # walking elder tree
    # the mire-folk of the sunken warren
    'lizardman':   ('lizardmen', 11, 3, None),  # crested warrior
    'raptor':      ('lizardmen', 6, 3, None),   # gold-eyed hunting beast
}

HAS_HERO_DIRS = ['Right', 'Right-Down', 'Down', 'Left-Down', 'Left', 'Left-Up', 'Up', 'Right-Up']
HAS_HEROES = {  # kind -> (faction dir name, file prefix, gender)
    # Only the player rides: a mounted knight, in the finest UO tradition.
    'player':    ('Castle', 'CastleSprite', 'Male'),
}


def grayify(img):
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a:
                l = int(0.3 * r + 0.55 * g + 0.15 * b)
                px[x, y] = (l, l, min(255, l + 10), a)
    return out


def compose_has_atlas(name, get_frame, z, dirs=8, anims=None):
    """get_frame(anim_col 0-11, mirrored) -> 16x16 image. Writes atlas + returns manifest."""
    c = 16 * z
    atlas = Image.new('RGBA', (12 * c, dirs * c), (0, 0, 0, 0))
    # which headings use the mirrored (right-facing) frames
    mirrored_for = {0: True, 1: True, 2: False, 3: False, 4: False, 5: False, 6: True, 7: True}
    for row in range(dirs):
        for col in range(12):
            f = get_frame(col, dirs > 1 and mirrored_for[row])
            atlas.paste(f.resize((c, c), Image.NEAREST), (col * c, row * c))
    atlas.save(os.path.join(OUT, 'creatures', f'{name}.png'))
    return {
        'img': name, 'cellW': c, 'cellH': c, 'dirs': dirs,
        'ax': c // 2, 'ay': c - 3 * z,
        'anims': anims or {
            'stance': {'start': 0, 'frames': 4, 'ms': 260, 'loop': 'back_forth'},
            'run': {'start': 4, 'frames': 4, 'ms': 140},
            'melee': {'start': 8, 'frames': 4, 'ms': 130},
        },
    }


def build_has_creatures():
    sheets = {k: Image.open(os.path.join(HEROIC, p)).convert('RGBA')
              for k, p in HAS_CREATURE_SHEETS.items()}
    creatures = {}
    for kind, (sheet, row, z, recolor) in HAS_UNITS.items():
        img = sheets[sheet]
        off = HAS_SHEET_COL_OFFSET.get(sheet, 0)
        def get_frame(col, mirrored, img=img, row=row, recolor=recolor, off=off):
            col += off
            f = img.crop((col * 16, row * 16, col * 16 + 16, row * 16 + 16))
            if recolor == 'gray':
                f = grayify(f)
            return f.transpose(Image.FLIP_LEFT_RIGHT) if mirrored else f
        creatures[kind] = compose_has_atlas(kind, get_frame, z)

    hero_root = os.path.join(HEROIC, 'HAS Hero Pack (v.1.0)', 'HAS Hero Pack')
    for kind, (faction, prefix, gender) in HAS_HEROES.items():
        sprites = os.path.join(hero_root, faction, gender, 'Sprites')
        cache = {}
        def load(d, n, sprites=sprites, prefix=prefix, gender=gender, cache=cache):
            key = (d, n)
            if key not in cache:
                cache[key] = Image.open(os.path.join(
                    sprites, f'{prefix}{gender}-{d} (Frame {n}).png')).convert('RGBA')
            return cache[key]
        # per-heading direction comes from the filename, not mirroring
        c = 48
        atlas = Image.new('RGBA', (12 * c, 8 * c), (0, 0, 0, 0))
        for row, d in enumerate(HAS_HERO_DIRS):
            # stance = standing frame; run = the walk cycle; melee = a jab
            plan = [1, 1, 1, 1, 1, 2, 3, 4, 2, 4, 2, 4]
            for col, n in enumerate(plan):
                atlas.paste(load(d, n).resize((c, c), Image.NEAREST), (col * c, row * c))
        atlas.save(os.path.join(OUT, 'creatures', f'{kind}.png'))
        creatures[kind] = {
            'img': kind, 'cellW': c, 'cellH': c, 'dirs': 8, 'ax': c // 2, 'ay': c - 9,
            'anims': {
                'stance': {'start': 0, 'frames': 1, 'ms': 400},
                'run': {'start': 4, 'frames': 4, 'ms': 150},
                'melee': {'start': 8, 'frames': 4, 'ms': 130},
            },
        }

    # Tiny original critters in HAS proportions for kinds the packs lack.
    for kind, draw in CRITTERS.items():
        base = [draw(pose) for pose in (0, 1)]
        def get_frame(col, mirrored, base=base):
            pose = 0 if col < 4 else (col % 2)
            f = base[pose]
            return f.transpose(Image.FLIP_LEFT_RIGHT) if mirrored else f
        creatures[kind] = compose_has_atlas(kind, get_frame, 3)
    return creatures


def _draw_critter(spec):
    def draw(pose):
        im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
        px = im.load()
        for color, pts in spec(pose):
            c = hexrgb(color)
            for x, y in pts:
                if 0 <= x < 16 and 0 <= y < 16:
                    px[x, y] = c
        return im
    return draw


def _oval(cx, cy, rx, ry):
    return [(x, y) for y in range(16) for x in range(16)
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1]


CRITTERS = {
    'sheep': _draw_critter(lambda pose: [
        ('#e8e4da', _oval(8, 9, 4.6, 3.2)),
        ('#c8c4ba', [(5, 6), (7, 6), (10, 6)]),
        ('#3a3530', [(12, 8), (13, 8), (12, 9), (13, 9)]),          # face
        ('#2a2724', [(6, 12 + pose % 2), (10, 13 - pose % 2)]),      # legs
    ]),
    'pig': _draw_critter(lambda pose: [
        ('#e0a8a0', _oval(8, 10, 4.4, 2.8)),
        ('#c88880', [(12, 9), (13, 9), (13, 10), (12, 10)]),         # snout
        ('#5a3a36', [(11, 8)]),                                      # eye
        ('#b87870', [(6, 13 - pose % 2), (10, 12 + pose % 2)]),      # trotters
    ]),
    'chicken': _draw_critter(lambda pose: [
        ('#efe7d3', _oval(8, 11, 2.6, 2.2)),
        ('#efe7d3', [(9, 8), (10, 8), (9, 9)]),                      # head
        ('#c83c30', [(9, 7)]),                                       # comb
        ('#e8b040', [(11, 9), (8, 14 - pose % 2), (9, 13 + pose % 2)]),  # beak + feet
    ]),
    'crab': _draw_critter(lambda pose: [
        ('#c05038', _oval(8, 10, 3.6, 2.2)),
        ('#a84330', [(4, 8 - pose % 2), (12, 8 - pose % 2), (3, 7), (13, 7)]),  # claws
        ('#2a2724', [(6, 9), (10, 9)]),                              # eyes
        ('#a84330', [(4, 12), (6, 13 - pose % 2), (10, 13 - pose % 2), (12, 12)]),  # legs
    ]),
}



# ---- HAS UI: window frames, buttons, cursor for the HTML chrome -------------------

def build_has_spellfx(frames, images_out):
    """Every Magic Book spell ships 4 animation frames (24x24); bake the
    ones the game casts into one atlas, plus icons for the new spells."""
    import glob as _g
    book = os.path.join(HEROIC, 'HAS Magic Book 1.1')
    SP = [('magicarrow', 'MagicArrow'), ('fireball', 'FireBall'), ('greaterheal', 'Cure'),
          ('bless', 'Bless'), ('poison', 'AcidSplash'), ('energybolt', 'EnergyBlast'),
          ('icebolt', 'IceBolt'), ('chainlightning', 'ChainLightning'), ('haste', 'Haste')]
    C = 24
    atlas = Image.new('RGBA', (4 * C, len(SP) * C), (0, 0, 0, 0))
    for r, (sid, folder) in enumerate(SP):
        for n in range(1, 5):
            hits = sorted(_g.glob(os.path.join(book, folder, f'*Frame {n}*.png')))
            im = Image.open(hits[0]).convert('RGBA')
            atlas.paste(im, ((n - 1) * C, r * C))
            frames[f'td.sfx.{sid}.{n - 1}'] = {'img': 'spellfx', 'x': (n - 1) * C, 'y': r * C,
                                               'w': C, 'h': C, 'ax': C // 2, 'ay': C - 6, 'scale': 3}
    atlas.save(os.path.join(OUT, 'spellfx.png'))
    images_out['spellfx'] = 'spellfx.png'
    icons = os.path.join(OUT, 'ui', 'icons')
    os.makedirs(icons, exist_ok=True)
    for sid, folder in [('icebolt', 'IceBolt'), ('chainlightning', 'ChainLightning'), ('haste', 'Haste')]:
        f = sorted(_g.glob(os.path.join(book, folder, 'Icon*.png')))[0]
        im = Image.open(f).convert('RGBA')
        im.resize((32, 32), Image.NEAREST).save(os.path.join(icons, f'{sid}.png'))


def build_has_ui():
    ui_src = os.path.join(HEROIC, 'HAS UI')
    out = os.path.join(OUT, 'ui')
    os.makedirs(out, exist_ok=True)
    # each sheet is a demo layout; crop just the clean window for 9-slicing
    picks = {
        'panel.png': ('Windows/sheet_window__12.png', (0, 0, 64, 64)),  # gold-ornate
        'button.png': ('Windows/sheet_window__10.png', (0, 0, 48, 48)),  # warm wood
        'panel-silver.png': ('Windows/sheet_window__17.png', (0, 0, 48, 48)),
    }
    for dst, (rel, box) in picks.items():
        Image.open(os.path.join(ui_src, rel)).convert('RGBA').crop(box).save(
            os.path.join(out, dst))
    cur = Image.open(os.path.join(ui_src, 'Cursors/Cursor_1.png')).convert('RGBA')
    cur.resize((cur.width * 2, cur.height * 2), Image.NEAREST).save(os.path.join(out, 'cursor.png'))

    # framed HP/mana bars: ornate frame pieces plus fill strips (cropped to
    # their pixels so CSS can stretch them edge to edge)
    for dst, src in {'bar-frame-gold.png': 'Bar/bar_03.png',
                     'bar-frame-silver.png': 'Bar/bar_12.png'}.items():
        Image.open(os.path.join(ui_src, src)).convert('RGBA').save(os.path.join(out, dst))
    for dst, src in {'bar-fill-red.png': 'Bar/bar_21.png',
                     'bar-fill-blue.png': 'Bar/bar_24.png',
                     'bar-fill-green.png': 'Bar/bar_18.png'}.items():
        im = Image.open(os.path.join(ui_src, src)).convert('RGBA')
        im.crop(im.getbbox()).save(os.path.join(out, dst))
    # a compass-cornered frame for the minimap, a leather thumb for scrollbars
    Image.open(os.path.join(ui_src, 'MiniMap/Map_2.png')).convert('RGBA').save(
        os.path.join(out, 'minimap-frame.png'))
    Image.open(os.path.join(ui_src, 'Scrolling/scrolling_v_00.png')).convert('RGBA').save(
        os.path.join(out, 'scroll-thumb.png'))
    # the pack's display face travels with the UI (licensed with the pack)
    import shutil
    shutil.copyfile(os.path.join(ui_src, 'Font/MiKrollFantasy.ttf'),
                    os.path.join(out, 'MiKrollFantasy.ttf'))

    # spell icons from HAS Magic Book, item icons from HAS IconPack
    icons = os.path.join(out, 'icons')
    os.makedirs(icons, exist_ok=True)
    book = os.path.join(HEROIC, 'HAS Magic Book 1.1')
    import glob as _glob
    for name, folder in [('magicarrow', 'MagicArrow'), ('fireball', 'FireBall'),
                         ('greaterheal', 'Cure'), ('bless', 'Bless'),
                         ('poison', 'AcidSplash'), ('energybolt', 'EnergyBlast')]:
        found = sorted(_glob.glob(os.path.join(book, folder, 'Icon*.png')))
        if not found:
            raise FileNotFoundError(folder)
        im = Image.open(found[0]).convert('RGBA')
        im.resize((im.width * 2, im.height * 2), Image.NEAREST).save(
            os.path.join(icons, f'{name}.png'))
    misc = Image.open(os.path.join(
        HEROIC, 'HAS IconPack (v.1.2)/IconPack 1.1/AllItems/MiscellaneousSource/MiscellaneousOriginal.png')).convert('RGBA')
    for name, (cx, cy) in {'gold': (13, 0), 'heal': (1, 1), 'mana': (2, 1),
                           'logs': (6, 0), 'ore': (8, 0), 'gems': (3, 1),
                           'food': (14, 1), 'pick': (10, 1)}.items():
        c = misc.crop((cx * 16, cy * 16, cx * 16 + 16, cy * 16 + 16))
        c.resize((32, 32), Image.NEAREST).save(os.path.join(icons, f'{name}.png'))

    # equipment icons: one hand-picked cell per WEAPONS id, so the shop,
    # forge and backpack can show the goods (sheets are 10x2 cells of 16px)
    allitems = os.path.join(HEROIC, 'HAS IconPack (v.1.2)/IconPack 1.1/AllItems')
    EQUIP = {
        'dagger':       ('WeaponSource/DaggerOriginal.png', 0, 0),
        'sword':        ('WeaponSource/SwordOriginal.png', 0, 1),
        'greatsword':   ('WeaponSource/SwordOriginal.png', 8, 1),
        'dawnbreaker':  ('WeaponSource/SwordOriginal.png', 9, 0),
        'battleaxe':    ('WeaponSource/AxeOriginal.png', 6, 0),
        'mace':         ('WeaponSource/MaceOriginal.png', 6, 0),
        'longbow':      ('WeaponSource/RangedOriginal.png', 1, 1),
        'buckler':      ('ShieldSource/ShieldOriginal.png', 5, 1),
        'kiteshield':   ('ShieldSource/ShieldOriginal.png', 6, 1),
        'leatherarmor': ('TorsoSource/TorsoOriginal.png', 1, 1),
        'chainmail':    ('TorsoSource/TorsoOriginal.png', 6, 0),
    }
    eq = os.path.join(icons, 'eq')
    os.makedirs(eq, exist_ok=True)
    for name, (rel, cx, cy) in EQUIP.items():
        sheet = Image.open(os.path.join(allitems, rel)).convert('RGBA')
        c = sheet.crop((cx * 16, cy * 16, cx * 16 + 16, cy * 16 + 16))
        c.resize((48, 48), Image.NEAREST).save(os.path.join(eq, f'{name}.png'))
    print('ui chrome + icons baked from HAS UI / Magic Book / IconPack')


def build_topdown_placeholder(frames, images_out):
    import random
    rng = random.Random(20260613)
    kinds = ['grass', 'water', 'sand', 'snow', 'swamp', 'dirt', 'floor',
             'planks', 'cave', 'wall', 'shrine']
    ground = Image.new('RGBA', (4 * TD, len(kinds) * TD), (0, 0, 0, 0))

    def speckle(px, ox, oy, pal, n=26):
        for _ in range(n):
            x, y = rng.randrange(TD), rng.randrange(TD)
            px[ox + x, oy + y] = hexrgb(pal[rng.randrange(1, len(pal))])

    px = ground.load()
    for row, kind in enumerate(kinds):
        pal = TD_PALETTES['floor' if kind == 'shrine' else kind]
        base = hexrgb(pal[0])
        for v in range(4):
            ox, oy = v * TD, row * TD
            for y in range(TD):
                for x in range(TD):
                    px[ox + x, oy + y] = base
            if kind == 'water':
                # still water with drifting wave crests
                speckle(px, ox, oy, pal, 14)
                for _ in range(3):
                    wy = rng.randrange(2, TD - 2)
                    wx = rng.randrange(0, TD - 5)
                    for i in range(rng.randrange(3, 6)):
                        px[ox + wx + i, oy + wy] = hexrgb(pal[4])
            elif kind == 'floor':
                # stone slabs with mortar seams
                speckle(px, ox, oy, pal, 16)
                for y in range(TD):
                    px[ox + (7 if y < 8 else 3 + 8 * (v % 2)), oy + y] = hexrgb(pal[4])
                for x in range(TD):
                    px[ox + x, oy + 7] = hexrgb(pal[4])
            elif kind == 'planks':
                speckle(px, ox, oy, pal, 10)
                for x in (3, 7, 11, 15):
                    for y in range(TD):
                        px[ox + x, oy + y] = hexrgb(pal[4])
                for y in range(TD):
                    if rng.random() < 0.25:
                        px[ox + rng.randrange(TD), oy + y] = hexrgb(pal[3])
            elif kind == 'wall':
                # a battlement seen from above: stone cap, dark rim,
                # crenel notches along the edges, a worn inner walk
                speckle(px, ox, oy, pal, 12)
                rim = hexrgb(pal[4])
                notch = hexrgb('#3a3630')
                for i in range(TD):
                    px[ox + i, oy] = rim
                    px[ox + i, oy + TD - 1] = rim
                    px[ox, oy + i] = rim
                    px[ox + TD - 1, oy + i] = rim
                for i in range(1, TD - 1):
                    if i % 5 in (1, 2):
                        px[ox + i, oy + 1] = notch
                        px[ox + i, oy + TD - 2] = notch
                        px[ox + 1, oy + i] = notch
                        px[ox + TD - 2, oy + i] = notch
                for y in range(4, 12):
                    for x in range(4, 12):
                        if (x + y + v) % 6 == 0:
                            px[ox + x, oy + y] = hexrgb(pal[2])
            elif kind == 'shrine':
                speckle(px, ox, oy, pal, 12)
                # a gold inlay ring
                gold = hexrgb('#d8b35e')
                for x, y in [(7, 3), (8, 3), (5, 5), (10, 5), (4, 7), (11, 7),
                             (4, 8), (11, 8), (5, 10), (10, 10), (7, 12), (8, 12)]:
                    px[ox + x, oy + y] = gold
            else:
                speckle(px, ox, oy, pal)
        # frames: td.g.<kind>.<v>
        for v in range(4):
            frames[f'td.g.{kind}.{v}'] = {'img': 'ground16', 'x': v * TD, 'y': row * TD,
                                          'w': TD, 'h': TD, 'ax': 0, 'ay': 0, 'scale': TD_SCALE}

    # ---- objects: trees, rocks, decor, props (16x24 cells, feet at y=22) ----
    names = ['oak0', 'oak1', 'pine0', 'pine1', 'dead0', 'snowpine0', 'snowpine1',
             'swamptree0', 'swamptree1', 'rock0', 'rock1', 'flower', 'tuft',
             'well', 'table', 'stool']
    OH = 24
    objects = Image.new('RGBA', (len(names) * TD, OH), (0, 0, 0, 0))
    d = objects.load()

    def blob(ox, cx, cy, r, cols, outline):
        for y in range(OH):
            for x in range(TD):
                dd = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if dd <= r:
                    d[ox + x, y] = hexrgb(cols[rng.randrange(len(cols))])
                elif dd <= r + 0.9 and outline:
                    d[ox + x, y] = hexrgb(outline)

    def trunk(ox, x, y0, y1, col='#5a4028'):
        for y in range(y0, y1):
            d[ox + x, y] = hexrgb(col)
            d[ox + x + 1, y] = hexrgb('#4a3520')

    def tri(ox, cx, ytop, ybot, half, cols, dust=None):
        for y in range(ytop, ybot):
            k = (y - ytop) / max(1, ybot - ytop - 1)
            w = max(1, round(half * k))
            for x in range(cx - w, cx + w + 1):
                col = cols[rng.randrange(len(cols))]
                if dust and y - ytop < 3 and rng.random() < 0.6:
                    col = dust
                d[ox + x, y] = hexrgb(col)

    for i, name in enumerate(names):
        ox = i * TD
        if name.startswith('oak'):
            trunk(ox, 7, 13, 20)
            blob(ox, 8, 7, 6 + (1 if name.endswith('1') else 0),
                 ['#4c6e2c', '#557a32', '#3f5e24'], '#2c451a')
        elif name.startswith('pine'):
            trunk(ox, 7, 16, 20)
            tri(ox, 8, 1 + (2 if name.endswith('1') else 0), 17, 7,
                ['#3c5c28', '#446832', '#325020'])
        elif name == 'dead0':
            trunk(ox, 7, 6, 20)
            for bx, by, ln in ((4, 8, 3), (9, 6, 4), (3, 12, 4), (10, 11, 3)):
                for k in range(ln):
                    d[ox + bx + k, by] = hexrgb('#4a3520')
        elif name.startswith('snowpine'):
            trunk(ox, 7, 16, 20)
            tri(ox, 8, 1 + (2 if name.endswith('1') else 0), 17, 7,
                ['#3c5c28', '#446832', '#325020'], dust='#e9eef3')
        elif name.startswith('swamptree'):
            trunk(ox, 7, 11 if name.endswith('0') else 13, 20, '#3a3428')
            blob(ox, 8, 7, 5, ['#4c5c3a', '#42522f', '#385026'], '#2a3a20')
        elif name.startswith('rock'):
            blob(ox, 8, 17, 4 + (1 if name.endswith('1') else 0),
                 ['#8c8880', '#7a766e', '#94908a'], '#5a564e')
            for x in range(5, 12):
                d[ox + x, 14 if name.endswith('0') else 13] = hexrgb('#a4a09a')
        elif name == 'flower':
            d[ox + 8, 20] = hexrgb('#4c6e2c')
            d[ox + 8, 21] = hexrgb('#4c6e2c')
            for x, y in ((7, 19), (9, 19), (8, 18), (8, 20)):
                d[ox + x, y] = hexrgb('#d86a6a' if rng.random() < 0.5 else '#e8e0d0')
        elif name == 'tuft':
            for x, y0 in ((6, 18), (8, 17), (10, 18), (7, 19), (9, 19)):
                for y in range(y0, 22):
                    d[ox + x, y] = hexrgb('#7f9244')
        elif name == 'well':
            for y in range(14, 22):
                for x in range(3, 13):
                    d[ox + x, y] = hexrgb('#8c8880' if (x + y) % 3 else '#7a766e')
            for x in range(5, 11):
                for y in range(16, 20):
                    d[ox + x, y] = hexrgb('#1a2430')
            for x, y in ((3, 13), (12, 13)):
                for yy in range(y - 8, y + 1):
                    d[ox + x, yy] = hexrgb('#5a4028')
            for x in range(2, 14):
                d[ox + x, 5] = hexrgb('#8a6a42')
                d[ox + x, 6] = hexrgb('#7a5c38')
        elif name == 'table':
            for x in range(2, 14):
                for y in range(14, 17):
                    d[ox + x, y] = hexrgb('#8a6a42' if y == 14 else '#7a5c38')
            for x in (3, 12):
                for y in range(17, 22):
                    d[ox + x, y] = hexrgb('#6e5334')
        elif name == 'stool':
            for x in range(5, 11):
                d[ox + x, 17] = hexrgb('#8a6a42')
                d[ox + x, 18] = hexrgb('#7a5c38')
            for x in (5, 10):
                for y in range(19, 22):
                    d[ox + x, y] = hexrgb('#6e5334')
        feet = 22 if name in ('well', 'table', 'stool', 'flower', 'tuft', 'rock0', 'rock1') else 20
        frames[f'td.o.{name}'] = {'img': 'objects16', 'x': ox, 'y': 0, 'w': TD, 'h': OH,
                                  'ax': TD // 2, 'ay': feet, 'scale': TD_SCALE}

    ground.save(os.path.join(OUT, 'ground16.png'))
    objects.save(os.path.join(OUT, 'objects16.png'))
    images_out['ground16'] = 'ground16.png'
    images_out['objects16'] = 'objects16.png'

    g = lambda kind: [f'td.g.{kind}.{v}' for v in range(4)]
    return {
        '0': {'ground': g('water'), 'effect': 'water'},
        '1': {'ground': g('grass'),
              'decor': {'chance': 0.05, 'objects': ['td.o.flower', 'td.o.tuft', 'td.o.tuft']}},
        '2': {'ground': g('grass'),
              'object': ['td.o.oak0', 'td.o.oak1', 'td.o.pine0', 'td.o.pine1', 'td.o.dead0'],
              'objectSets': [
                  ['td.o.oak0', 'td.o.oak0', 'td.o.oak1', 'td.o.pine1', 'td.o.dead0'],
                  ['td.o.pine0', 'td.o.pine1', 'td.o.pine0', 'td.o.pine1', 'td.o.dead0'],
                  ['td.o.dead0', 'td.o.dead0', 'td.o.pine1'],
              ]},
        '3': {'ground': g('dirt'), 'object': ['td.o.rock0', 'td.o.rock1']},
        '4': {'ground': g('dirt')},
        '5': {'ground': g('floor')},
        '6': {'ground': g('wall')},
        '7': {'ground': g('sand')},
        '8': {'ground': g('shrine'), 'effect': 'shrine'},
        '9': {'ground': g('snow')},
        '10': {'ground': g('snow'), 'object': ['td.o.snowpine0', 'td.o.snowpine1']},
        '11': {'ground': g('planks')},
        '12': {'ground': g('swamp')},
        '13': {'ground': g('swamp'), 'object': ['td.o.swamptree0', 'td.o.swamptree1']},
        '14': {'ground': g('cave')},
        # underground overrides (the barrow-deeps strip, y < 64): rock reads
        # as worked brick, and torches bracket the tunnel walls client-side
        'u3': {'ground': ['td.g.ubrick.0', 'td.g.ubrick.1'], 'torch': True},
    }


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
    trim_object(terrain, (0, 320, 64, 384), 'rocks.0', frames, 'terrain', scale=0.85)
    trim_object(terrain, (64, 320, 128, 384), 'rocks.1', frames, 'terrain', scale=0.85)
    trim_object(terrain, (128, 320, 192, 384), 'rocks.2', frames, 'terrain', scale=0.85)
    trim_object(terrain, (0, 704, 64, 768), 'tallgrass.0', frames, 'terrain')
    trim_object(terrain, (64, 704, 128, 768), 'tallgrass.1', frames, 'terrain')
    trim_object(terrain, (0, 768, 64, 832), 'bush.0', frames, 'terrain')
    trim_object(terrain, (64, 768, 128, 832), 'bush.1', frames, 'terrain')
    trim_object(terrain, (128, 768, 192, 896), 'tree.fir0', frames, 'terrain', scale=0.8)
    trim_object(terrain, (192, 768, 256, 896), 'tree.fir1', frames, 'terrain', scale=0.8)
    for i in range(4):
        trim_object(terrain, (i * 64, 896, (i + 1) * 64, 1024), f'tree.pine{i}', frames, 'terrain', scale=0.8)
    trim_object(terrain, (256, 832, 448, 1024), 'tree.dead', frames, 'terrain', scale=0.7)
    trim_object(terrain, (448, 832, 640, 1024), 'tree.oak', frames, 'terrain', scale=0.72)
    trim_object(building, (0, 0, 64, 64), 'wall.0', frames, 'building')
    trim_object(building, (64, 0, 128, 64), 'wall.1', frames, 'building')
    trim_object(building, (64, 320, 178, 384), 'prop.table', frames, 'building')
    trim_object(building, (208, 352, 240, 384), 'prop.stool', frames, 'building')
    trim_object(building, (576, 316, 640, 384), 'prop.well', frames, 'building')

    # Snow-dusted trees: copies of the conifers with whitened foliage.
    snow_sources = ['tree.pine0', 'tree.pine1', 'tree.pine2', 'tree.pine3',
                    'tree.fir0', 'tree.fir1', 'tree.dead']
    cells = []
    for name in snow_sources:
        f = frames[name]
        img = terrain if f['img'] == 'terrain' else building
        cells.append(img.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h'])))
    sheet_w = sum(c.width for c in cells) + 2 * len(cells)
    sheet_h = max(c.height for c in cells)
    snow_sheet = Image.new('RGBA', (sheet_w, sheet_h), (0, 0, 0, 0))
    sx = 0
    for name, cell in zip(snow_sources, cells):
        arr = np.asarray(cell).astype(np.float32)
        r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
        if name == 'tree.dead':
            # Bare branches: frost the whole silhouette evenly.
            foliage = a > 0
            trunk = np.zeros_like(foliage)
        else:
            foliage = (g >= r) & (a > 0)     # leaves whiten a lot
            trunk = (g < r) & (a > 0)        # bark only gets a dusting
        for ch, base in ((0, r), (1, g), (2, b)):
            k = np.where(foliage, 0.55, np.where(trunk, 0.15, 0.0))
            arr[..., ch] = base * (1 - k) + 255 * k
        snowy = Image.fromarray(arr.astype(np.uint8), 'RGBA')
        snow_sheet.alpha_composite(snowy, (sx, sheet_h - cell.height))
        sname = 'snow' + name[5:]  # tree.pine0 -> snowpine0
        frames['tree.' + sname] = {
            'img': 'snowtrees', 'x': sx, 'y': sheet_h - cell.height,
            'w': cell.width, 'h': cell.height,
            'ax': cell.width // 2, 'ay': cell.height - 16,
            'scale': frames[name].get('scale', 1),
        }
        sx += cell.width + 2
    snow_sheet.save(os.path.join(OUT, 'snowtrees.png'))

    # Swamp trees: the same silhouettes drowned in bog-green.
    swamp_sources = ['tree.dead', 'tree.fir0', 'tree.fir1', 'tree.pine3']
    cells = []
    for name in swamp_sources:
        f = frames[name]
        cells.append(terrain.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h'])))
    sw_w = sum(c.width for c in cells) + 2 * len(cells)
    sw_h = max(c.height for c in cells)
    swamp_sheet = Image.new('RGBA', (sw_w, sw_h), (0, 0, 0, 0))
    sx = 0
    for name, cell in zip(swamp_sources, cells):
        arr = np.asarray(cell).astype(np.float32)
        a = arr[..., 3:4]
        tint = np.array([86, 102, 64], dtype=np.float32)
        arr[..., :3] = arr[..., :3] * 0.55 + tint * 0.45
        mossy = Image.fromarray(np.concatenate([arr[..., :3], a], axis=-1).astype(np.uint8), 'RGBA')
        swamp_sheet.alpha_composite(mossy, (sx, sw_h - cell.height))
        sname = 'swamp' + name[5:]
        frames['tree.' + sname] = {
            'img': 'swamptrees', 'x': sx, 'y': sw_h - cell.height,
            'w': cell.width, 'h': cell.height,
            'ax': cell.width // 2, 'ay': cell.height - 16,
            'scale': 0.72,
        }
        sx += cell.width + 2
    swamp_sheet.save(os.path.join(OUT, 'swamptrees.png'))

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
        '6': {'ground': ['floor.0'], 'object': ['wall.0', 'wall.0', 'wall.0', 'wall.1'], 'stack': 2},
        '7': {'groundProc': 'sand'},
        '8': {'ground': ['floor.1'], 'effect': 'shrine'},
        '9': {'groundProc': 'snow'},
        '11': {'ground': ['planks']},
        '12': {'groundProc': 'swamp'},
        '14': {'groundProc': 'cave'},
        '13': {'groundProc': 'swamp',
               'object': ['tree.swampdead', 'tree.swampdead', 'tree.swampfir0',
                          'tree.swampfir1', 'tree.swamppine3']},
        '10': {'groundProc': 'snow',
               'object': ['tree.snowpine0', 'tree.snowpine1', 'tree.snowpine2',
                          'tree.snowpine3', 'tree.snowfir0', 'tree.snowfir1', 'tree.snowdead']},
    }

    # Creatures.
    def packed(name):
        img = Image.open(os.path.join(SRC, f'{name}.png')).convert('RGBA')
        anims = parse_flare_anims(os.path.join(SRC, f'{name}.txt'))
        return img, anims

    # Scales keep creatures in proportion with the 64x32 tiles: a human is
    # about a tile-and-a-half tall, like classic UO.
    creatures = {}
    creatures['goblin'] = build_creature('goblin', [packed('goblin')], scale=0.78)
    creatures['skeleton'] = build_creature('skeleton', [packed('skeleton')], scale=0.6)
    creatures['skelmage'] = build_creature('skelmage', [packed('skeleton_mage')], scale=0.6)
    creatures['orc'] = build_creature('orc', [packed('hobgoblin')], scale=0.95)
    creatures['ettin'] = build_minotaur(scale=1.0)
    creatures['dragon'] = build_dragon(scale=0.8)

    pants = packed('cloth_pants')
    boots = packed('leather_boots')
    shirt = packed('cloth_shirt')
    head = packed('head_short')
    hood = packed('mage_hood')
    chest = packed('default_chest')  # bare skin: torso and arms
    hands = packed('default_hands')
    weapon_overlays = {k: packed('w_' + k) for k in
                       ['dagger', 'longsword', 'mace', 'battle_axe', 'greatsword', 'longbow']}
    for k in ['leather', 'chain', 'buckler', 'kite_shield']:
        weapon_overlays[k] = packed('a_' + k)
    creatures['player'] = build_creature(
        'player', [chest, hands, boots, pants, shirt, head], scale=0.6, stance_ms=260,
        overlays=weapon_overlays)
    creatures['vendor'] = build_creature(
        'vendor', [chest, hands, boots, pants, shirt, hood], scale=0.6, stance_ms=320)

    # Distinct townsfolk models, all from the same layered avatar kit.
    bald = packed('head_bald')
    lchest = packed('leather_chest')
    lpants = packed('leather_pants')
    lhood = packed('leather_hood')
    creatures['smith'] = build_creature(
        'smith', [chest, hands, boots, lpants, lchest, bald], scale=0.6, stance_ms=300)
    creatures['bard'] = build_creature(
        'bard', [chest, hands, boots, pants, shirt, head], scale=0.6, stance_ms=280,
        hue=(0.5, (0.16, 0.45, 0.18)))  # the shirt turns minstrel-purple
    creatures['hermit'] = build_creature(
        'hermit', [chest, hands, boots, pants, shirt, lhood], scale=0.6, stance_ms=340,
        hue=(0.9, (0.16, 0.45, 0.18)))  # faded, road-worn red
    creatures['villager2'] = build_creature(
        'villager2', [chest, hands, boots, pants, shirt, bald], scale=0.6, stance_ms=300,
        hue=(0.75, (0.16, 0.45, 0.18)))  # rust-red work shirt
    creatures['villager3'] = build_creature(
        'villager3', [chest, hands, boots, lpants, lchest, head], scale=0.6, stance_ms=300)

    # Wildlife and livestock.
    creatures['wolf'] = build_dir4_creature('wolf', 3, 48, 64, scale=1.1)
    creatures['deer'] = build_dir4_creature('deer', 3, 64, 64, scale=1.0)
    creatures['sheep'] = build_dir4_creature('sheep', 4, 128, 128, scale=0.5)
    creatures['pig'] = build_dir4_creature('pig', 4, 128, 128, scale=0.5)
    creatures['chicken'] = build_dir4_creature('chicken', 4, 32, 32, scale=1.0)
    creatures['boar'] = build_dir4_creature('boar', 3, 64, 64, scale=1.0)
    creatures['crab'] = build_dir4_creature('crab', 3, 48, 64, scale=1.0)
    creatures['snake'] = build_dir4_creature('snake', 3, 32, 32, scale=1.3)

    # Purchased HAS sheets replace the free-art creatures wholesale.
    if os.path.isdir(HEROIC):
        creatures.update(build_has_creatures())
        build_has_ui()

    td_images = {}
    tiles_td = build_topdown(frames, td_images)
    if os.path.isdir(HEROIC):
        build_has_spellfx(frames, td_images)

    manifest = {
        'tileW': 64, 'tileH': 32,
        'td': TD, 'tdScale': TD_SCALE,
        'images': {
            'terrain': 'terrain.png',
            'building': 'building.png',
            'snowtrees': 'snowtrees.png',
            'swamptrees': 'swamptrees.png',
            **td_images,
            **{c['img']: f"creatures/{c['img']}.png" for c in creatures.values()},
            **{'w_' + k: f'creatures/weapons/{k}.png'
               for k in creatures['player'].get('overlays', {})},
        },
        'frames': frames,
        'tiles': tiles,
        'tilesTD': tiles_td,
        'creatures': creatures,
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print('wrote', os.path.join(OUT, 'manifest.json'))

    apply_overrides()


# ---- hand-editing workflow: export to art/, override from art/ ----------------
#
# Every finished PNG under client/assets/ can be replaced by dropping an
# edited copy (same relative path, same pixel size) under art/overrides/.
# --export writes editable copies plus *.guide.png sheets that draw the
# frame grid on top, so Photoshop/Figma users can see exactly where each
# animation cell or terrain frame sits.

def asset_pngs():
    for dirpath, _, files in os.walk(OUT):
        for fn in sorted(files):
            if fn.endswith('.png'):
                full = os.path.join(dirpath, fn)
                yield os.path.relpath(full, OUT), full


def apply_overrides():
    src = os.path.join(ART, 'overrides')
    if not os.path.isdir(src):
        return
    applied = 0
    for rel, full in asset_pngs():
        ov = os.path.join(src, rel)
        if not os.path.exists(ov):
            continue
        edited = Image.open(ov).convert('RGBA')
        current = Image.open(full)
        if edited.size != current.size:
            print(f'!! override {rel}: size is {edited.size}, expected {current.size} — '
                  'skipped. Keep the canvas size; the manifest depends on it.')
            continue
        edited.save(full)
        applied += 1
        print('override applied:', rel)
    if applied:
        print(f'{applied} override(s) applied from art/overrides/')


GUIDE_GRID = (255, 0, 255, 160)   # magenta frame lines
GUIDE_BAND = (0, 200, 255, 200)   # cyan animation-band separators


def export_editable():
    from PIL import ImageDraw
    with open(os.path.join(OUT, 'manifest.json')) as f:
        manifest = json.load(f)
    dest = os.path.join(ART, 'editable')

    # editable copies of every atlas
    for rel, full in asset_pngs():
        out = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        Image.open(full).save(out)

    def guide_for(rel):
        img = Image.open(os.path.join(OUT, rel)).convert('RGBA')
        return img, ImageDraw.Draw(img)

    def save_guide(img, rel):
        out = os.path.join(dest, rel[:-4] + '.guide.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        img.save(out)

    # creature atlases: cell grid, one row per facing, labelled anim bands
    for name, c in manifest['creatures'].items():
        rel = manifest['images'][c['img']]
        img, draw = guide_for(rel)
        w, h = img.size
        for x in range(0, w + 1, c['cellW']):
            draw.line([(x, 0), (x, h)], fill=GUIDE_GRID)
        for y in range(0, h + 1, c['cellH']):
            draw.line([(0, y), (w, y)], fill=GUIDE_GRID)
        for anim, a in c['anims'].items():
            x = a['start'] * c['cellW']
            draw.line([(x, 0), (x, h)], fill=GUIDE_BAND, width=2)
            draw.text((x + 3, 2), f"{anim} x{a['frames']}", fill=GUIDE_BAND)
        if c.get('dirs', 1) > 1:
            for row in range(c['dirs']):
                draw.text((2, row * c['cellH'] + c['cellH'] - 12), f'dir {row}', fill=GUIDE_GRID)
        save_guide(img, rel)

    # frame atlases (terrain, buildings, tinted trees): outline + name each frame
    by_img = {}
    for fname, fr in manifest['frames'].items():
        by_img.setdefault(fr['img'], []).append((fname, fr))
    for img_key, frames in by_img.items():
        rel = manifest['images'][img_key]
        img, draw = guide_for(rel)
        for fname, fr in frames:
            draw.rectangle([fr['x'], fr['y'], fr['x'] + fr['w'] - 1, fr['y'] + fr['h'] - 1],
                           outline=GUIDE_GRID)
            draw.text((fr['x'] + 2, fr['y'] + 1), fname, fill=GUIDE_BAND)
        save_guide(img, rel)

    write_art_readme()
    print('exported editable art + guides to', dest)


def write_art_readme():
    os.makedirs(ART, exist_ok=True)
    with open(os.path.join(ART, 'README.md'), 'w') as f:
        f.write('''# Editing Shardlands art by hand

The game draws everything from the PNG atlases in `client/assets/` (laid out
by `client/assets/manifest.json`). This folder is the round-trip for editing
them in Photoshop, Figma, Aseprite or any other image editor.

## Workflow

1. `python3 tools/build-assets.py --export`
   - `art/editable/` — a copy of every atlas, ready to open and edit
   - next to each atlas, a `*.guide.png` overlay drawing the frame grid:
     magenta lines are frame/cell boundaries, cyan marks animation bands
     (`stance`/`run`/`melee`) with their frame counts, and each creature row
     is one of the 8 facing directions
2. Edit the PNG (not the guide). Keep:
   - **the exact canvas size** — the manifest stores pixel rectangles
   - **each frame inside its cell** — use the guide as a reference layer
   - **transparent background** (straight alpha, no matte)
3. Save your edited file to `art/overrides/<same relative path>`,
   e.g. `art/overrides/creatures/goblin.png` or `art/overrides/terrain.png`.
4. `python3 tools/build-assets.py` — rebuilds everything, then stamps your
   overrides on top. Refresh the browser; no code changes needed.

Overrides are permanent until you delete the file from `art/overrides/`:
every rebuild reapplies them, so source-art updates never clobber your work.

## Photoshop notes

- Open the atlas from `art/editable/`, drag the matching `.guide.png` in as a
  top reference layer, set it to ~50% opacity, and lock it.
- Hide the guide layer before exporting: File > Export As > PNG,
  with transparency on and the image size untouched (1x).

## Figma notes

- Drag the atlas PNG onto the canvas, then drop the `.guide.png` on top of it
  at the same position as a reference (set 50% opacity, lock it).
- Work at 100% zoom multiples with "Pixel preview" on (Ctrl/Cmd+Shift+P) so
  pixels stay crisp.
- To export: select only the atlas frame (hide the guide), Export > PNG at
  **1x** — Figma must not resample the image.

## Adding brand-new art

New creatures/tiles need a manifest entry, which comes from the recipes in
`tools/build-assets.py` (see `build_creature`, `build_dir4_creature` and the
`tiles` table in `main()`). Add a recipe there, then use this same override
flow to refine the result by hand.

## Licensing

Only freely licensed or original art may ship — see
`client/assets/CREDITS.md`. Never copy Ultima Online assets; EA owns them.
If you add art from a new source, credit it in CREDITS.md.
''')


if __name__ == '__main__':
    import sys
    if '--export' in sys.argv:
        export_editable()
    else:
        main()
