# Editing Shardlands art by hand

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

## The world builder's prop catalog

Every usable object sprite from the purchased packs is cut, deduplicated
and packed into `client/assets/props-extra.png`, grouped by category for
the in-game world builder's palettes (`manifest.propCategories`). Two
folder tiers let you edit or extend it:

- **Edit an existing prop** — run
  `python3 tools/build-assets.py --export-props` to dump every catalog
  entry as a loose PNG under `tools/asset-src/props/<category>/<name>.png`
  (gitignored: they derive from the paid packs). Edit any of them in
  Photoshop/Figma/Aseprite; the next plain build uses your version.
- **Add your own prop** — drop an original PNG into
  `art/props/<category>/<name>.png` (committed — your own work only).
  16 px of source = one tile in-game; larger images span more tiles,
  anchored bottom-centre. The folder name becomes (or joins) a palette
  category, and the prop is placeable as `prop.<name>`.

Names are `<category><n>` in scan order, so keep new catalog regions
appended at the end in `PROP_REGIONS` — placed props reference names.

## Licensing

Only freely licensed or original art may ship — see
`client/assets/CREDITS.md`. Never copy Ultima Online assets; EA owns them.
If you add art from a new source, credit it in CREDITS.md.
