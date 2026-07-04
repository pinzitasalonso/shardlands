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

console.log('smoke test: all assertions passed');
process.exit(0);
