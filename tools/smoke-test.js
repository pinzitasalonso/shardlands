'use strict';

// In-process smoke test for the server game logic. Run with:
//   node tools/smoke-test.js

const assert = require('assert');
const { Game } = require('../server/game');
const { TILE } = require('../server/world');

function fakeWs() {
  return { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
}

const game = new Game();
const ws = fakeWs();

// -- join ---------------------------------------------------------------------
game.join(ws, 'Smoke Tester');
const welcome = ws.sent.find((m) => m.t === 'welcome');
assert(welcome, 'got welcome');
assert(welcome.vendors && welcome.vendors.length >= 1, 'welcome lists vendors');
const p = ws.player;
assert.strictEqual(p.pots.heal, 1, 'new characters start with one heal potion');

// -- vendor -------------------------------------------------------------------
const vendor = welcome.vendors[0];

// Too far away: buying should fail politely.
ws.sent.length = 0;
game.handleBuy(p, 'heal');
assert(ws.sent.some((m) => m.t === 'sys' && /far/.test(m.text)), 'rejects distant buyer');
assert.strictEqual(p.gold, 100, 'no gold taken when too far');

// Stand next to the vendor and shop for real.
p.x = vendor.x;
p.y = vendor.y - 1;
game.handleBuy(p, 'heal');
assert.strictEqual(p.gold, 55, 'heal potion costs 45');
assert.strictEqual(p.pots.heal, 2, 'heal potion added');
game.handleBuy(p, 'mana');
assert.strictEqual(p.gold, 20, 'mana potion costs 35');
assert.strictEqual(p.pots.mana, 1, 'mana potion added');
ws.sent.length = 0;
game.handleBuy(p, 'heal'); // only 20 gold left
assert(ws.sent.some((m) => m.t === 'sys' && /dost not have/.test(m.text)), 'rejects poor buyer');
assert.strictEqual(p.pots.heal, 2, 'no potion without gold');

// -- drinking -------------------------------------------------------------------
p.hp = 10;
game.handleDrink(p, 'heal');
assert(p.hp >= 35 && p.pots.heal === 1, 'heal potion restores health');
ws.sent.length = 0;
game.handleDrink(p, 'heal');
assert(ws.sent.some((m) => m.t === 'sys' && /wait/.test(m.text)), 'potion cooldown enforced');
assert.strictEqual(p.pots.heal, 1, 'cooldown does not consume a potion');
p.drinkAt = 0;
p.mana = 0;
game.handleDrink(p, 'mana');
assert(p.mana >= 20 && p.pots.mana === 0, 'mana potion restores mana');

// -- resource depletion -----------------------------------------------------------
// Stand next to a tree, with maxed skill so every chop succeeds.
let tree = null;
outer:
for (let y = 1; y < game.map.h - 1; y++) {
  for (let x = 1; x < game.map.w - 1; x++) {
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
assert(ws.sent.some((m) => m.t === 'tile' && m.x === tree.x && m.y === tree.y && m.tile === TILE.GRASS),
  'tile change broadcast to clients');
assert(p.logs >= 2, 'got logs before the tree fell');

// Respawn: due now, nobody standing on it.
const key = tree.x + ',' + tree.y;
game.depleted.get(key).respawnAt = 0;
game.respawnResources(Date.now());
assert.strictEqual(game.map.tiles[tree.y * game.map.w + tree.x], TILE.TREE, 'tree regrows');

// Respawn blocked while occupied.
p.swingAt = 0;
game.handleGather(p); // chop again...
game.resources.set(key, 1);
p.swingAt = 0;
game.handleGather(p); // ...and deplete it
assert.strictEqual(game.map.tiles[tree.y * game.map.w + tree.x], TILE.GRASS, 'tree depleted again');
p.x = tree.x;
p.y = tree.y; // stand where it grew
game.depleted.get(key).respawnAt = 0;
game.respawnResources(Date.now());
assert.strictEqual(game.map.tiles[tree.y * game.map.w + tree.x], TILE.GRASS,
  'tree does not regrow under a player');

// -- loot drops -------------------------------------------------------------------
// Dragons always leave gold behind; step on the pile to claim it.
game.rollLoot({ kind: 'dragon', x: p.x, y: p.y });
assert(game.drops.size >= 1, 'dragon loot dropped');
const goldBefore = p.gold;
game.pickupDrops(p);
assert(p.gold > goldBefore, 'walked over the gold pile and picked it up');
assert.strictEqual([...game.drops.values()].filter((d) => d.x === p.x && d.y === p.y).length, 0,
  'claimed drops are removed');

console.log('smoke test: all assertions passed');
process.exit(0);
