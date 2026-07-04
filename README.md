# Shardlands

A small browser MMO in the spirit of **Ultima Online**: one persistent shared
world, named characters that survive logout, use-based skills, real-time
combat, magic, gathering, crime, and overhead speech — all over a single
WebSocket, drawn in the pixel style of KingRabbit's **Heroic Asset Series**.

No build step, no framework. One Node.js server (two dependencies: `ws` for
the socket, `better-sqlite3` for saves) and a plain HTML5 canvas client.
Playable on phones: the HUD compacts and a virtual joystick appears under
your thumb.

## Run it

```sh
npm install
npm start          # listens on :8080 (override with PORT=...)
```

Open http://localhost:8080 in as many browser tabs (or machines) as you like —
each tab is a player in the same world. Sign in with email and password; your
account and character are created on first login (passwords scrypt-hashed,
and a rotating week-long session token walks you straight back in next time).

Before pushing changes, run the test suite:

```sh
node tools/smoke-test.js
```

## How to play

| Input | Action |
| --- | --- |
| WASD / arrows | walk (or click the ground to path-walk there) |
| Click a monster | attack it (melee auto-swings when adjacent) |
| `Space` | attack the nearest hostile (never auto-picks townsfolk or livestock) |
| `1` `2` `3` | Magic Arrow · Fireball · Greater Heal |
| `6` `7` `8` | Bless · Poison · Energy Bolt |
| `9` `0` `H` | Ice Bolt (slows) · Chain Lightning (arcs) · Haste |
| `4` / `5` | drink a heal / mana potion |
| `B` | bandage your wounds |
| `G` | chop / mine / fish, depending on what you stand beside |
| `I` `C` `M` `O` | backpack · character sheet · world map · settings |
| `F` | fullscreen |
| `Enter` | chat — your words appear above your head, UO style |
| `/home` | recall to your bound city shrine |

On touch screens: drag anywhere to steer, tap to walk/attack/talk, and a
second finger can tap-attack while you steer.

Name plates tell you who's who: **gold** for bosses, **blue** for friends of
the realm, **pale tan** for harmless beasts, **red** for everything that
bites.

## The world

A 2048×2048 island, generated deterministically from a seed and streamed in
chunks as you explore — dressed edge to edge in the Heroic Asset Series
style: interlocking mountain ranges, tufted biome transitions, an animated
sea, and a 20-minute day/night cycle where braziers, hearths and windows
push back the dark.

- **Briarhaven**, the walled capital: a snug plaza with fountain, statue,
  market kiosk and brazier-lit king's way; smithy, inn, chapel and mage
  tower — **step on any doorstep to go inside**, where the shopkeepers
  keep shop by the hearth. The royal castle joins the north rampart, and
  its gate is a stair down into the crown's undercroft.
- **Three more walled cities** — Frosthelm under the snows, Sunwatch by the
  desert, Mirehold on the swamp road. Walls are sanctuary… from monsters.
  **Guards can be fought** — but strike one and the whole watch answers
  (*"Criminal! To arms!"*), and the walls are precisely their jurisdiction.
  Touching a city shrine binds your `/home` recall.
- **A ring of villages**, each with a shop, a lodge, a green with signpost
  and lamps, and a road back to the capital. Bards hold court in the inn
  common rooms — some of their tales point at real treasure, with true
  directions.
- **Seven dungeons** beneath the world: barrow-deeps under the ruined keeps,
  a wolfden grotto in the northern ice, the sunken warren the goblins dug
  and the **lizardmen took**, and the royal undercroft. Dark tunnels, dense
  keepers, a hoard at the deepest point. The dead can walk back out — the
  stairs work for ghosts.
- **The factions keep their corners**: dwarf clans work half the quarries
  (miners, halberdier wardens, rune-priests — the other half fell to the
  ettins), wood-elf groves guard the deepest pines with rangers, dryads and
  an elder treant, harpies wheel over the crags, and the orc warbands
  answer to **Gruk, Warlord of the Wastes** at his banner camp — his
  wolf-riders lead every raid on a village.
- **The restless dead**: shambling corpses haunt the barrows by day; after
  dark the **ghosts rise with them**. The **Crimson Count** sleeps beneath
  the second ruined keep, and every wound he deals feeds him.
- **Six named terrors** in all (Skarg the Goblin King, the Bone Lord,
  Greyfang the Wolf King, the Crimson Count, Gruk, and Vyrmaur the Undying
  at the rim of the world), plus dragon roosts, a White Stag for the
  patient, and world events — warbands marching on villages with rewards
  for the defenders.
- **Secrets everywhere**: twin stone circles that teleport, whispering
  places, buried caches, treasure maps dropped by monsters, waymark stones
  along a dead knight's road, and one legendary blade no forge will ever
  make again.
- **Weapons and armor** in five quality tiers (Shoddy → Masterwork), all
  visible on your character and in every shop, forge and backpack as their
  own icons. Buy, loot, or **forge your own** from ore and logs. Steel
  wears out — every blade eventually shatters, so keep a spare.

## UO-style systems

- **Use-based skills** — Swordsmanship, Tactics, Magery, Healing,
  Lumberjacking, Mining, Fishing, Cooking, Blacksmithy. No levels, no XP
  bar: skills rise as you use them, gains rarer near the 100 cap, titles at
  grandmastery. Stats (STR/DEX/INT) creep up the same way.
- **Magic with power words** — nine spells that shout *In Por Ylem* /
  *Vas Ort Grav* / *Rel Por* overhead, cost mana, fizzle at low Magery, and
  land with animated impacts.
- **Death is a journey** — die and you become a ghost; walk to a shrine to
  live again.
- **Persistence** — accounts and characters (position, stats, skills, gold,
  items, bound home) live in SQLite (`data/shardlands.db`), written through
  on disconnect and on SIGINT/SIGTERM.

## Deploying to Railway

The repo is Railway-ready (`railway.json`; `PORT` honoured):

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway domain
```

Attach a volume mounted at `/app/data` so accounts, characters and world
edits survive redeploys.

| Env var | Purpose |
| --- | --- |
| `PORT` | HTTP/WebSocket port (default 8080) |
| `EDITOR_PASSWORD` | arms the world builder's password gate (else loopback-only) |
| `GITHUB_TOKEN` | repo-scoped token for the builder's *Publish* button |
| `GITHUB_REPO` | e.g. `owner/shardlands`, the publish target |
| `GITHUB_BRANCH` | publish branch (default `main`) |

## The world builder

A password-protected WYSIWYG editor for the live world, at
`http://<server>/editor.html`:

- **See the real game** — zoom past ~20px/tile and the builder renders with
  the game's own pass: real terrain, animated water, props as sprites,
  spawners as the creature itself, ghost previews under the cursor.
- **Place anything** — paint every terrain; a searchable catalog of **every
  object sprite in the packs** (~700, grouped: trees, mountains, plants,
  furniture, town, faction, landmarks…); creature camps with live preview;
  whole **buildings** (lawn, footprint, doorstep, furnished interior and
  its door portal in one click); **portals** between any two points —
  dungeons included; whispers and caches. Erase removes anything, worldgen
  or yours.
- **Save applies to the running server instantly** — mobs spawn, props
  appear, minimaps refresh for every connected player; no restart. Edits
  persist in `data/edits.json` on the volume.
- **Publish** commits the overlay to `world/edits.json` on GitHub (see env
  vars above), or *Download edits.json* for a manual commit. At boot the
  server loads whichever copy is newer.

The world stays 100% procedurally generated — edits are an overlay stamped
on top at boot, so regeneration never destroys hand-made work.

## The art pipeline

The renderer is top-down square, **16px art at 3×** (48px tiles), sliced
from the purchased KingRabbit Heroic Asset Series packs by
`tools/build-assets.py` (needs `pillow` + `numpy`). The raw packs live in
`tools/asset-src/heroic/` — **gitignored, never commit paid art**; only
game-composed atlases ship, credited in `client/assets/CREDITS.md`. Without
the packs the build falls back to an original procedural tileset, so the
public repo always builds.

Hand-editing and adding art (full guide in `art/README.md`):

- `python3 tools/build-assets.py --export` dumps every atlas plus grid
  guides to `art/editable/`; save edits to `art/overrides/…` and rebuild —
  overrides are stamped on top of every rebuild.
- `python3 tools/build-assets.py --export-props` stages every catalog prop
  as a loose PNG for editing; your **own original props** go in
  `art/props/<category>/` and join the builder's palettes automatically.

## Architecture

```
server/
  index.js         HTTP static + WebSocket + routing, one port
  game.js          authoritative simulation: 10 Hz tick, combat, AI, skills,
                   live edit application
  world.js         seeded worldgen (terrain, cities, dungeons, factions),
                   placeBuilding, the edits overlay
  editor.js        world-builder auth, edit API, GitHub publish
  persist.js       SQLite storage (accounts + characters)
client/
  game.js          canvas renderer, click-to-move, input → intents
  tiles-render.js  the shared ground pass (game and builder draw through it)
  assets.js        sprite atlas loader (falls back to flat shading)
  audio.js         all-procedural WebAudio: SFX + a chiptune OST per biome
  editor.*         the world builder
tools/
  smoke-test.js    in-process test suite (run before pushing)
  build-assets.py  regenerates client/assets/ from the source packs
```

The server is fully authoritative — clients send intents (`move`, `say`,
`attack`, `cast`, `gather`, …) and render broadcast state. Mob AI aggros,
chases, leashes home, socially pulls its campmates, and respawns; guards
rally as one; night raises the dead.

## Credits

Art from the **Heroic Asset Series** by **Aleksandr Makarov**
([@IKnowKingRabbit](https://iknowkingrabbit.itch.io)) — purchased packs,
composed into game atlases per the pack license. Full attribution and
licensing rules in `client/assets/CREDITS.md`. No Ultima Online assets are
used; EA owns those.
