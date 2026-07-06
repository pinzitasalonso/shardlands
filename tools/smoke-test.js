'use strict';

// In-process smoke test for the server game logic. Run with:
//   node tools/smoke-test.js

const assert = require('assert');
const { Game } = require('../server/game');
const { TILE, nearestWalkable } = require('../server/world');

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
// towns are whole pre-drawn sprites now; only the hermit's hovel (and any
// future tile-built shelter) still needs a client-drawn roof
assert(welcome.buildings.length >= 1, 'welcome lists the remaining tile-built roofs');
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

// pick a whisper with no portal nearby (cave-mouth whispers sit on top of one,
// and the portal would whisk the listener away first)
const whisper = game.map.secrets.find((s) => s.type === 'whisper' &&
  !game.map.secrets.some((o) => o.type === 'portal' &&
    Math.abs(o.x - s.x) <= 2 && Math.abs(o.y - s.y) <= 2));
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
p.arrows = 20; // enough that twenty 78% shots can't all miss in practice
p.swingAt = 0;
const hpBefore = dummy2.hp;
for (let i = 0; i < 20 && dummy2.hp === hpBefore; i++) { p.swingAt = 0; game.meleeTick(p, Date.now()); }
assert(dummy2.hp < hpBefore, 'arrow found its mark');
assert(p.arrows < 20, 'arrows are consumed');

// poison dot ticks a mob down (a fizzle is 5% per cast; ten can't all fizzle)
p.skills.magery = 60;
for (let i = 0; i < 10 && !dummy2.poison; i++) {
  p.mana = 50;
  p.castAt = 0;
  game.handleCast(p, 'poison', dummy2.id);
}
assert(dummy2.poison, 'poison applied');
dummy2.poison.nextAt = 0;
const hpBeforeDot = dummy2.hp;
game.mobTick(dummy2, Date.now());
assert(dummy2.hp < hpBeforeDot, 'poison ticked');

// bless raises damage output (GM magery: the fizzle roll cannot fail)
p.skills.magery = 100;
p.castAt = 0;
p.mana = 50;
game.handleCast(p, 'bless', 0);
assert(p.buffUntil > Date.now(), 'bless active');

// bosses queue a telegraphed slam (fought outside the walls — cities are
// sanctuary now, and a boss correctly refuses to target anyone inside one)
const wildB = nearestWalkable(game.map, 700, 700);
p.x = wildB.x;
p.y = wildB.y;
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

// -- batch C: trades, deeds, regional materials -------------------------------------
// fishing by the shore
let shore = null;
outer2:
for (let y = 900; y < 1150; y++) {
  for (let x = 900; x < 1150; x++) {
    if (game.map.tiles[y * 2048 + x] !== TILE.WATER &&
        [TILE.GRASS, TILE.SAND].includes(game.map.tiles[y * 2048 + x]) &&
        game.map.tiles[y * 2048 + x + 1] === TILE.WATER) {
      shore = { x, y };
      break outer2;
    }
  }
}
assert(shore, 'found a shoreline');
p.x = shore.x;
p.y = shore.y;
p.skills.fishing = 100;
p.fish = 0;
for (let i = 0; i < 10 && !p.fish; i++) { p.swingAt = 0; game.handleGather(p); }
assert(p.fish > 0, 'caught a fish');
assert(p.deeds.angler, 'angler deed awarded');

// cooking needs a campfire; eating heals over time
ws.sent.length = 0;
game.handleCook(p);
assert(ws.sent.some((m) => /campfire/.test(m.text)), 'no cooking without a fire');
const fire = game.map.props.find((pr) => pr.name === 'fx.campfire');
p.x = fire.x;
p.y = fire.y;
p.skills.cooking = 100;
p.fish = 3;
p.food = 0;
for (let i = 0; i < 10 && !p.food; i++) game.handleCook(p);
assert(p.food > 0, 'cooked a meal');
game.handleEat(p);
assert(p.fedUntil > Date.now(), 'well fed');

// blacksmithy governs the forge and earns its deed
const bren2 = welcome.vendors.find((v) => v.forge);
p.x = bren2.x;
p.y = bren2.y - 1;
p.ore = 30;
p.logs = 20;
p.gold = 1000;
p.items.length = 0;
delete p.deeds.smith;
p.skills.blacksmithy = 20;
game.handleCraft(p, 'dagger');
assert(p.items.length === 1, 'forged at the anvil');
assert(p.deeds.smith, 'smith deed awarded');

// regional mats gate the top recipes
p.mats.frostwood = 0;
ws.sent.length = 0;
game.handleCraft(p, 'greatsword');
assert(ws.sent.some((m) => /frostwood/.test(m.text)), 'greatsword wants frostwood');
p.mats.frostwood = 2;
p.ore = 30;
p.logs = 20;
game.handleCraft(p, 'greatsword');
assert(p.items.some((i) => i.id === 'greatsword'), 'frostwood greatsword forged');
assert.strictEqual(p.mats.frostwood, 0, 'frostwood consumed');

// /forget is a gold sink that resets a skill
p.gold = 500;
game.handleSay(p, '/forget cooking');
assert.strictEqual(p.skills.cooking, 20, 'cooking forgotten');
assert.strictEqual(p.gold, 400, 'the ritual cost 100 gold');

// grandmaster title rides the wire
p.skills.fishing = 100;
ws.sent.length = 0;
game.sendYou(p);
const you = ws.sent.find((m) => m.t === 'you');
assert(/Grandmaster/.test(you.title), 'grandmaster title earned');

// -- batch D: dungeons, raids, treasure maps, rare spawns, tech ----------------------
// the barrow-deeps: cave mouths at the keeps descend into carved caverns
let caveTiles = 0;
for (let i = 0; i < game.map.tiles.length; i++) {
  if (game.map.tiles[i] === TILE.CAVE) caveTiles++;
}
assert(caveTiles >= 500, 'the barrow-deeps are carved (' + caveTiles + ' cave tiles)');
const cavePortals = game.map.secrets.filter((s) => s.type === 'portal' && s.cave);
assert(cavePortals.length >= 8, 'cave mouths and exits exist in pairs');
const mouth = cavePortals.find((cp) =>
  game.map.tiles[cp.ty * game.map.w + cp.tx] === TILE.CAVE && cp.ty < 64);
assert(mouth, 'a cave mouth leads underground');
p.dead = false;
p.x = mouth.x;
p.y = mouth.y;
p.portalAt = 0;
game.checkSecrets(p, Date.now());
assert(p.x === mouth.tx && p.y === mouth.ty, 'stepped through the cave mouth');
assert.strictEqual(game.map.tiles[p.y * game.map.w + p.x], TILE.CAVE, 'and stands underground');
assert(game.spawners.some((sp) => sp.kind === 'skeleton' && sp.y < 64),
  'the dead walk the deeps');

// the white stag wanders
assert(game.spawners.filter((sp) => sp.kind === 'whitestag').length >= 3,
  'white stags wander the wild');

// treasure maps: loot -> carry -> stand on the X -> the cache gives way
const r2 = Math.random;
Math.random = () => 0; // every loot row fires; rand() picks minimums
p.x = game.map.spawn.x;
p.y = game.map.spawn.y;
p.tmaps = [];
p.items.length = 0;
game.rollLoot({ kind: 'orc', x: p.x, y: p.y });
Math.random = r2;
assert([...game.drops.values()].some((d) => d.item === 'tmap'), 'the orc carried a map');
game.pickupDrops(p);
assert.strictEqual(p.tmaps.length, 1, 'the map is in the pack');
const digIdx = p.tmaps[0];
const digSpot = game.map.secrets[digIdx];
assert.strictEqual(digSpot.type, 'cache', 'the X marks a cache');
for (const [id, d] of [...game.drops]) {
  if (d.cacheIdx === digIdx) game.drops.delete(id); // someone got here first
}
p.x = digSpot.x;
p.y = digSpot.y;
p.hp = 100000; // whatever guards the spot must not interrupt the dig
ws.sent.length = 0;
game.tick();
assert.strictEqual(p.tmaps.length, 0, 'the map is spent at the X');
assert(ws.sent.some((m) => m.t === 'sys' && /X marks the spot/.test(m.text)), 'the dig speaks');
assert([...game.drops.values()].some((d) => d.cacheIdx === digIdx), 'the cache restocked');

// world events: a raid marches on a village, breaks, and pays out
game.event = null;
const r3 = Math.random;
Math.random = () => 0.1;
game.maybeStartEvent();
Math.random = r3;
assert(game.event, 'a raid begins');
assert(game.event.ids.size >= 4, 'a warband marches');
for (const id of game.event.ids) {
  const m = game.mobs.get(id);
  assert(m.dest, 'raiders march with purpose');
  assert.strictEqual(m.aggroBoost, 12, 'raiders look for trouble');
}
const raidVillage = game.event.village;
for (const id of [...game.event.ids]) {
  const m = game.mobs.get(id);
  game.mobs.delete(id);
  m.spawner.alive.delete(id);
}
ws.sent.length = 0;
game.tickEvent(Date.now());
assert.strictEqual(game.event, null, 'the raid is broken');
assert(ws.sent.some((m) => m.t === 'sys' && /raid on .* is broken/.test(m.text)), 'victory rings out');
assert([...game.drops.values()].some((d) =>
  Math.abs(d.x - raidVillage.x) <= 1 && Math.abs(d.y - raidVillage.y) <= 1),
  'the villagers leave a reward');

// tech: SQLite persistence and tick timing for /health
const persist = require('../server/persist');
assert.strictEqual(persist.usingSqlite(), true, 'saves go to SQLite');
// a new character must be on disk the moment it exists: a crash between
// account and record writes must never strand the account
assert(persist.load()[p.key], 'fresh character is on disk immediately');
game.tick();
assert(game.lastTickMs > 0, 'tick time is measured for /health');

// -- batch E: cities, guards, sanctuary, home binding, more dungeons -----------------
assert(game.map.cities && game.map.cities.length >= 4, 'walled cities stand');
assert(game.map.cities.some((c) => c.name === 'Briarhaven'), 'the capital counts among them');
assert.strictEqual(cavePortals.length, 14, 'seven dungeons, each with a mouth and an exit');
assert(game.spawners.filter((sp) => sp.kind === 'guard').length >= 4, 'guards hold the walls');

// sanctuary: nothing hunts a traveller inside the walls...
p.dead = false;
p.hp = 100000;
p.x = game.map.spawn.x;
p.y = game.map.spawn.y;
const prowler = { id: 999996, kind: 'wolf', x: p.x + 1, y: p.y, hp: 26, maxhp: 26,
  homeX: p.x + 1, homeY: p.y, target: 0, moveAt: Infinity, swingAt: Infinity,
  spawner: { alive: new Set() } };
game.mobs.set(prowler.id, prowler);
game.tick();
assert.strictEqual(prowler.target, 0, 'sanctuary holds inside the walls');
// ...but the wilds are another matter (regression: playerGrid must be built)
const wild = nearestWalkable(game.map, 1024, 1500);
assert(!game.inCity(wild.x, wild.y), 'found true wilderness');
p.x = wild.x;
p.y = wild.y;
prowler.x = wild.x + 1;
prowler.y = wild.y;
prowler.homeX = wild.x + 1;
prowler.homeY = wild.y;
game.tick();
assert.strictEqual(prowler.target, p.id, 'the wilds still hunt you');
game.mobs.delete(prowler.id);
p.target = 0;

// guards cut down intruders and leave the spoils
const post = { x: game.map.spawn.x + 3, y: game.map.spawn.y };
const sentinel = { id: 999995, kind: 'guard', x: post.x, y: post.y, homeX: post.x, homeY: post.y,
  hp: 160, maxhp: 160, target: 0, foe: 0, moveAt: 0, swingAt: 0, scanAt: 0, chatAt: Infinity,
  spawner: { alive: new Set() } };
const intruder = { id: 999994, kind: 'orc', x: post.x + 1, y: post.y, hp: 48, maxhp: 48,
  homeX: post.x + 1, homeY: post.y, target: 0, moveAt: Infinity, swingAt: Infinity,
  spawner: { alive: new Set() } };
game.mobs.set(sentinel.id, sentinel);
game.mobs.set(intruder.id, intruder);
game.mobTick(sentinel, Date.now());
assert.strictEqual(sentinel.foe, intruder.id, 'the sentinel marks the intruder');
assert(intruder.hp < 48, 'and strikes');
intruder.hp = 1;
sentinel.swingAt = 0;
game.mobTick(sentinel, Date.now());
assert(!game.mobs.has(intruder.id), 'the intruder falls');
game.mobs.delete(sentinel.id);

// touching a city shrine binds /home there
const city = game.map.cities.find((c) => c.name !== 'Briarhaven');
p.home = null;
p.x = city.x;
p.y = city.y - 1;
p.moveAt = 0;
ws.sent.length = 0;
game.handleMove(p, 0, -1);
assert(p.home && p.home.x === city.x && p.home.y === city.y - 2, 'the shrine binds home');
assert(ws.sent.some((m) => m.t === 'sys' && m.text.includes(city.name)), 'and says whose walls these are');
p.x = 100;
p.y = 100;
p.teleportAt = 0;
game.handleSay(p, '/home');
assert(p.x === city.x && p.y === city.y - 2, 'recall carries you to your bound city');
game.persistPlayer(p);
assert.strictEqual(game.records[p.key].home.x, city.x, 'home survives a save');

// -- batch F: session tokens, social pulls, leash-evade ------------------------------
const wsT = fakeWs();
game.handle(wsT, { t: 'join', email: 'token@test.dev', password: 'secret1', name: 'Token Tester' });
const wT = wsT.sent.find((m) => m.t === 'welcome');
assert(wT && wT.token && wT.token.length >= 32, 'welcome carries a session token');
game.leave(wsT);
const wsT2 = fakeWs();
game.handle(wsT2, { t: 'join', token: wT.token });
const wT2 = wsT2.sent.find((m) => m.t === 'welcome');
assert(wT2, 'the token alone signs back in — no password');
assert(wT2.token && wT2.token !== wT.token, 'tokens rotate on every sign-in');
game.leave(wsT2);
const wsT3 = fakeWs();
game.handle(wsT3, { t: 'join', token: wT.token });
assert(wsT3.sent.some((m) => m.t === 'reject' && m.expired), 'rotated-out tokens are dead');

// social pull: wound one orc and its campmate joins the fight
const packSp = { alive: new Set(), x: wild.x, y: wild.y, r: 4, kind: 'orc' };
const orcA = { id: 999993, kind: 'orc', x: wild.x, y: wild.y, hp: 48, maxhp: 48,
  homeX: wild.x, homeY: wild.y, target: 0, moveAt: Infinity, swingAt: Infinity, spawner: packSp };
const orcB = { id: 999992, kind: 'orc', x: wild.x + 2, y: wild.y, hp: 48, maxhp: 48,
  homeX: wild.x + 2, homeY: wild.y, target: 0, moveAt: Infinity, swingAt: Infinity, spawner: packSp };
game.mobs.set(orcA.id, orcA);
game.mobs.set(orcB.id, orcB);
packSp.alive.add(orcA.id);
packSp.alive.add(orcB.id);
game.damageMob(p, orcA, 1);
assert.strictEqual(orcB.target, p.id, 'the camp answers the first blow');
game.mobs.delete(orcA.id);
game.mobs.delete(orcB.id);

// leash-evade: a mob kited far from home shrugs off its wounds and walks back
const kited = { id: 999991, kind: 'orc', x: wild.x + 25, y: wild.y, hp: 5, maxhp: 48,
  homeX: wild.x, homeY: wild.y, target: p.id, moveAt: 0, swingAt: Infinity,
  chatAt: Infinity, spawner: { alive: new Set() } };
game.mobs.set(kited.id, kited);
game.mobTick(kited, Date.now());
assert.strictEqual(kited.target, 0, 'the leash snaps the chase');
assert.strictEqual(kited.hp, 48, 'and the wounds close');
assert(kited.evading, 'it turns for home');
assert(kited.x < wild.x + 25, 'and walks');
game.mobs.delete(kited.id);
// raiders are exempt: the march on the village must not leash
const raider = { id: 999990, kind: 'orc', x: wild.x + 25, y: wild.y, hp: 5, maxhp: 48,
  homeX: wild.x, homeY: wild.y, target: p.id, aggroBoost: 12, moveAt: Infinity, swingAt: Infinity,
  chatAt: Infinity, spawner: { alive: new Set() } };
game.mobs.set(raider.id, raider);
game.mobTick(raider, Date.now());
assert.strictEqual(raider.hp, 5, 'raiders never evade-heal');
game.mobs.delete(raider.id);

// -- the map editor's overlay: hand edits stamp on top of worldgen -------------------
const { applyEdits } = require('../server/world');
const propCountBefore = game.map.props.length;
const firstProp = game.map.props[0];
const ec = applyEdits(game.map, {
  tiles: [[10, 10, TILE.ROAD], [-5, 3, TILE.ROAD], [11, 10, 99]],
  props: [{ x: 12, y: 10, name: 'prop.well' }],
  removeProps: [[firstProp.x, firstProp.y]],
  spawners: [{ kind: 'wolf', count: 3, x: 14, y: 10, r: 6 },
             { kind: 'notakind', count: 3, x: 15, y: 10, r: 6 }],
  secrets: [{ type: 'whisper', x: 16, y: 10, text: 'The editor was here.' }],
}, { validKinds: new Set(['wolf']) });
assert.strictEqual(ec.tiles, 1, 'only in-bounds, real tile ids paint');
assert.strictEqual(game.map.tiles[10 * game.map.w + 10], TILE.ROAD, 'painted tile landed');
assert.strictEqual(ec.spawners, 1, 'unknown mob kinds are refused');
assert.strictEqual(game.map.props.length, propCountBefore, 'one prop removed, one added');
assert(game.map.secrets.some((s) => s.type === 'whisper' && s.text === 'The editor was here.'),
  'edited whisper joined the world');

// -- the dead can climb out of the deeps ---------------------------------------------
const upStair = game.map.secrets.find((s) => s.type === 'portal' && s.cave && s.y < 64);
p.dead = true;
p.x = upStair.x + 1;
p.y = upStair.y;
p.moveAt = 0;
p.portalAt = 0;
game.handleMove(p, -1, 0);
assert(p.y >= 64, 'a ghost takes the stair back to the surface');
p.dead = false;
p.hp = 50;

// -- the new company: the restless dead, the crags, and the Count --------------------
const { MOB_KINDS } = require('../server/game');
for (const k of ['zombie', 'ghost', 'harpy', 'wolfrider', 'vampire']) {
  assert(MOB_KINDS[k], `${k} walks the world`);
  assert(game.map.spawners.some((sp) => sp.kind === k), `${k} has a home somewhere`);
}
assert(MOB_KINDS.vampire.vampiric, 'the Count feeds on what he wounds');
assert(game.map.spawners.filter((sp) => sp.kind === 'ghost').every((sp) => sp.nightOnly || sp.y < 64),
  'surface ghosts only rise at night; only the deeps hold them by day');
assert(game.map.spawners.some((sp) => sp.kind === 'vampire' && sp.y < 64),
  'the Count sleeps beneath a ruined keep');

// -- towns wear whole pre-drawn buildings now -----------------------------------------
for (const k of ['smithy', 'inn', 'healer', 'magetower', 'shop', 'lodge']) {
  assert(game.map.props.some((pr) => pr.name === 'prop.' + k),
    `somewhere a ${k} stands as one drawn piece`);
}

// -- and the towns are dressed: fountains, lamps, gardens ----------------------------
for (const k of ['fountain', 'lamp', 'statue', 'signpost', 'kiosk', 'flowers0', 'bush0']) {
  assert(game.map.props.some((pr) => pr.name === 'prop.' + k), `the towns keep their ${k}`);
}
assert(game.map.props.filter((pr) => pr.name === 'prop.lamp').length >= 10,
  'braziers light more than one street');

// -- and every house opens its door: doorstep portals into carved interiors ----------
const houseDoor = game.map.secrets.find((s) => s.type === 'portal' && s.ty > 44 && s.ty < 64);
assert(houseDoor, 'a doorstep leads to a room beneath the world');
p.dead = false;
p.hp = 50;
p.x = houseDoor.x + 1;
p.y = houseDoor.y;
p.moveAt = 0;
p.portalAt = 0;
game.handleMove(p, -1, 0);
assert(p.y > 44 && p.y < 64, 'stepping on the doorstep carries you inside');
assert(game.vendors.some((v) => v.y > 44 && v.y < 64), 'a shopkeeper keeps shop indoors');

// -- the factions keep their own corners of the world --------------------------------
for (const k of ['dwarf', 'dwarfguard', 'dwarfpriest', 'orcbrute', 'orcwarlord',
                 'elfranger', 'dryad', 'treant', 'lizardman', 'raptor']) {
  assert(MOB_KINDS[k], `${k} walks the world`);
  assert(game.map.spawners.some((sp) => sp.kind === k), `${k} has a home somewhere`);
}
assert(MOB_KINDS.dwarf.peaceful && MOB_KINDS.dwarfguard.guard,
  'the quarry clans are peaceful, and their wardens answer trouble');
assert(MOB_KINDS.elfranger.caster && MOB_KINDS.elfranger.caster.fx === 'arrow',
  'elf rangers shoot arrows, not sorcery');
assert(game.map.spawners.filter((sp) => sp.kind === 'orcwarlord').length === 1,
  'one warlord, one banner');
assert(game.map.spawners.some((sp) => sp.kind === 'lizardman' && sp.y < 64),
  'lizardmen hold the sunken warren');

// -- the watch can be fought, and the watch answers as one ---------------------------
p.dead = false;
p.hp = 200;
p.x = game.map.spawn.x;
p.y = game.map.spawn.y;
const watchSp = { alive: new Set(), x: p.x, y: p.y, r: 4, kind: 'guard' };
const g1 = { id: 999986, kind: 'guard', x: p.x + 1, y: p.y, hp: 160, maxhp: 160,
  homeX: p.x + 1, homeY: p.y, target: 0, foe: 0, moveAt: 0, swingAt: Infinity,
  chatAt: Infinity, spawner: watchSp };
const g2 = { id: 999985, kind: 'guard', x: p.x + 6, y: p.y, hp: 160, maxhp: 160,
  homeX: p.x + 6, homeY: p.y, target: 0, foe: 0, moveAt: 0, swingAt: Infinity,
  chatAt: Infinity, spawner: watchSp };
game.mobs.set(g1.id, g1);
game.mobs.set(g2.id, g2);
watchSp.alive.add(g1.id);
watchSp.alive.add(g2.id);
ws.sent.length = 0;
game.handleAttack(p, g1.id);
assert.strictEqual(p.target, g1.id, 'the watch can be challenged');
game.damageMob(p, g1, 5);
assert.strictEqual(g1.target, p.id, 'the struck guard fights back');
assert.strictEqual(g2.target, p.id, 'strike one guard and the whole watch answers');
assert(ws.sent.some((m) => m.t === 'sys' && /Criminal/.test(m.text)), 'the cry goes up');
// the walls are no sanctuary from the law: the guard closes in anyway
const gapBefore = Math.abs(g2.x - p.x);
game.mobTick(g2, Date.now());
assert.strictEqual(g2.target, p.id, 'the law hunts inside the walls');
assert(Math.abs(g2.x - p.x) < gapBefore, 'and closes the distance');
// but the townsfolk stay protected
const civi = [...game.mobs.values()].find((m) => m.kind === 'villager');
ws.sent.length = 0;
game.handleAttack(p, civi.id);
assert(ws.sent.some((m) => m.t === 'sys' && /crown's protection/.test(m.text)),
  'villagers remain under the crown\'s protection');
game.mobs.delete(g1.id);
game.mobs.delete(g2.id);
p.target = 0;
// pardon the tester: stand the real watch down before the next scenes
for (const m of game.mobs.values()) if (MOB_KINDS[m.kind] && MOB_KINDS[m.kind].guard) m.target = 0;

// -- the new words of power: frost, the arcing bolt, and borrowed speed --------------
p.skills.magery = 100; // at GM magery the fizzle roll (d100 > magery+35) cannot fail
p.mana = 200;
// clear the board so the bolt cannot arc into some passing world-mob instead
const savedMobs = [...game.mobs.entries()];
game.mobs.clear();
const spellSp = { alive: new Set(), x: p.x, y: p.y, r: 4, kind: 'orc' };
const frostee = { id: 999989, kind: 'orc', x: p.x + 1, y: p.y, hp: 500, maxhp: 500,
  homeX: p.x + 1, homeY: p.y, target: 0, moveAt: Infinity, swingAt: Infinity,
  chatAt: Infinity, spawner: spellSp };
const arcee = { id: 999988, kind: 'orc', x: p.x + 2, y: p.y, hp: 500, maxhp: 500,
  homeX: p.x + 2, homeY: p.y, target: 0, moveAt: Infinity, swingAt: Infinity,
  chatAt: Infinity, spawner: spellSp };
game.mobs.set(frostee.id, frostee);
game.mobs.set(arcee.id, arcee);
spellSp.alive.add(frostee.id);
spellSp.alive.add(arcee.id);

p.castAt = 0;
game.handleCast(p, 'icebolt', frostee.id);
assert(frostee.slowUntil > Date.now(), 'ice bolt leaves frost gripping the legs');
assert(frostee.hp < 500, 'and it bites');

p.castAt = 0;
const arceeHpBefore = arcee.hp;
game.handleCast(p, 'chainlightning', frostee.id);
assert(arcee.hp < arceeHpBefore, 'chain lightning arcs to the packmate');

p.castAt = 0;
game.handleCast(p, 'haste', 0);
assert(p.hasteUntil > Date.now(), 'haste quickens the caster');
game.mobs.clear();
for (const [id, m] of savedMobs) game.mobs.set(id, m);

// -- the world builder edits the running world ---------------------------------------
const { EDIT_INTERIOR_X0 } = require('../server/world');
assert(/[\\/]data[\\/]/.test(game.editsPath + '/'), 'edits live on the data volume');
const spot = { x: game.map.spawn.x + 30, y: game.map.spawn.y + 30 };
const overlay1 = {
  tiles: [[spot.x, spot.y, TILE.ROAD], [-9, 2, TILE.ROAD]],
  props: [{ x: spot.x + 1, y: spot.y, name: 'prop.trees0' }],
  spawners: [{ kind: 'wolf', count: 2, x: spot.x + 4, y: spot.y, r: 4 },
             { kind: 'notakind', count: 2, x: 1, y: 1, r: 3 }],
  secrets: [
    { type: 'portal', x: spot.x - 2, y: spot.y, tx: spot.x - 2, ty: spot.y + 5, door: true },
    { type: 'portal', x: 99999, y: 0, tx: 0, ty: 0 },
    { type: 'whisper', x: spot.x, y: spot.y + 2, text: 'Built by hand.' }],
  buildings: [{ x: spot.x + 8, y: spot.y, name: 'inn' },
              { x: 5, y: 5, name: 'notabuilding' }],
};
ws.sent.length = 0;
const mobsBefore = game.mobs.size;
const c1 = game.applyEditsLive(overlay1);
assert.strictEqual(c1.tiles, 1, 'in-bounds tile painted, out-of-bounds refused');
assert.strictEqual(c1.props, 1, 'catalog prop placed');
assert.strictEqual(c1.spawners, 1, 'real kind spawns, fake kind refused');
assert.strictEqual(c1.secrets, 2, 'good portal and whisper in, bad portal out');
assert.strictEqual(c1.buildings, 1, 'inn raised, nonsense refused');
assert.strictEqual(game.mobs.size, mobsBefore + 2, 'the wolves are alive right now');
assert(ws.sent.some((m) => m.t === 'tile'), 'players saw the tile change');
assert(ws.sent.some((m) => m.t === 'props'), 'players got the redressed props');
assert(ws.sent.some((m) => m.t === 'mini'), 'players got the fresh minimap');
assert(game.map.props.some((pr) => pr.name === 'prop.inn' && pr.x === spot.x + 8),
  'the inn sprite stands');
const builtDoor = game.map.secrets.find((s) => s.type === 'portal' && s.door &&
  s.x === spot.x + 8 && s.y === spot.y + 1);
assert(builtDoor && builtDoor.tx === EDIT_INTERIOR_X0 && builtDoor.ty > 44 && builtDoor.ty < 64,
  'its doorstep leads to the edit-interior strip');

// saving the same overlay again must change nothing (idempotent deltas)
ws.sent.length = 0;
const c2 = game.applyEditsLive(overlay1);
assert.strictEqual(c2.tiles + c2.props + c2.spawners + c2.secrets + c2.buildings + c2.removed, 0,
  'a repeat save is a no-op');
assert.strictEqual(game.mobs.size, mobsBefore + 2, 'nothing double-materialised');

// live removal of a worldgen secret is a tombstone, never a splice
const victim = game.map.secrets.find((s) => s.type === 'whisper' && !s.dead && s.y >= 64);
const victimIdx = game.map.secrets.indexOf(victim);
const overlay2 = { ...overlay1, removeSecrets: [[victim.x, victim.y]] };
game.applyEditsLive(overlay2);
assert(victim.dead === true, 'the whisper is silenced');
assert.strictEqual(game.map.secrets.indexOf(victim), victimIdx,
  'and every treasure-map index survives');

// dropping the spawner from the overlay despawns its flock
const overlay3 = { ...overlay2, spawners: [] };
game.applyEditsLive(overlay3);
assert.strictEqual(game.mobs.size, mobsBefore, 'the wolves went with their spawner');

// walk in through the freshly built door
p.dead = false;
p.hp = 50;
p.x = builtDoor.x + 1;
p.y = builtDoor.y;
p.moveAt = 0;
p.portalAt = 0;
game.handleMove(p, -1, 0);
assert.strictEqual(p.y, 54 + 2, 'the built inn has an inside');

// -- the whole bestiary is placeable ---------------------------------------------------
assert(Object.keys(MOB_KINDS).length >= 130, 'the full bestiary is registered');
for (const k of ['titan', 'lich', 'ogre', 'basilisk', 'paladin', 'rabbit']) {
  assert(MOB_KINDS[k] && MOB_KINDS[k].name && MOB_KINDS[k].hp > 0, `${k} has stats`);
}
assert(MOB_KINDS.rabbit.aggro === 0, 'rabbits do not bite');
assert(MOB_KINDS.lich.caster, 'liches cast');
const manifest = JSON.parse(require('fs').readFileSync('client/assets/manifest.json', 'utf8'));
for (const k of Object.keys(MOB_KINDS)) {
  // originals drawn from scratch, and bosses that share a base kind's atlas
  if (['sheep', 'pig', 'chicken', 'crab',
       'goblinking', 'wolfking', 'vyrmaur', 'whitestag'].includes(k)) continue;
  assert(manifest.creatures[k], `${k} has a creature atlas`);
}
assert(Object.values(manifest.iconCategories || {}).reduce((a, v) => a + v.length, 0) >= 500,
  'the icon library is stocked');
assert(manifest.frames['td.o.windmill'] && manifest.frames['td.o.windmill'].anim,
  'the windmill turns');
assert(manifest.frames['td.o.lamp'].anim, 'the street lamps flicker');
// a builder-placed titan lives
const c5 = game.applyEditsLive({ spawners: [{ kind: 'titan', count: 1, x: spot.x + 12, y: spot.y, r: 3 }] });
assert.strictEqual(c5.spawners, 1, 'a titan camp takes');
assert([...game.mobs.values()].some((m) => m.kind === 'titan'), 'and a titan walks the world');

// -- the keeper shapes the people too: merchants, dialogue, loot ----------------------
const npcOverlay = {
  vendors: [{
    x: spot.x + 16, y: spot.y, name: 'Sella of the Road', model: 'bard',
    greeting: 'Fresh wares, straight off the cart!',
    goods: [
      { type: 'weapon', item: 'sword', q: 2 },
      { type: 'weapon', item: 'notaweapon', q: 1 },
      { item: 'heal', price: 40 },
      { item: 'contraband', price: 9 },
    ],
  }],
  spawners: [{
    kind: 'goblin', count: 1, x: spot.x + 20, y: spot.y, r: 3,
    lines: ['We wuz here first.', ''],
    loot: [[1, 'gems', 2, 3], [1, 'weapon', ['dagger'], 1, 1], [0.5, 'nonsense', 1, 2]],
  }],
};
ws.sent.length = 0;
const c6 = game.applyEditsLive(npcOverlay);
assert.strictEqual(c6.vendors, 1, 'the merchant sets up shop');
assert(ws.sent.some((m) => m.t === 'vendors'), 'players heard the market change');
const sella = game.vendors.find((v) => v.name === 'Sella of the Road');
assert(sella && sella.greeting && sella.goods.length === 2,
  'her goods survived sanitising: fake weapon and contraband refused');
// buying from her works end to end
p.dead = false;
p.gold = 500;
p.x = sella.x;
p.y = sella.y + 1;
const purseBefore = p.gold;
game.handleBuy(p, 0); // the Fine sword
assert(p.gold < purseBefore, 'coin changed hands');
assert(p.items.some((i) => i.id === 'sword' && i.q === 2), 'and the Fine sword is real');
// the camp speaks with its own voice and drops its own spoils
const talker = [...game.mobs.values()].find((m) => m.kind === 'goblin' &&
  m.spawner && m.spawner.lines);
assert(talker, 'the chatty goblin camp stands');
assert.deepStrictEqual(talker.spawner.lines, ['We wuz here first.'], 'empty lines dropped');
assert.strictEqual(talker.spawner.loot.length, 2, 'nonsense loot rows refused');
const dropsBefore = game.drops.size;
game.rollLoot(talker);
assert(game.drops.size >= dropsBefore + 2, 'the override table paid out gems and a dagger');
assert([...game.drops.values()].some((d) => d.item === 'gems'), 'gems dropped');
assert([...game.drops.values()].some((d) => d.item === 'weapon' && d.w.id === 'dagger'),
  'the dagger dropped');
// removing the merchant clears her stall live
const c7 = game.applyEditsLive({ ...npcOverlay, vendors: [] });
assert(!game.vendors.some((v) => v.name === 'Sella of the Road'), 'the stall folds');
assert(c7.removed >= 1, 'and it counts as a removal');

// -- the builder's lock ---------------------------------------------------------------
const ed = require('../server/editor');
ed.configure('smoke-key');
assert(ed.passwordRequired(), 'a password arms the gate');
assert(ed.verifyPassword('smoke-key'), 'the right key turns');
assert(!ed.verifyPassword('wrong'), 'the wrong key does not');
const tok = ed.issueSession();
assert(ed.checkToken(tok), 'a fresh session holds');
assert(!ed.checkToken('deadbeef'), 'garbage does not');
for (let i = 0; i < 5; i++) assert(!ed.rateLimited('9.9.9.9'), 'five tries are allowed');
assert(ed.rateLimited('9.9.9.9'), 'the sixth is refused');
const gh = ed.githubRequest('PUT', 'o/r', 'tkn', 'world/edits.json', { a: 1 });
assert(gh.options.hostname === 'api.github.com' &&
  gh.options.path === '/repos/o/r/contents/world/edits.json' &&
  gh.options.headers.Authorization === 'Bearer tkn' && gh.payload === '{"a":1}',
  'the publish request is well-formed');
ed.configure(undefined); // disarm so nothing else in this run is gated

// -- batch G: the new arts — alchemy, taming, treasure hunting ------------------------
assert(welcome.brews && welcome.brews.heal && welcome.brews.mana, 'welcome carries the brew recipes');
for (const sk of ['alchemy', 'taming', 'treasurehunting']) {
  assert(typeof p.skills[sk] === 'number', `${sk} is on the sheet`);
}
assert(welcome.bestiary.wolf.tm !== undefined && welcome.bestiary.dragon.tm === undefined,
  'the bestiary says who may be tamed');

// alchemy: buy herbs, brew at the bench, fail away from it
const mira2 = game.vendors.find((v) => v.goods.some((g) => g.item === 'herbs'));
assert(mira2, 'an alchemist sells herbs');
p.dead = false;
p.x = mira2.x;
p.y = mira2.y - 1;
p.gold = 500;
p.herbs = 0;
game.handleBuy(p, mira2.goods.findIndex((g) => g.item === 'herbs'));
assert.strictEqual(p.herbs, 4, 'a bundle holds four herbs');
p.skills.alchemy = 100;
p.pots.heal = 0;
p.brewAt = 0;
const goldAtBench = p.gold;
const rBrew = Math.random;
Math.random = () => 0.5; // succeeds at GM skill, no double measure
game.handleBrew(p, 'heal');
Math.random = rBrew;
assert.strictEqual(p.pots.heal, 1, 'the brew decants');
assert.strictEqual(p.herbs, 2, 'herbs went into the pot');
assert.strictEqual(p.gold, goldAtBench - 8, 'the bottle cost its gold');
assert(p.deeds.brewer, 'the first draught is a deed');
p.skills.alchemy = 0;
p.brewAt = 0;
Math.random = () => 0.99; // a novice botches it
game.handleBrew(p, 'heal');
Math.random = rBrew;
assert.strictEqual(p.pots.heal, 1, 'the novice mixture curdles');
assert.strictEqual(p.herbs, 0, 'and still wastes the herbs');
ws.sent.length = 0;
p.x = 5;
p.y = 5;
p.brewAt = 0;
game.handleBrew(p, 'heal');
assert(ws.sent.some((m) => m.t === 'sys' && /bench/.test(m.text)), 'no brewing in the wilds');

// taming: the wolf resists the doorstep skill, obeys the master
p.x = mira2.x;
p.y = mira2.y - 1;
const wolfStub = { alive: new Set(), x: p.x, y: p.y, r: 2, kind: 'wolf', respawnMs: 0 };
game.spawnMob(wolfStub);
const wolf = game.mobs.get([...wolfStub.alive][0]);
assert(wolf, 'a wolf stands for the tamer');
wolf.x = p.x + 1;
wolf.y = p.y;
p.skills.taming = 0;
p.tameAt = 0;
ws.sent.length = 0;
game.handleTame(p, wolf.id);
assert(ws.sent.some((m) => m.t === 'sys' && /need 45 Taming/.test(m.text)),
  'wolves are beyond a novice');
p.skills.taming = 100;
p.tameAt = 0;
const rTame = Math.random;
Math.random = () => 0;
game.handleTame(p, wolf.id);
Math.random = rTame;
assert.strictEqual(wolf.owner, p.id, 'the wolf is won over');
assert(wolf.name.includes(p.name), 'and bears its master\'s name');
assert.strictEqual(wolfStub.alive.size, 0, 'its old pack forgets it');
assert(p.deeds.beastfriend, 'a loyal companion is a deed');
ws.sent.length = 0;
p.tameAt = 0;
game.handleTame(p, wolf.id);
assert(ws.sent.some((m) => m.t === 'sys' && /answers to another|already have/.test(m.text)),
  'no taming what is already tamed');
ws.sent.length = 0;
game.handleAttack(p, wolf.id);
assert(ws.sent.some((m) => m.t === 'sys' && /answers to another/.test(m.text)),
  'pets are safe from other blades');
// it heels — staged on open grass so walls can't excuse it
let run = null;
outer3:
for (let y = game.map.h / 2 - 200; y < game.map.h / 2 + 200; y++) {
  for (let x = game.map.w / 2 - 200; x < game.map.w / 2 + 200; x++) {
    let clear = true;
    for (let i = 0; i < 7; i++) {
      if (game.map.tiles[y * game.map.w + x + i] !== TILE.GRASS) { clear = false; break; }
    }
    if (clear) { run = { x, y }; break outer3; }
  }
}
assert(run, 'found an open meadow');
p.x = run.x;
p.y = run.y;
wolf.x = run.x + 5;
wolf.y = run.y;
wolf.moveAt = 0;
p.target = 0;
game.mobTick(wolf, Date.now());
assert(Math.hypot(wolf.x - p.x, wolf.y - p.y) < 5, 'the wolf heels');
wolf.x = p.x + 30; // left far behind, it finds its own way over
wolf.moveAt = 0;
game.mobTick(wolf, Date.now());
assert(Math.hypot(wolf.x - p.x, wolf.y - p.y) <= 2, 'a far-flung pet catches up');
// it fights its master's quarry
const gobStub = { alive: new Set(), x: p.x, y: p.y, r: 2, kind: 'goblin', respawnMs: 0 };
game.spawnMob(gobStub);
const gob = game.mobs.get([...gobStub.alive][0]);
gob.x = p.x + 1;
gob.y = p.y;
gob.hp = 1;
wolf.x = p.x;
wolf.y = p.y + 1;
wolf.swingAt = 0;
p.target = gob.id;
const goldBeforeHunt = p.gold;
game.mobTick(wolf, Date.now());
assert(!game.mobs.has(gob.id), 'the wolf savaged the quarry');
assert(p.gold > goldBeforeHunt, 'and the spoils fall to the master');
p.target = 0;
// the companion survives a save and a farewell
game.persistPlayer(p);
assert.strictEqual(game.records[p.key].pet.kind, 'wolf', 'the companion is remembered');
game.handleCommand(p, '/release');
assert(!wolf.owner, 'released back to the wild');
game.persistPlayer(p);
assert(!game.records[p.key].pet, 'and forgotten by the record');
game.mobs.delete(wolf.id); // clear the stage

// gathering herbs from the mire
let marsh = null;
outer2:
for (let y = 1; y < game.map.h - 1; y++) {
  for (let x = 1; x < game.map.w - 1; x++) {
    if (game.map.tiles[y * game.map.w + x] !== TILE.SWAMP) continue;
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
      .every(([dx, dy]) => game.map.tiles[(y + dy) * game.map.w + x + dx] === TILE.SWAMP);
    if (around) { marsh = { x, y }; break outer2; }
  }
}
assert(marsh, 'the mire has deep ground');
p.x = marsh.x;
p.y = marsh.y;
p.skills.alchemy = 100;
p.swingAt = 0;
const herbsBefore = p.herbs;
game.handleGather(p);
assert(p.herbs > herbsBefore, 'marsh herbs come up by the handful');

// treasure hunting: a practiced dig pays beyond the cache
const digIdx2 = game.map.secrets.findIndex((s, i) => s.type === 'cache' && !s.dead && i !== digIdx);
assert(digIdx2 >= 0, 'another cache waits');
const spot2 = game.map.secrets[digIdx2];
for (const [id, d] of [...game.drops]) {
  if (d.cacheIdx === digIdx2 || (d.x === spot2.x && d.y === spot2.y)) game.drops.delete(id);
}
// the boot-time applyEdits exercise above pushed raw spawners onto the live
// map; give them what the boot loop would before ticking again
for (const sp of game.spawners) if (!sp.alive) sp.alive = new Set();
p.tmaps = [digIdx2];
p.skills.treasurehunting = 100;
p.x = spot2.x;
p.y = spot2.y;
p.hp = 100000;
p.target = 0;
const rDig = Math.random;
Math.random = () => 0; // the gem roll cannot miss at GM skill
game.tick();
Math.random = rDig;
assert.strictEqual(p.tmaps.length, 0, 'the second map is spent');
assert([...game.drops.values()].some((d) => d.item === 'gold' && d.x === spot2.x && d.y === spot2.y &&
  d.cacheIdx === undefined), 'the practiced eye turns up loose gold');
assert([...game.drops.values()].some((d) => d.item === 'gems' && d.x === spot2.x && d.y === spot2.y &&
  d.cacheIdx === undefined), 'and buried gems besides');
assert(p.deeds.digger, 'X marks the spot is a deed');

// -- batch H: the dance — dash, windups, bolts, specials, boons, bonds, crafting ------
assert(welcome.boonDefs && welcome.boonDefs.lifesteal && welcome.specials &&
  welcome.specials.sword && welcome.brands && welcome.brands.flame,
  'welcome carries the boon book, the specials and the brands');

// dash: three tiles, i-frames, cooldown, and refusals that cost nothing
p.dead = false;
p.boons = [];
p.evadeUntil = 0;
p.riposteUntil = 0;
p.target = 0;
p.x = run.x;
p.y = run.y;
p.dashAt = 0;
game.handleDash(p, 1, 0);
assert.strictEqual(p.x, run.x + 4, 'dash covers four tiles');
assert(p.evadeUntil > Date.now(), 'and buys a heartbeat of untouchability');
const dashCdAt = p.dashAt;
game.handleDash(p, 1, 0);
assert(p.x === run.x + 4 && p.dashAt === dashCdAt, 'the dash respects its cooldown');
p.dashAt = 0;
p.x = tree.x + 1;
p.y = tree.y;
game.handleDash(p, -1, 0); // straight into the tree
assert(p.x === tree.x + 1 && p.dashAt === 0, 'a refused dash costs nothing');
// the landing runs the same ground hooks as a step (shared arriveAt)
p.x = portal.x;
p.y = portal.y;
p.portalAt = 0;
game.arriveAt(p, Date.now());
assert(p.x === portal.tx && p.y === portal.ty, 'a dash landing still falls through portals');

// heavy windups: the mark, the miss, the unavoidable hit, the i-frame
p.x = run.x;
p.y = run.y;
p.evadeUntil = 0;
const hSp = { alive: new Set(), x: run.x, y: run.y, r: 2, kind: 'ettin' };
const brute = { id: 999979, kind: 'ettin', x: run.x + 1, y: run.y, hp: 500, maxhp: 500,
  homeX: run.x + 1, homeY: run.y, target: p.id, moveAt: Infinity, swingAt: 0,
  chatAt: Infinity, spawner: hSp };
game.mobs.set(brute.id, brute);
hSp.alive.add(brute.id);
ws.sent.length = 0;
game.mobTick(brute, Date.now());
assert(brute.pendingStrike && brute.pendingStrike.x === p.x && brute.pendingStrike.y === p.y,
  'the heavy winds up on your tile instead of swinging');
assert(ws.sent.some((m) => m.t === 'fx' && m.kind === 'windup'), 'and shows its tell');
const hpH = p.hp;
p.x += 1; // step off the mark
brute.pendingStrike.at = 0;
game.mobTick(brute, Date.now());
assert.strictEqual(p.hp, hpH, 'stepping off the mark is the whole defense');
assert(!brute.pendingStrike && brute.swingAt > Date.now(), 'the blow spent itself on dirt');
brute.x = p.x + 1; // close in again
brute.swingAt = 0;
game.mobTick(brute, Date.now());
p.evadeUntil = 0;
brute.pendingStrike.at = 0;
game.mobTick(brute, Date.now());
assert(p.hp < hpH, 'standing on the mark always hurts — no dice involved');
const hpI = p.hp;
brute.swingAt = 0;
game.mobTick(brute, Date.now());
p.evadeUntil = Date.now() + 10_000; // mid-dash
brute.pendingStrike.at = 0;
ws.sent.length = 0;
game.mobTick(brute, Date.now());
assert.strictEqual(p.hp, hpI, 'i-frames turn even a committed blow');
assert(ws.sent.some((m) => m.t === 'fx' && m.kind === 'evade'), 'and say so');
brute.target = 0;
brute.swingAt = Infinity;

// caster bolts take 300ms to arrive, and a dash slips them
const mage = { id: 999978, kind: 'skelmage', x: p.x + 4, y: p.y, hp: 26, maxhp: 26,
  homeX: p.x + 4, homeY: p.y, target: p.id, moveAt: Infinity, swingAt: Infinity,
  castAt: 0, chatAt: Infinity, spawner: { alive: new Set() } };
game.mobs.set(mage.id, mage);
game.pendingBolts.length = 0;
game.mobTick(mage, Date.now());
assert.strictEqual(game.pendingBolts.length, 1, 'the bolt is in flight, not instant');
p.evadeUntil = Date.now() + 10_000;
game.pendingBolts[0].at = 0;
const hpB = p.hp;
game.tick();
assert.strictEqual(p.hp, hpB, 'a well-read dash slips the bolt');
p.evadeUntil = 0;
mage.castAt = 0;
game.mobTick(mage, Date.now());
game.pendingBolts[game.pendingBolts.length - 1].at = 0;
game.tick();
assert(p.hp < hpB, 'a flat-footed mark takes it full');
game.mobs.delete(mage.id);

// specials: one button, a different verb per weapon class
const rH = Math.random;
const dummySp = { alive: new Set(), x: p.x, y: p.y, r: 3, kind: 'orc' };
const mkOrc = (id, ox, oy) => {
  const o = { id, kind: 'orc', x: p.x + ox, y: p.y + oy, hp: 500, maxhp: 500,
    homeX: p.x + ox, homeY: p.y + oy, target: 0, moveAt: Infinity, swingAt: Infinity,
    chatAt: Infinity, spawner: dummySp };
  game.mobs.set(o.id, o);
  dummySp.alive.add(o.id);
  return o;
};
// riposte turns the next blade and answers it
const swordH = game.makeItem(p, 'sword', 1);
p.items.push(swordH);
p.weapon = swordH.uid;
p.specialAt = 0;
game.handleSpecial(p);
assert(p.riposteUntil > Date.now(), 'riposte arms the window');
assert(p.specialAt > Date.now(), 'and the bet spends the cooldown');
const striker = mkOrc(999977, 1, 0);
striker.target = p.id;
striker.swingAt = 0;
const hpR = p.hp;
Math.random = () => 0; // the orc's swing cannot miss
game.mobTick(striker, Date.now());
Math.random = rH;
assert.strictEqual(p.hp, hpR, 'the read blade never lands');
assert(striker.hp < 500, 'and the answer does');
assert.strictEqual(p.riposteUntil, 0, 'one read per bet');
striker.target = 0;
// bellringer stuns the skull it rings — but crowned heads only stagger
const maceH = game.makeItem(p, 'mace', 1);
p.items.push(maceH);
p.weapon = maceH.uid;
p.specialAt = 0;
p.target = striker.id;
game.handleSpecial(p);
assert(striker.stunUntil > Date.now(), 'the bell rings');
striker.target = p.id;
striker.swingAt = 0;
const hpS = p.hp;
game.mobTick(striker, Date.now());
assert.strictEqual(p.hp, hpS, 'a rung bell does not swing back');
const bossH = { id: 999976, kind: 'bonelord', x: p.x - 1, y: p.y, hp: 500, maxhp: 500,
  homeX: p.x - 1, homeY: p.y, target: 0, moveAt: Infinity, swingAt: Infinity,
  chatAt: Infinity, aoeAt: Infinity, spawner: { alive: new Set() } };
game.mobs.set(bossH.id, bossH);
p.specialAt = 0;
p.target = bossH.id;
game.handleSpecial(p);
assert(!bossH.stunUntil && bossH.slowUntil > Date.now(), 'the crowned only stagger');
game.mobs.delete(bossH.id);
// whirlwind hits every neighbour but never a companion
const axeH = game.makeItem(p, 'battleaxe', 1);
p.items.push(axeH);
p.weapon = axeH.uid;
const wolfSpH = { alive: new Set(), x: p.x, y: p.y, r: 2, kind: 'wolf', respawnMs: 0 };
game.spawnMob(wolfSpH);
const petH = game.mobs.get([...wolfSpH.alive][0]);
petH.owner = p.id;
petH.x = p.x;
petH.y = p.y - 1;
const orcB1 = mkOrc(999975, 0, 1);
striker.x = p.x + 1;
striker.y = p.y;
striker.stunUntil = 0;
const b1Hp = orcB1.hp;
const strHp = striker.hp;
const petHp = petH.hp;
p.specialAt = 0;
game.handleSpecial(p);
assert(orcB1.hp < b1Hp && striker.hp < strHp, 'the axe argues with everyone at once');
assert.strictEqual(petH.hp, petHp, 'but never with a companion');
// a special with nothing to do is a free no-op
game.mobs.delete(orcB1.id);
const savedX = p.x;
p.x = run.x + 6; // empty grass, striker out of reach
p.specialAt = 0;
game.handleSpecial(p);
assert.strictEqual(p.specialAt, 0, 'a whiffed special never burns the button');
p.x = savedX;
// shadowstep crosses the room and cuts twice as deep
const dagH = game.makeItem(p, 'dagger', 1);
p.items.push(dagH);
p.weapon = dagH.uid;
const mark = mkOrc(999974, 3, 0);
p.target = mark.id;
p.specialAt = 0;
game.handleSpecial(p);
assert(Math.hypot(p.x - mark.x, p.y - mark.y) <= 1.5, 'the dark puts you beside the mark');
assert(mark.hp < 500, 'and the knife explains why');
// heartseeker pierces the line and spends an arrow
const bowH = game.makeItem(p, 'longbow', 1);
p.items.push(bowH);
p.weapon = bowH.uid;
p.arrows = 5;
mark.x = p.x + 4;
mark.y = p.y;
const markHp = mark.hp;
p.target = mark.id;
p.specialAt = 0;
game.handleSpecial(p);
assert(mark.hp < markHp, 'the heartseeker finds the line');
assert.strictEqual(p.arrows, 4, 'and costs its arrow');
// the commoner's answer: a boot, and some distance (staged on sure grass)
p.weapon = null;
p.x = run.x;
p.y = run.y;
mark.x = run.x + 1;
mark.y = run.y;
p.target = mark.id;
p.specialAt = 0;
game.handleSpecial(p);
assert.strictEqual(mark.x, run.x + 3, 'the kick makes two tiles of room');

// boons: prove thyself, choose from the water, and lose it all to death
let shrineTile = null;
outerH:
for (let y = 0; y < game.map.h; y++) {
  for (let x = 0; x < game.map.w; x++) {
    if (game.map.tiles[y * game.map.w + x] === TILE.SHRINE) { shrineTile = { x, y }; break outerH; }
  }
}
assert(shrineTile, 'the world keeps at least one shrine');
p.boons = [];
p.boonKills = 0;
p.boonOffer = null;
p.x = run.x;
p.y = run.y;
ws.sent.length = 0;
game.handlePray(p);
assert(ws.sent.some((m) => m.t === 'sys' && /Stand at a shrine/.test(m.text)), 'prayers travel poorly');
p.x = shrineTile.x;
p.y = shrineTile.y;
ws.sent.length = 0;
Math.random = () => 0;
game.handlePray(p);
Math.random = rH;
const offer1 = ws.sent.find((m) => m.t === 'boons');
assert(offer1 && offer1.offer.length === 3, 'three gifts float on the water');
ws.sent.length = 0;
game.handlePray(p); // no rerolling the spirits
const offer2 = ws.sent.find((m) => m.t === 'boons');
assert.deepStrictEqual(offer2.offer.map((b) => b.id), offer1.offer.map((b) => b.id),
  'the offer stays until taken');
game.handleBoon(p, offer1.offer[0].id);
assert(p.boons.includes(offer1.offer[0].id) && !p.boonOffer, 'the gift is taken');
assert(p.deeds.blessed, 'and it is a deed');
ws.sent.length = 0;
game.handlePray(p);
assert(ws.sent.some((m) => m.t === 'sys' && /Prove thyself: 15/.test(m.text)),
  'the second gift must be earned');
// worthy kills move the gate; chicken coops do not
p.boonKills = 0;
p.skills.swordsmanship = 100;
const prey = mkOrc(999973, 1, 1); // skill 55 >= 35: worthy
prey.hp = 1;
game.killMob(p, prey);
assert.strictEqual(p.boonKills, 1, 'a worthy kill counts');
const coopSp = { alive: new Set(), x: p.x, y: p.y, r: 2, kind: 'chicken' };
const hen = { id: 999972, kind: 'chicken', x: p.x + 1, y: p.y, hp: 1, maxhp: 4,
  homeX: p.x, homeY: p.y, target: 0, moveAt: 0, swingAt: 0, spawner: coopSp };
game.mobs.set(hen.id, hen);
coopSp.alive.add(hen.id);
game.killMob(p, hen);
assert.strictEqual(p.boonKills, 1, 'the chicken coop moves no spirits');
// the pool's teeth, one by one
p.boons = ['maxhp'];
ws.sent.length = 0;
game.sendYou(p);
assert.strictEqual(ws.sent.find((m) => m.t === 'you').maxhp,
  50 + Math.floor(p.str / 2) + 25, 'Oxheart widens the chest');
p.boons = ['goldfind'];
const purseH = p.gold;
const rich = mkOrc(999971, 1, 0);
rich.hp = 1;
Math.random = () => 0;
game.killMob(p, rich);
Math.random = rH;
assert(p.gold - purseH >= Math.round(Math.ceil(MOB_KINDS.orc.gold * 0.6) * 1.3),
  'the Miser\'s Luck counts in your favour');
p.boons = ['chainkill'];
striker.x = run.x + 40; // clear the neighbourhood so the spark has one friend
mark.x = run.x + 41;
const sparkA = mkOrc(999970, 1, 0);
const sparkB = mkOrc(999969, 2, 0);
sparkA.hp = 1;
game.killMob(p, sparkA);
assert(sparkB.hp < 500, 'the Storm\'s Tithe goes looking for friends');
// thorns and lifesteal, out in the wilds where the mob AI will engage
p.x = run.x;
p.y = run.y;
p.boons = ['thorns'];
p.evadeUntil = 0;
p.riposteUntil = 0;
const pricked = mkOrc(999968, 1, 0);
pricked.x = run.x + 1;
pricked.y = run.y;
pricked.homeX = pricked.x;
pricked.homeY = pricked.y;
pricked.target = p.id;
pricked.swingAt = 0;
Math.random = () => 0;
game.mobTick(pricked, Date.now());
Math.random = rH;
assert(pricked.hp < 500, 'Briarhide answers without a lifted finger');
p.boons = ['lifesteal'];
p.hp = 10;
p.weapon = swordH.uid;
p.target = pricked.id;
p.swingAt = 0;
Math.random = () => 0;
game.meleeTick(p, Date.now());
Math.random = rH;
assert(p.hp > 10, 'Wolfsblood feeds on the wound');
p.boons = ['cheatdeath'];
p.hp = 5;
game.killPlayer(p, 'the test');
assert(!p.dead && p.hp === 1 && !p.boons.includes('cheatdeath'),
  'the Ferryman blinks exactly once');
p.boons = ['thorns', 'maxhp'];
game.killPlayer(p, 'the test');
assert(p.dead && p.boons.length === 0, 'death repossesses every gift');
p.dead = false;
p.hp = 60;
// boons survive the record, not the grave
p.boons = ['manaspring'];
game.persistPlayer(p);
assert.deepStrictEqual(game.records[p.key].boons, ['manaspring'], 'boons survive a save');
p.boons = [];

// bonds: talk, gift, milestones, the friend's price
const vilSp = { alive: new Set(), x: run.x, y: run.y, r: 0, kind: 'villager', respawnMs: 0 };
game.spawnMob(vilSp);
const vil = game.mobs.get([...vilSp.alive][0]);
assert(vil && vil.name, 'the villager has a name');
const vilSp2 = { alive: new Set(), x: run.x, y: run.y, r: 0, kind: 'villager', respawnMs: 0 };
game.spawnMob(vilSp2);
const vil2 = game.mobs.get([...vilSp2.alive][0]);
assert.strictEqual(vil.name, vil2.name, 'the same ground deals the same name — favor survives reboots');
game.mobs.delete(vil2.id);
p.x = vil.x + 1;
p.y = vil.y;
p.talkAt = 0;
ws.sent.length = 0;
game.handleTalk(p, vil.id);
assert(ws.sent.some((m) => m.t === 'chat' && m.name === vil.name), 'the villager answers by name');
p.fish = 3;
p.giftAt = 0;
p.favor = {};
p.favorPaid = {};
p.giftCdBy = {};
game.handleGift(p, vil.id, 'fish');
assert.strictEqual(p.favor[vil.name], 1, 'a fish buys a sliver of favor');
assert.strictEqual(p.fish, 2, 'and costs a fish');
p.giftAt = 0;
game.handleGift(p, vil.id, 'fish');
assert.strictEqual(p.favor[vil.name], 1, 'one gift per neighbour per five minutes');
p.favor[vil.name] = 4;
p.giftCdBy = {};
p.giftAt = 0;
const healsH = p.pots.heal;
game.handleGift(p, vil.id, 'fish');
assert.strictEqual(p.pots.heal, healsH + 1, 'a friend presses a potion into your hand');
p.favor[vil.name] = 9;
p.giftCdBy = {};
p.giftAt = 0;
p.tmaps = [];
game.handleGift(p, vil.id, 'fish');
assert.strictEqual(p.tmaps.length, 1, 'a confidant marks where the ground whispers');
assert(p.deeds.confidant, 'and that is a deed');
p.giftAt = 0;
p.giftCdBy = {};
const fishH = p.fish;
game.handleGift(p, vil.id, 'fish');
assert.strictEqual(p.fish, fishH, 'a maxed friend takes nothing more');
game.persistPlayer(p);
assert(game.records[p.key].favor[vil.name] >= 10, 'favor survives a save');
// the friend's price, charged at the counter
p.x = mira2.x;
p.y = mira2.y - 1;
p.favor[mira2.name] = 10;
p.gold = 500;
const healIdxH = mira2.goods.findIndex((g) => g.item === 'heal');
game.handleBuy(p, healIdxH);
assert.strictEqual(p.gold, 500 - Math.round(mira2.goods[healIdxH].price * 0.9),
  'a confidant pays a tenth less');

// crafting moments: unmake at the forge, brand at the bench, feast at the fire
const brenH = game.vendors.find((v) => v.forge);
p.x = brenH.x;
p.y = brenH.y - 1;
p.weapon = null;
const scrapH = game.makeItem(p, 'sword', 1);
p.items.push(scrapH);
const oreH = p.ore;
const logsH = p.logs;
game.handleSalvage(p, scrapH.uid);
assert(!p.items.some((i) => i.uid === scrapH.uid), 'the sword is unmade');
assert(p.ore === oreH + 3 && p.logs === logsH + 1, 'and comes apart into its honest parts');
p.weapon = swordH.uid;
ws.sent.length = 0;
game.handleSalvage(p, swordH.uid);
assert(p.items.some((i) => i.uid === swordH.uid), 'the forge takes no blade from a living hand');
assert(ws.sent.some((m) => m.t === 'sys' && /Unequip/.test(m.text)), 'and says so');
// imbue: one gem-fired grudge per blade
p.x = mira2.x;
p.y = mira2.y - 1;
p.gems = 5;
p.gold = 500;
ws.sent.length = 0;
game.handleImbue(p, swordH.uid, 'flame');
assert.strictEqual(swordH.brand, 'flame', 'the steel takes the brand');
assert(p.gems === 2 && p.gold === 450, 'and the gems and gold are spent');
assert(ws.sent.some((m) => m.t === 'sys' && /Smouldering/.test(m.text)), 'the blade bears its new name');
ws.sent.length = 0;
game.handleImbue(p, swordH.uid, 'frost');
assert.strictEqual(swordH.brand, 'flame', 'the steel holds no two grudges');
// the brand procs on a landed swing
pricked.x = p.x + 1;
pricked.y = p.y;
p.target = pricked.id;
p.weapon = swordH.uid;
p.swingAt = 0;
p.evadeUntil = 0;
ws.sent.length = 0;
Math.random = () => 0;
game.meleeTick(p, Date.now());
Math.random = rH;
assert(ws.sent.some((m) => m.t === 'fx' && m.kind === 'brand'), 'the smouldering blade bites deeper');
// feast: fish, meat and herb settle their differences
const fireProp = game.map.props.find((pr) => pr.name === 'fx.campfire');
assert(fireProp, 'somewhere a campfire burns');
p.fish = 1;
p.meat = 1;
p.herbs = 1;
p.x = run.x;
p.y = run.y;
ws.sent.length = 0;
game.handleFeast(p);
assert(ws.sent.some((m) => m.t === 'sys' && /campfire/.test(m.text)), 'no feast without a fire');
p.x = fireProp.x + 1;
p.y = fireProp.y;
game.handleFeast(p);
assert(p.fish === 0 && p.meat === 0 && p.herbs === 0, 'the pot takes all three');
assert(p.fedUntil > Date.now() && p.buffUntil > Date.now(), 'warmth and strength for the road');

// review regressions: the dead stay dead, the frozen stay frozen, the hungry stay hungry
p.riposteUntil = Date.now() + 5000;
const ghostOrc = mkOrc(999967, 1, 0);
game.mobs.delete(ghostOrc.id); // died a heartbeat before the parry
const purseR = p.gold;
game.strikePlayer(p, 5, 'a ghost blow', { melee: true, srcMob: ghostOrc });
assert.strictEqual(p.gold, purseR, 'a riposte answers a dead mob exactly zero times');
p.riposteUntil = 0;
// the floated offer survives a relog: no rerolling the spirits by reconnect
p.boonOffer = ['thorns', 'maxhp', 'crit'];
game.persistPlayer(p);
assert.deepStrictEqual(game.records[p.key].boonOffer, ['thorns', 'maxhp', 'crit'],
  'the offer stays on the water through a save');
p.boonOffer = null;
// a mob frozen in its windup swings at no one — not even the pet
const bruteH = game.mobs.get(999979);
p.x = bruteH.x - 1;
p.y = bruteH.y;
p.target = bruteH.id;
petH.x = bruteH.x;
petH.y = bruteH.y + 1;
petH.swingAt = Infinity; // only the counter-swing is under test
bruteH.pendingStrike = { x: p.x, y: p.y, at: Date.now() + 9999, dmg: 5 };
bruteH.swingAt = 0;
const petHpH = petH.hp;
game.mobTick(petH, Date.now());
assert.strictEqual(petH.hp, petHpH, 'a windup freezes the counter-swing too');
bruteH.pendingStrike = null;
p.target = 0;
// vampires cannot dine on a dodged blow
const countH = { id: 999966, kind: 'vampire', x: p.x + 1, y: p.y, hp: 100, maxhp: 280,
  homeX: p.x + 1, homeY: p.y, target: p.id, moveAt: Infinity, swingAt: Infinity,
  chatAt: Infinity, aoeAt: Infinity, spawner: { alive: new Set() },
  pendingStrike: { x: p.x, y: p.y, at: 0, dmg: 20, plus: true } };
game.mobs.set(countH.id, countH);
p.evadeUntil = Date.now() + 10_000;
game.mobTick(countH, Date.now());
assert.strictEqual(countH.hp, 100, 'the Count goes hungry when you dash through him');
game.mobs.delete(countH.id);
p.evadeUntil = 0;

// a companion shrugs off part of every blow, and falls back when bleeding
const preyH = mkOrc(999965, 1, 0);
preyH.x = run.x + 1;
preyH.y = run.y;
preyH.swingAt = 0;
preyH.hp = 500;
p.x = run.x;
p.y = run.y;
p.target = preyH.id;
p.skills.taming = 100;
petH.x = run.x + 1;
petH.y = run.y + 1;
petH.hp = petH.maxhp;
petH.cowed = false;
petH.swingAt = Infinity; // only the bite-back is under test
Math.random = () => 0;
game.mobTick(petH, Date.now());
Math.random = rH;
assert.strictEqual(petH.maxhp - petH.hp, 1,
  'a master-kept companion shrugs off most of a blow (4 raw -> 1 taken)');
petH.hp = Math.max(1, Math.floor(petH.maxhp * 0.2));
petH.swingAt = 0;
ws.sent.length = 0;
game.mobTick(petH, Date.now());
assert.strictEqual(preyH.hp, 500, 'a bleeding companion falls back from the fight');
assert(ws.sent.some((m) => m.t === 'sys' && /falls back, bleeding/.test(m.text)),
  'and its master hears why');
game.mobs.delete(preyH.id);
p.target = 0;

// whatever the client claims, no blade auto-falls on a companion
petH.hp = petH.maxhp;
petH.x = p.x + 1;
petH.y = p.y;
p.target = petH.id;
p.swingAt = 0;
game.meleeTick(p, Date.now());
assert.strictEqual(petH.hp, petH.maxhp, 'the auto-attack refuses the companion');
assert.strictEqual(p.target, 0, 'and drops the lock on it');

// tidy the stage
for (const id of [999979, 999977, 999975, 999974, 999973, 999972, 999971, 999970, 999969, 999968]) {
  game.mobs.delete(id);
}
game.mobs.delete(vil.id);
game.mobs.delete(petH.id);
p.boons = [];
p.target = 0;

console.log('smoke test: all assertions passed');
process.exit(0);
