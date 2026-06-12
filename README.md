# Shardlands

A small browser-based MMO in the spirit of **Ultima Online**: one persistent
shared world, named characters that survive logout, use-based skills, real-time
combat, magic, gathering, and overhead speech — all over a single WebSocket.

No build step, no framework. One Node.js server (`ws` is the only dependency)
and a plain HTML5 canvas client.

## Run it

```sh
npm install
npm start          # listens on :8080 (override with PORT=...)
```

Open http://localhost:8080 in as many browser tabs (or machines) as you like —
each tab is a player in the same world.

## The world

A 2048×2048 island, generated deterministically from a seed and streamed to
the client in chunks as you explore:

- **Briarhaven**, the town at the crossroads, with a stone plaza, four
  buildings, **Mira the Alchemist** selling potions, and the **glowing ankh
  shrine** — walk your ghost onto it to resurrect.
- **Nine villages** scattered across the island, each with a potion vendor
  and a road back to the capital — all buildings wear proper roofs, which
  fade away when you step inside.
- **Ruined keeps** crawling with skeletons, watchtowers, deep pine and oak
  forests, deadwood groves, a vast southeastern desert.
- **Secrets**: twin stone circles that teleport travellers between them,
  treasure caches in the far corners of the world, whispering places, a
  hermit with suspiciously cheap potions, and dragon hoards beside the
  three dragon roosts.
- Monsters sometimes **drop loot** — gold, potions, materials, even gems —
  walk over it to pick it up. Press **I** for your backpack. Trees and rocks
  **deplete** after a few harvests and regrow.
- Sign in with **email and password**; your account and character are created
  on first login (passwords are scrypt-hashed, stored in `data/accounts.json`).

## How to play

| Input | Action |
| --- | --- |
| WASD / arrows | walk (click ground to walk there instead) |
| Click a monster | attack it (melee auto-swings when adjacent) |
| `1` / `2` / `3` | cast Magic Arrow / Fireball / Greater Heal |
| `B` | bandage your wounds |
| `G` | chop a tree / mine a rock face you're standing beside |
| `Enter` | chat — your words appear above your head, UO style |

## UO-style systems

- **Use-based skills** — Swordsmanship, Tactics, Magery, Healing,
  Lumberjacking, Mining. No levels, no XP bar: skills rise as you use them
  ("Your Swordsmanship has risen to 43.5"), with gains getting rarer as you
  approach the 100 cap. Stats (STR/DEX/INT) creep up the same way.
- **Magic with power words** — casting shouts *In Por Ylem* / *Vas Flam* /
  *In Vas Mani* overhead, costs mana, and can fizzle at low Magery.
- **Death is a journey** — die and you become a ghost; walk to the shrine in
  Briarhaven to be resurrected.
- **Persistence** — characters (position, stats, skills, gold, resources) are
  saved to `data/players.json` and restored by name on next login. A secret
  token in your browser's localStorage proves the name is yours.

## Architecture

```
server/
  index.js    HTTP static files + WebSocket endpoint on one port
  world.js    seeded terrain generation, walkability
  game.js     authoritative simulation: 10 Hz tick, combat, AI, skills
  persist.js  flat-file character storage
client/
  game.js     canvas renderer, interpolation, input → intents
```

The server is fully authoritative — clients only send intents (`move`, `say`,
`attack`, `cast`, `bandage`, `gather`) and render the broadcast state. Mob AI
aggros within range, chases, leashes back to its spawn, and respawns ~20s
after dying.
