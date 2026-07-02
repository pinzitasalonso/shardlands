# Shardlands

A small browser-based MMO in the spirit of **Ultima Online**: one persistent
shared world, named characters that survive logout, use-based skills, real-time
combat, magic, gathering, and overhead speech — all over a single WebSocket.

No build step, no framework. One Node.js server (two dependencies: `ws` for
the socket, `better-sqlite3` for saves) and a plain HTML5 canvas client.
Playable on phones too: the HUD compacts and a virtual joystick appears
under your thumb.

## Run it

```sh
npm install
npm start          # listens on :8080 (override with PORT=...)
```

Open http://localhost:8080 in as many browser tabs (or machines) as you like —
each tab is a player in the same world.

## Deploying to Railway

The repo is Railway-ready (`railway.json` + the `PORT` env var are honoured):

```bash
npm i -g @railway/cli
railway login
railway init     # create a project from this directory
railway up       # build & deploy
railway domain   # mint a public https URL
```

Player accounts and characters live in `data/`. Containers are ephemeral, so
attach a volume (Railway dashboard → service → Volumes) mounted at `/app/data`
to keep accounts across deploys.

## The world

A 2048×2048 island, generated deterministically from a seed and streamed to
the client in chunks as you explore:

- **Briarhaven**, the town at the crossroads, with a stone plaza, four
  buildings, **Mira the Alchemist** selling potions, and the **glowing ankh
  shrine** — walk your ghost onto it to resurrect.
- **Nine villages** scattered across the island, each with a potion vendor
  and a road back to the capital — all buildings wear proper roofs, which
  fade away when you step inside.
- **Three walled cities** — Frosthelm under the northern snows, Sunwatch by
  the desert, Mirehold on the swamp road — plus the capital. Stone walls,
  gates, full vendor plazas, and **town guards** who cut down anything
  hostile that slips in. Cities are **sanctuary** (nothing hunts you inside
  the walls), and touching a city shrine **binds your recall**: `/home`
  carries you back from anywhere.
- **Six dungeons** beneath the world: four barrow-deeps under the ruined
  keeps, a wolfden grotto cracked open in the northern ice, and a goblin-dug
  sunken warren in the mires — dark tunnels, dense with keepers, a hoard at
  the deepest point. The music changes when you go under.
- **Ruined keeps** crawling with skeletons, watchtowers, deep pine and oak
  forests, deadwood groves, a vast southeastern desert, **snowfields**
  with frosted pines across the far north, and lowland **mires** where
  bog serpents, marsh crabs and wild boar hunt among the drowned trees.
- **Secrets**: twin stone circles that teleport travellers between them,
  treasure caches in the far corners of the world, whispering places, a
  hermit with suspiciously cheap potions, and dragon hoards beside the
  three dragon roosts.
- **Storytellers** hold court by the inn hearths — click them and listen:
  some of their tales are tavern nonsense, but some point at real treasure,
  real doors and real dangers, with true directions.
- A thousand creatures roam: deer herds, wolf packs, livestock, named
  **villagers** who gossip at passers-by, goblin warrens, skeleton barrows,
  orc warbands — and three **named bosses** (Skarg the Goblin King, the Bone
  Lord, Greyfang the Wolf King) that respawn slowly and always drop gems.
- The wilds are dotted with **farmsteads, campsites (fires still burning),
  quarries, menhirs and hermit huts** — many hide treasure or trouble.
- **Weapons**: daggers to greatswords in five quality tiers (Shoddy to
  Masterwork), visible in your character's hand. Buy them from **Bren the
  Blacksmith** in the capital, loot them from monsters (bosses carry the
  best), or **forge your own** from ore and logs — your gathering skills
  decide the quality. Steel wears out: every weapon eventually **shatters**,
  so keep a spare.
- Monsters sometimes **drop loot** — gold, potions, materials, even gems —
  walk over it to pick it up. Press **I** for your backpack. Trees and rocks
  **deplete** after a few harvests and regrow.
- Sign in with **email and password**; your account and character are created
  on first login (passwords are scrypt-hashed). A rotating week-long session
  token means reopening the game walks you straight back into the world.

## The map editor (internal tool)

The shard ships with a visual world editor. With the server running, open:

```
http://localhost:8080/editor.html
```

It only answers from **localhost** — on a remote deployment it refuses unless
you explicitly start the server with `EDITOR=1`.

What you can do:

- **Look around** — the whole 2048×2048 island top-down, in the minimap
  palette. Mouse-wheel zooms toward the cursor (from full-island overview to
  a single-tile grid), right-drag or hold space to pan, and the **Go to**
  dropdown jumps straight to any city or village. Markers show everything in
  the world: ▲ props, ● mob spawners, ◆ secrets, ■ vendors — dim if worldgen
  placed them, bright if you did.
- **Paint tiles** — pick the *Paint* tool, choose a tile from the palette
  (grass, road, water, walls, …) and a brush size (1/3/5/9), then drag.
- **Place things** — *Prop* drops wells/tables/stools/campfires; *Spawner*
  places a mob camp (pick the kind, count and radius in the sidebar);
  *Whisper* asks for a line of text travellers will hear at that spot;
  *Cache* buries a treasure cache.
- **Erase** — removes whatever is under the cursor: your own edits vanish
  outright, and world-generated props/spawners are marked for removal.
- **Undo** — `Ctrl+Z`, one paint stroke or placement at a time.
- **Save to shard** — writes everything to `world/edits.json`.

How it persists: the world stays 100% procedurally generated, and your edits
are an **overlay** stamped on top of worldgen at every boot — so regenerating
the world (or changing the seed) never destroys hand-made work. **Commit
`world/edits.json`** to keep your changes. Tile paints go live for connected
players the moment you save; new props, spawners and secrets appear on the
next server restart.

## Editing the sprites (Photoshop / Figma / any editor)

The renderer is top-down square: **16px tiles drawn at 3×** (48px on
screen), sized for classic pixel-art packs. Terrain and scenery live in
`ground16.png` / `objects16.png` — currently procedural placeholders,
generated in the exact atlas format that purchased pixel art (e.g.
KingRabbit's packs) will use. Drop bought sheets into
`tools/asset-src/heroic/` (gitignored — **never commit paid art**) and swap
the drawing code in `build_topdown()` for slicing recipes; nothing else in
the engine changes.

All art is generated into `client/assets/` by `tools/build-assets.py`
(needs `pillow` + `numpy`). To restyle it by hand:

```sh
python3 tools/build-assets.py --export
```

That writes two things into `art/editable/`:

1. an editable copy of **every atlas PNG** (terrain, buildings, each creature)
2. a `*.guide.png` next to each one with the frame grid drawn on top —
   magenta lines are frame/cell boundaries, cyan marks the animation bands
   (`stance` / `run` / `melee`, with frame counts), and each creature row is
   one of the 8 facing directions

Then:

1. Open the atlas PNG in your editor and drop the matching guide on top as a
   ~50%-opacity locked reference layer. In Figma, turn on *Pixel preview* and
   work at 100% zoom multiples.
2. Edit the pixels. Keep the **exact canvas size**, keep each frame inside its
   cell, keep the background transparent.
3. Hide the guide layer and export as PNG at **1x** (no resampling).
4. Save it to `art/overrides/<same relative path>` — e.g.
   `art/overrides/creatures/goblin.png` or `art/overrides/terrain.png`.
5. Rebuild: `python3 tools/build-assets.py` — your file is stamped over the
   generated atlas. Refresh the browser; no code changes needed.

Overrides are reapplied on **every** rebuild, so source-art updates never
clobber your work; delete the file from `art/overrides/` to go back to the
generated version. Full details (including how to add brand-new creatures)
are in `art/README.md`. Licensing rules live in `client/assets/CREDITS.md` —
free-licensed art only, never actual Ultima Online assets.

## How to play

| Input | Action |
| --- | --- |
| WASD / arrows | walk (click the ground to path-walk there instead) |
| Click a monster | attack it (melee auto-swings when adjacent) |
| `Space` | attack the nearest hostile (re-engages your current target first; never auto-picks townsfolk or livestock) |
| `1` / `2` / `3` | cast Magic Arrow / Fireball / Greater Heal |
| `6` / `7` / `8` | cast Bless / Poison / Energy Bolt |
| `4` / `5` | drink a heal / mana potion |
| `B` | bandage your wounds |
| `G` | chop / mine / fish, depending on what you stand beside |
| `I` / `C` / `M` / `O` | backpack / character sheet / world map / settings |
| `F` | fullscreen |
| `Enter` | chat — your words appear above your head, UO style |
| `/home` | recall to your bound city shrine |

On touch screens: drag anywhere to steer with the joystick, tap to
walk/attack/talk, and a second finger can tap-attack while you steer.

## UO-style systems

- **Use-based skills** — Swordsmanship, Tactics, Magery, Healing,
  Lumberjacking, Mining, Fishing, Cooking, Blacksmithy. No levels, no XP
  bar: skills rise as you use them
  ("Your Swordsmanship has risen to 43.5"), with gains getting rarer as you
  approach the 100 cap. Stats (STR/DEX/INT) creep up the same way.
- **Magic with power words** — casting shouts *In Por Ylem* / *Vas Flam* /
  *In Vas Mani* overhead, costs mana, and can fizzle at low Magery.
- **Death is a journey** — die and you become a ghost; walk to the shrine in
  Briarhaven to be resurrected.
- **Persistence** — accounts and characters (position, stats, skills, gold,
  items, bound home) live in SQLite (`data/shardlands.db`), written through
  on every character creation and disconnect, and on SIGINT/SIGTERM.

## Architecture

```
server/
  index.js    HTTP static files + WebSocket + the editor API on one port
  world.js    seeded worldgen (terrain, cities, dungeons) + the edits overlay
  game.js     authoritative simulation: 10 Hz tick, combat, AI, skills
  persist.js  SQLite storage (accounts + characters, JSON migration on boot)
client/
  game.js     canvas renderer, A* click-to-move, input → intents
  assets.js   sprite atlas loader (drawing falls back to flat shading)
  audio.js    all-procedural WebAudio: SFX + a seven-track chiptune OST
  editor.*    the internal visual map editor
tools/
  smoke-test.js      in-process test suite (run before pushing)
  build-assets.py    regenerates client/assets/ from free-licensed sources
```

The server is fully authoritative — clients only send intents (`move`, `say`,
`attack`, `cast`, `bandage`, `gather`) and render the broadcast state. Mob AI
aggros within range, chases, leashes back to its spawn, and respawns ~20s
after dying.
