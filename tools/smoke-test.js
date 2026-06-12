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
assert.strictEqual(p.items.length, 1, 'new character has the starter dagger');
assert.strictEqual(p.weapon, p.items[0].uid, 'starter dagger is equipped');

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
const mira = welcome.vendors.find((v) => v.goods.some((g) => g.item === 'heal'));
const healIdx = mira.goods.findIndex((g) => g.item === 'heal');
ws.sent.length = 0;
p.x = 5;
p.y = 5; // far corner: ocean, nobody around
game.handleBuy(p, healIdx);
assert(ws.sent.some((m) => m.t === 'sys' && /far/.test(m.text)), 'rejects distant buyer');

p.x = mira.x;
p.y = mira.y - 1;
const goldBefore = p.gold;
// indexes are per-vendor; Mira must be the nearest vendor here
game.handleBuy(p, healIdx);
assert.strictEqual(p.gold, goldBefore - mira.goods[healIdx].price, 'gold deducted');
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

// -- weapons --------------------------------------------------------------------
assert(welcome.weapons && welcome.weapons.sword, 'welcome carries the weapon catalog');

const bren = welcome.vendors.find((v) => v.forge);
assert(bren, 'the blacksmith exists');
p.x = bren.x;
p.y = bren.y - 1;
p.gold = 2000;
const swordIdx = bren.goods.findIndex((g) => g.type === 'weapon' && g.item === 'sword' && g.q === 1);
game.handleBuy(p, swordIdx);
const sword = p.items.find((i) => i.id === 'sword');
assert(sword, 'bought a longsword');
assert.strictEqual(p.gold, 2000 - 120, 'weapon price deducted');
assert.strictEqual(sword.dur, 110, 'common longsword durability');

// quality math: a Fine dagger hits harder and lasts longer than a Shoddy one
const fine = game.makeItem(p, 'dagger', 2);
assert.strictEqual(fine.maxDur, Math.round(90 * 1.4), 'quality scales durability');

// equip + minSkill gate
game.handleEquip(p, sword.uid);
assert.strictEqual(p.weapon, sword.uid, 'sword equipped');
const gs = game.makeItem(p, 'greatsword', 1);
p.items.push(gs);
ws.sent.length = 0;
game.handleEquip(p, gs.uid);
assert(p.weapon === sword.uid, 'greatsword rejected below 60 swordsmanship');
assert(ws.sent.some((m) => m.t === 'sys' && /Swordsmanship/.test(m.text)), 'skill gate message');
p.items = p.items.filter((i) => i.uid !== gs.uid);

// crafting consumes materials and yields an instance
p.ore = 20;
p.logs = 10;
const goldBeforeCraft = p.gold;
const itemsBefore = p.items.length;
game.handleCraft(p, 'sword');
assert.strictEqual(p.ore, 12, 'craft consumed ore');
assert.strictEqual(p.logs, 7, 'craft consumed logs');
assert.strictEqual(p.gold, goldBeforeCraft - 30, 'craft consumed gold');
assert.strictEqual(p.items.length, itemsBefore + 1, 'craft yielded a weapon');

// durability: wear it down against a sturdy chicken and watch it shatter
if (p.weapon !== sword.uid) game.handleEquip(p, sword.uid);
sword.dur = 1;
p.skills.swordsmanship = 100;
const dummy = { id: 999999, kind: 'chicken', x: p.x + 1, y: p.y, hp: 99999, maxhp: 99999,
  target: 0, moveAt: 0, swingAt: 0, spawner: { alive: new Set() } };
game.mobs.set(dummy.id, dummy);
p.target = dummy.id;
ws.sent.length = 0;
for (let i = 0; i < 500 && p.items.some((it) => it.uid === sword.uid); i++) {
  p.swingAt = 0;
  game.meleeTick(p, Date.now());
}
assert(!p.items.some((it) => it.uid === sword.uid), 'worn sword shattered');
assert.strictEqual(p.weapon, null, 'shattered weapon unequipped');
assert(ws.sent.some((m) => m.t === 'fx' && m.kind === 'break'), 'break fx sent');
assert(ws.sent.some((m) => m.t === 'sys' && /shatters/.test(m.text)), 'shatter message');
game.mobs.delete(dummy.id);
p.target = 0;

// selling refunds 40% of the quality-adjusted price
p.items.push(fine);
const goldBeforeSell = p.gold;
game.handleSell(p, fine.uid);
assert.strictEqual(p.gold, goldBeforeSell + Math.floor(40 * 2.0 * 0.4), 'sell refunds 40%');
assert(!p.items.some((i) => i.uid === fine.uid), 'sold item removed');

// bosses always drop a weapon; full packs leave it on the ground
game.rollLoot({ kind: 'bonelord', x: p.x, y: p.y });
assert([...game.drops.values()].some((d) => d.item === 'weapon' && d.x === p.x), 'boss dropped a weapon');
while (p.items.length < 10) p.items.push(game.makeItem(p, 'dagger', 0));
game.pickupDrops(p);
assert([...game.drops.values()].some((d) => d.item === 'weapon' && d.x === p.x),
  'weapon drop stays when the pack is full');
p.items.length = 3;
game.pickupDrops(p);
assert(p.items.some((i) => ['battleaxe', 'greatsword'].includes(i.id)), 'picked up the boss weapon');

// persistence round-trip
game.persistPlayer(p);
const rec = game.records[p.key];
assert.strictEqual(rec.items.length, p.items.length, 'items persisted');
assert.strictEqual(rec.weapon, p.weapon, 'equipped weapon persisted');
assert.strictEqual(rec.itemUid, p.itemUid, 'uid counter persisted');

// -- the legend -------------------------------------------------------------------
const secretDefs = Object.entries(welcome.weapons).filter(([, d]) => d.secret);
assert.strictEqual(secretDefs.length, 1, 'exactly one secret weapon exists');
const legendId = secretDefs[0][0];
const guard = game.spawners.find((sp) => (sp.respawnMs || 0) >= 30 * 60_000);
assert(guard, 'its guardian sleeps somewhere');
assert(Math.hypot(guard.x - game.map.w / 2, guard.y - game.map.h / 2) > 700,
  'far from civilisation');

p.items.length = 0;
p.weapon = null;
game.persistPlayer(p);
game.rollLoot({ kind: guard.kind, x: p.x, y: p.y });
const legendDrop = [...game.drops.values()].find((d) => d.item === 'weapon' && d.w.id === legendId);
assert(legendDrop, 'the guardian yields the legend');
game.pickupDrops(p);
assert(p.items.some((i) => i.id === legendId), 'claimed it');
game.persistPlayer(p);

// while anyone owns it, the guardian guards nothing
game.rollLoot({ kind: guard.kind, x: p.x + 1, y: p.y });
assert(![...game.drops.values()].some((d) => d.item === 'weapon' && d.w.id === legendId),
  'there is only one');

// it cannot be forged
const oreBefore = p.ore;
game.handleCraft(p, legendId);
assert.strictEqual(p.ore, oreBefore, 'no forge will make another');

// -- storytellers --------------------------------------------------------------------
const bards = welcome.vendors.filter((v) => v.stories);
assert(bards.length >= 3, 'bards live in the world');
assert(bards.every((b) => b.stories.length >= 2), 'every teller knows tales');
const allTales = bards.flatMap((b) => b.stories.map((t) => t.join(' ')));
const villageNames = ['Northhold', 'Saltmere', 'Eastgate', 'Wyrmwick', 'Thornbury',
  'Duskwell', 'Ferndale', 'Mossgrove', 'Amberford'];
assert(allTales.some((t) => villageNames.some((v) => t.includes(v))),
  'tales name real places');
assert(allTales.some((t) => /rim of the world/.test(t)), 'one tale points at the legend');

// the Dawn-Knight's road: rumor -> squire -> waymarks
const edda = bards.find((b) => b.name === 'Loremaster Edda');
assert(edda.stories.some((t) => t.join(' ').includes('Dawn-Knight')), 'Edda starts the road');
const squire = welcome.vendors.find((v) => v.name === 'Caol the Grey');
assert(squire && squire.stories.some((t) => t.join(' ').includes('Dawnbreaker')),
  'the squire names the blade');
const waymarks = game.map.secrets.filter((s2) => s2.type === 'whisper' && /waymark/.test(s2.text));
assert(waymarks.length >= 2, 'waymark stones line the road');

const bard = bards[0];
p.x = bard.x;
p.y = bard.y + 1;
p.storyAt = 0;
ws.sent.length = 0;
game.handleStory(p, bard.id);
const firstLine = ws.sent.find((m) => m.t === 'chat' && m.id === bard.id);
assert(firstLine, 'the bard begins a tale at once');
ws.sent.length = 0;
game.handleStory(p, bard.id); // mid-tale: politely ignored
assert(!ws.sent.some((m) => m.t === 'chat'), 'no interrupting the teller');

// -- /teleport ----------------------------------------------------------------------
p.dead = false;
p.x = 100;
p.y = 100;
p.teleportAt = 0;
ws.sent.length = 0;
game.handleSay(p, '/teleport');
assert.strictEqual(p.x, game.map.spawn.x, 'teleported home (x)');
assert.strictEqual(p.y, game.map.spawn.y, 'teleported home (y)');
assert(!ws.sent.some((m) => m.t === 'chat'), 'commands are not broadcast as speech');
ws.sent.length = 0;
game.handleSay(p, '/teleport');
assert(ws.sent.some((m) => m.t === 'sys' && /winds are spent/.test(m.text)), 'teleport cooldown enforced');
p.dead = true;
p.teleportAt = 0;
ws.sent.length = 0;
game.handleSay(p, '/teleport');
assert(ws.sent.some((m) => m.t === 'sys' && /dead must walk/.test(m.text)), 'no teleporting while dead');
p.dead = false;
ws.sent.length = 0;
game.handleSay(p, '/dance');
assert(ws.sent.some((m) => m.t === 'sys' && /Unknown command/.test(m.text)), 'unknown commands answered');

// -- batch B: gear slots, ranged, spells, bosses ----------------------------------
p.dead = false;
p.gold = 5000;
p.items.length = 0;
p.weapon = null;
const tunic = game.makeItem(p, 'leatherarmor', 1);
const shield = game.makeItem(p, 'kiteshield', 1);
p.items.push(tunic, shield);
p.skills.swordsmanship = 60;
game.handleEquip(p, tunic.uid);
assert.strictEqual(p.armor, tunic.uid, 'tunic equips to the chest slot');
game.handleEquip(p, shield.uid);
assert.strictEqual(p.offhand, shield.uid, 'shield equips offhand');

// armor blunts; shield can block (force both branches)
p.hp = 60;
const r = Math.random;
Math.random = () => 0.99; // no block, no wear
game.hitPlayer(p, 10, 'a test');
assert.strictEqual(p.hp, 60 - (10 - 2), 'leather DR applied');
Math.random = () => 0.01; // guaranteed block
p.hp = 60;
game.hitPlayer(p, 10, 'a test');
assert.strictEqual(p.hp, 60, 'shield blocked the blow');
Math.random = r;

// ranged: a longbow without arrows refuses, with arrows it fires
const bow = game.makeItem(p, 'longbow', 1);
p.items.push(bow);
game.handleEquip(p, bow.uid);
assert.strictEqual(p.weapon, bow.uid, 'longbow equipped');
const dummy2 = { id: 999998, kind: 'chicken', x: p.x + 5, y: p.y, hp: 9999, maxhp: 9999,
  target: 0, moveAt: 0, swingAt: 0, spawner: { alive: new Set() } };
game.mobs.set(dummy2.id, dummy2);
p.target = dummy2.id;
p.arrows = 0;
p.swingAt = 0;
p.nagAt = 0;
ws.sent.length = 0;
game.meleeTick(p, Date.now());
assert(ws.sent.some((m) => m.t === 'sys' && /out of arrows/.test(m.text)), 'no arrows, no shot');
p.arrows = 3;
p.swingAt = 0;
const hpBefore = dummy2.hp;
for (let i = 0; i < 20 && dummy2.hp === hpBefore; i++) { p.swingAt = 0; game.meleeTick(p, Date.now()); }
assert(dummy2.hp < hpBefore, 'arrow found its mark');
assert(p.arrows < 3, 'arrows are consumed');

// poison dot ticks a mob down
p.skills.magery = 60;
p.mana = 50;
p.castAt = 0;
game.handleCast(p, 'poison', dummy2.id);
assert(dummy2.poison, 'poison applied');
dummy2.poison.nextAt = 0;
const hpBeforeDot = dummy2.hp;
game.mobTick(dummy2, Date.now());
assert(dummy2.hp < hpBeforeDot, 'poison ticked');

// bless raises damage output
p.castAt = 0;
p.mana = 50;
game.handleCast(p, 'bless', 0);
assert(p.buffUntil > Date.now(), 'bless active');

// bosses queue a telegraphed slam
const bossDummy = { id: 999997, kind: 'bonelord', x: p.x + 3, y: p.y, hp: 500, maxhp: 500,
  target: p.id, moveAt: Infinity, swingAt: Infinity, spawner: { alive: new Set() } };
game.mobs.set(bossDummy.id, bossDummy);
game.pendingAoes.length = 0;
game.mobTick(bossDummy, Date.now());
assert(game.pendingAoes.length === 1, 'boss telegraphed a slam');
game.pendingAoes[0].at = 0;
p.hp = 80;
p.x = game.pendingAoes[0].x;
p.y = game.pendingAoes[0].y;
Math.random = () => 0.99;
game.tick();
Math.random = r;
assert(p.hp < 80, 'standing in the telegraph hurts');
game.mobs.delete(dummy2.id);
game.mobs.delete(bossDummy.id);
p.target = 0;

console.log('smoke test: all assertions passed');
process.exit(0);
