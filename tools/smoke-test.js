'use strict';

// In-process smoke test for the server game logic. Run with:
//   node tools/smoke-test.js

const assert = require('assert');
const { Game } = require('../server/game');
const { TILE } = require('../server/world');

function fakeWs() {
  return { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
}

console.time('boot');
const game = new Game();
console.timeEnd('boot');
const ws = fakeWs();

// -- auth ---------------------------------------------------------------------
game.handle(ws, { t: 'join', email: 'not-an-email', password: 'secret1', name: 'Smoke' });
assert(ws.sent.some((m) => m.t === 'reject' && /email/.test(m.reason)), 'rejects bad email');

ws.sent.length = 0;
game.handle(ws, { t: 'join', email: 'smoke@test.dev', password: 'secret1', name: 'Smoke Tester' });
const welcome = ws.sent.find((m) => m.t === 'welcome');
assert(welcome, 'registered and joined');
assert(welcome.vendors && welcome.vendors.length >= 5, 'welcome lists the vendors of the realm');
assert(welcome.mini && welcome.mini.d, 'welcome carries the minimap overview');
assert(welcome.buildings.length > 10, 'welcome lists buildings for roofs');
assert(!welcome.map.tiles, 'tiles are not shipped wholesale');
const p = ws.player;
assert.strictEqual(p.pots.heal, 1, 'new characters start with one heal potion');

// Wrong password.
const ws2 = fakeWs();
game.handle(ws2, { t: 'join', email: 'smoke@test.dev', password: 'wrongpw', name: '' });
assert(ws2.sent.some((m) => m.t === 'reject' && /password/i.test(m.reason)), 'rejects wrong password');

// Taken character name on a fresh account.
const ws3 = fakeWs();
game.handle(ws3, { t: 'join', email: 'other@test.dev', password: 'secret2', name: 'Smoke Tester' });
assert(ws3.sent.some((m) => m.t === 'reject' && /taken/.test(m.reason)), 'rejects duplicate character name');

// Same account can't be in the world twice.
const ws4 = fakeWs();
game.handle(ws4, { t: 'join', email: 'smoke@test.dev', password: 'secret1', name: '' });
assert(ws4.sent.some((m) => m.t === 'reject' && /already in the world/.test(m.reason)), 'one session per character');

// -- chunk streaming -------------------------------------------------------------
ws.sent.length = 0;
game.handle(ws, { t: 'chunks', l: [[0, 0], [5, 7]] });
const chunks = ws.sent.filter((m) => m.t === 'chunk');
assert.strictEqual(chunks.length, 2, 'requested chunks are served');
assert.strictEqual(Buffer.from(chunks[0].d, 'base64').length, 64 * 64, 'chunk payload is 64x64 tiles');

// -- vendor -------------------------------------------------------------------
const vendor = welcome.vendors[0];
ws.sent.length = 0;
p.x = 5;
p.y = 5; // far corner: ocean, nobody around
game.handleBuy(p, 'heal');
assert(ws.sent.some((m) => m.t === 'sys' && /far/.test(m.text)), 'rejects distant buyer');

p.x = vendor.x;
p.y = vendor.y - 1;
const goldBefore = p.gold;
game.handleBuy(p, 'heal');
assert.strictEqual(p.gold, goldBefore - vendor.goods[0].price, 'gold deducted');
assert.strictEqual(p.pots.heal, 2, 'heal potion added');

// -- drinking -----------------------------------------------------------------
p.hp = 10;
game.handleDrink(p, 'heal');
assert(p.hp >= 35 && p.pots.heal === 1, 'heal potion restores health');
ws.sent.length = 0;
game.handleDrink(p, 'heal');
assert(ws.sent.some((m) => m.t === 'sys' && /wait/.test(m.text)), 'potion cooldown enforced');

// -- resource depletion ----------------------------------------------------------
let tree = null;
outer:
for (let y = game.map.h / 2 - 200; y < game.map.h / 2 + 200; y++) {
  for (let x = game.map.w / 2 - 200; x < game.map.w / 2 + 200; x++) {
    if (game.map.tiles[y * game.map.w + x] === TILE.TREE &&
        game.map.tiles[y * game.map.w + x + 1] === TILE.GRASS) {
      tree = { x, y };
      break outer;
    }
  }
}
assert(tree, 'found a tree to chop');
p.x = tree.x + 1;
p.y = tree.y;
p.skills.lumberjacking = 100;
ws.sent.length = 0;
for (let i = 0; i < 10; i++) {
  p.swingAt = 0;
  game.handleGather(p);
  if (game.map.tiles[tree.y * game.map.w + tree.x] === TILE.GRASS) break;
}
assert.strictEqual(game.map.tiles[tree.y * game.map.w + tree.x], TILE.GRASS,
  'tree depletes after a few harvests');
assert(ws.sent.some((m) => m.t === 'tile' && m.x === tree.x && m.y === tree.y), 'tile change broadcast');

const key = tree.x + ',' + tree.y;
game.depleted.get(key).respawnAt = 0;
game.respawnResources(Date.now());
assert.strictEqual(game.map.tiles[tree.y * game.map.w + tree.x], TILE.TREE, 'tree regrows');

// -- loot drops -------------------------------------------------------------------
game.rollLoot({ kind: 'dragon', x: p.x, y: p.y });
assert([...game.drops.values()].some((d) => d.x === p.x && d.y === p.y), 'dragon loot dropped');
const goldBeforeLoot = p.gold;
game.pickupDrops(p);
assert(p.gold > goldBeforeLoot, 'walked over the gold pile and picked it up');

// -- secrets ----------------------------------------------------------------------
const caches = game.map.secrets.filter((s) => s.type === 'cache');
assert(caches.length >= 8, 'treasure caches exist');
assert([...game.drops.values()].some((d) => d.cacheIdx !== undefined), 'caches are stocked');

const portal = game.map.secrets.find((s) => s.type === 'portal');
assert(portal, 'portals exist');
p.dead = false;
p.x = portal.x + 1;
p.y = portal.y;
p.moveAt = 0;
p.portalAt = 0;
game.handleMove(p, -1, 0);
assert(p.x === portal.tx && p.y === portal.ty, 'stone circle teleports the player to its twin');

const whisper = game.map.secrets.find((s) => s.type === 'whisper');
assert(whisper, 'whisper spots exist');
ws.sent.length = 0;
p.x = whisper.x + 1;
p.y = whisper.y;
p.moveAt = 0;
game.checkSecrets(p, Date.now());
assert(ws.sent.some((m) => m.t === 'sys' && m.text === whisper.text), 'whispers reach the wanderer');

// -- interest management -------------------------------------------------------------
p.x = game.map.spawn.x;
p.y = game.map.spawn.y;
ws.sent.length = 0;
game.tick();
const st = ws.sent.find((m) => m.t === 'state');
assert(st, 'tick sends state');
const far = st.mobs.find((m) => Math.abs(m.x - p.x) > 60 || Math.abs(m.y - p.y) > 60);
assert(!far, 'state only contains nearby entities');

console.log('smoke test: all assertions passed');
process.exit(0);
