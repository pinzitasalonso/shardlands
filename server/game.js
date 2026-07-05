'use strict';

// Core game simulation: players, mobs, combat, skills, magic, gathering,
// vendors, loot and the world's secrets. The server is authoritative;
// clients only send intents.
//
// The world is large (2048x2048), so two things are streamed rather than
// broadcast wholesale: map tiles go out in 64x64 chunks on request, and each
// player only receives entities within their interest radius.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TILE, generate, applyEdits, sanitizeEdits, placeBuilding, EDIT_INTERIOR_X0,
  isWalkable, tileAt, nearestWalkable } = require('./world');
const persist = require('./persist');

const TICK_MS = 100;
const SAVE_INTERVAL_MS = 30_000;
const SKILL_CAP = 100;
const STAT_CAP = 100;
const CHUNK = 64;
const MINI_SCALE = 8;
const VIEW_RADIUS = 60;          // tiles; entities beyond this aren't sent
const CACHE_RESPAWN_MS = 15 * 60_000;

const SKILLS = ['swordsmanship', 'tactics', 'magery', 'healing', 'lumberjacking', 'mining',
  'fishing', 'cooking', 'blacksmithy', 'alchemy', 'taming', 'treasurehunting'];

const SPELLS = {
  magicarrow: { name: 'Magic Arrow', mana: 4, minSkill: 0, dmg: [5, 10], words: 'In Por Ylem' },
  fireball: { name: 'Fireball', mana: 9, minSkill: 40, dmg: [12, 22], words: 'Vas Flam' },
  greaterheal: { name: 'Greater Heal', mana: 11, minSkill: 30, heal: [15, 25], words: 'In Vas Mani' },
  bless: { name: 'Bless', mana: 8, minSkill: 25, buff: 8, buffMs: 60_000, words: 'Rel Sanct' },
  poison: { name: 'Poison', mana: 6, minSkill: 20, dot: [3, 5], words: 'In Nox' },
  energybolt: { name: 'Energy Bolt', mana: 14, minSkill: 55, dmg: [20, 30], words: 'Corp Por' },
  icebolt: { name: 'Ice Bolt', mana: 8, minSkill: 35, dmg: [10, 18], slowMs: 4000, words: 'In Corp Del' },
  chainlightning: { name: 'Chain Lightning', mana: 18, minSkill: 65, dmg: [15, 25], chain: 2, words: 'Vas Ort Grav' },
  haste: { name: 'Haste', mana: 12, minSkill: 45, hasteMs: 10_000, words: 'Rel Por' },
};

const MOB_KINDS = {
  goblin: { name: 'a goblin', hp: 16, dmg: [2, 4], skill: 22, gold: 6, speedMs: 350, aggro: 6 },
  skeleton: { name: 'a skeleton', hp: 32, dmg: [3, 7], skill: 45, gold: 18, speedMs: 500, aggro: 7 },
  orc: { name: 'an orc', hp: 48, dmg: [4, 9], skill: 55, gold: 30, speedMs: 450, aggro: 7 },
  ettin: { name: 'an ettin', hp: 95, dmg: [8, 16], skill: 65, gold: 70, speedMs: 600, aggro: 8 },
  dragon: { name: 'a dragon', hp: 320, dmg: [16, 30], skill: 95, gold: 600, speedMs: 400, aggro: 10, boss: true },
  // Wildlife and livestock. aggro 0 means they never start a fight.
  wolf: { name: 'a wolf', hp: 26, dmg: [3, 6], skill: 35, gold: 8, speedMs: 380, aggro: 5 },
  deer: { name: 'a deer', hp: 14, dmg: [1, 2], skill: 8, gold: 3, speedMs: 350, aggro: 0 },
  sheep: { name: 'a sheep', hp: 10, dmg: [0, 1], skill: 5, gold: 2, speedMs: 700, aggro: 0 },
  pig: { name: 'a pig', hp: 12, dmg: [1, 2], skill: 5, gold: 3, speedMs: 650, aggro: 0 },
  chicken: { name: 'a chicken', hp: 4, dmg: [0, 1], skill: 3, gold: 1, speedMs: 500, aggro: 0 },
  // Mire dwellers.
  snake: { name: 'a bog serpent', hp: 22, dmg: [3, 6], skill: 35, gold: 5, speedMs: 380, aggro: 5 },
  crab: { name: 'a marsh crab', hp: 18, dmg: [2, 5], skill: 22, gold: 4, speedMs: 600, aggro: 3 },
  boar: { name: 'a wild boar', hp: 30, dmg: [3, 7], skill: 32, gold: 6, speedMs: 420, aggro: 4 },
  // Townsfolk: protected by the crown, prone to small talk.
  villager: { name: 'a villager', hp: 30, dmg: [0, 1], skill: 5, gold: 0, speedMs: 900, aggro: 0, peaceful: true },
  // City guards never trouble travellers, but anything hostile that slips
  // inside the walls answers to them.
  guard: { name: 'a town guard', hp: 160, dmg: [10, 18], skill: 85, gold: 60, speedMs: 320, aggro: 0, peaceful: true, guard: true },
  // Crowned terrors. Slain ones return after a long while.
  goblinking: { name: 'Skarg, the Goblin King', hp: 130, dmg: [6, 12], skill: 60, gold: 220, speedMs: 320, aggro: 9, boss: true },
  vyrmaur: { name: 'Vyrmaur the Undying', hp: 900, dmg: [22, 40], skill: 110, gold: 1500, speedMs: 380, aggro: 12, boss: true },
  bonelord: { name: 'the Bone Lord', hp: 170, dmg: [8, 14], skill: 75, gold: 280, speedMs: 450, aggro: 9, boss: true },
  wolfking: { name: 'Greyfang, the Wolf King', hp: 150, dmg: [7, 13], skill: 70, gold: 240, speedMs: 330, aggro: 9, boss: true },
  skelmage: { name: 'a skeleton mage', hp: 26, dmg: [2, 4], skill: 50, gold: 24, speedMs: 550, aggro: 8, caster: { range: 7, dmg: [6, 12], cdMs: 2600 } },
  whitestag: { name: 'the White Stag', hp: 60, dmg: [1, 2], skill: 30, gold: 50, speedMs: 260, aggro: 0 },
  // The restless dead: corpses shamble at the barrows, and after dark the
  // ghosts rise with them (their spawners are marked nightOnly).
  zombie: { name: 'a shambling corpse', hp: 42, dmg: [4, 9], skill: 40, gold: 14, speedMs: 750, aggro: 6 },
  ghost: { name: 'a restless ghost', hp: 30, dmg: [4, 9], skill: 55, gold: 24, speedMs: 420, aggro: 7 },
  // Wilder company: harpies roost on the high crags, goblin wolf-riders run
  // with the orc warbands.
  harpy: { name: 'a harpy', hp: 34, dmg: [4, 8], skill: 50, gold: 26, speedMs: 300, aggro: 8 },
  wolfrider: { name: 'a goblin wolf-rider', hp: 44, dmg: [5, 10], skill: 58, gold: 34, speedMs: 290, aggro: 8 },
  // The Crimson Count sleeps beneath the second ruined keep, and every
  // wound he deals feeds him.
  vampire: { name: 'the Crimson Count', hp: 280, dmg: [12, 22], skill: 88, gold: 420, speedMs: 350, aggro: 10, boss: true, vampiric: true },
  // The mountain clans: miners work the high quarries under the halberds
  // of their wardens. Peaceful — but the wardens answer anything hostile.
  dwarf: { name: 'a dwarf miner', hp: 40, dmg: [3, 7], skill: 40, gold: 0, speedMs: 600, aggro: 0, peaceful: true },
  dwarfguard: { name: 'a dwarf warden', hp: 150, dmg: [9, 16], skill: 80, gold: 55, speedMs: 400, aggro: 0, peaceful: true, guard: true },
  dwarfpriest: { name: 'a rune-priest', hp: 60, dmg: [2, 5], skill: 50, gold: 0, speedMs: 650, aggro: 0, peaceful: true },
  // The warlord's own: harder company than the common camps, and Gruk
  // himself under the white-crested banner.
  orcbrute: { name: 'an orc brute', hp: 82, dmg: [7, 13], skill: 62, gold: 45, speedMs: 500, aggro: 8 },
  orcwarlord: { name: 'Gruk, Warlord of the Wastes', hp: 340, dmg: [14, 24], skill: 90, gold: 520, speedMs: 380, aggro: 10, boss: true },
  // The deep-wood folk suffer no trespass beneath their pines.
  elfranger: { name: 'an elf ranger', hp: 45, dmg: [4, 8], skill: 60, gold: 30, speedMs: 350, aggro: 5, caster: { range: 8, dmg: [5, 10], cdMs: 2200, fx: 'arrow' } },
  dryad: { name: 'a dryad', hp: 35, dmg: [3, 7], skill: 45, gold: 22, speedMs: 400, aggro: 4 },
  treant: { name: 'an elder treant', hp: 190, dmg: [10, 18], skill: 75, gold: 95, speedMs: 800, aggro: 5 },
  // The mire-folk of the sunken warren.
  lizardman: { name: 'a lizardman warrior', hp: 55, dmg: [5, 11], skill: 60, gold: 35, speedMs: 420, aggro: 7 },
  raptor: { name: 'a swamp raptor', hp: 38, dmg: [4, 9], skill: 50, gold: 12, speedMs: 280, aggro: 8 },
};

// The wider bestiary: every remaining creature in the packs, so the world
// builder can place ANY of them. [kind, display name, tier 1-7, overrides].
// Stats scale with the sheet tier; overrides adjust the exceptions.
const BESTIARY = [
  // Castle
  ['pikeman', 'a pikeman', 2], ['outrider', 'an outrider', 3],
  ['swordsman', 'a swordsman', 3], ['monk', 'a monk', 4, { caster: { range: 7, dmg: [5, 10], cdMs: 2500 } }],
  ['knight', 'a knight', 5], ['halberdier', 'a halberdier', 3],
  ['crossbowman', 'a crossbowman', 3, { caster: { range: 8, dmg: [5, 10], cdMs: 2400, fx: 'arrow' } }],
  ['cavalier', 'a cavalier', 6], ['squire', 'a squire', 2],
  ['whiteknight', 'a white knight', 6], ['paladin', 'a paladin', 7],
  // Rampart
  ['pixie', 'a pixie', 1], ['hilldwarf', 'a hill dwarf', 2],
  ['woodarcher', 'a wood archer', 3, { caster: { range: 8, dmg: [4, 9], cdMs: 2300, fx: 'arrow' } }],
  ['silverstag', 'a silver stag', 4, { aggro: 0 }], ['youngtreant', 'a young treant', 4],
  ['flowersprite', 'a flower sprite', 1], ['grovekeeper', 'a grove keeper', 4],
  ['greatelk', 'a great elk', 5, { aggro: 0 }], ['darktreant', 'a dark treant', 6],
  // Inferno
  ['imp', 'an imp', 1], ['fireimp', 'a fire imp', 2],
  ['lesserdemon', 'a lesser demon', 3], ['hellion', 'a hellion', 3],
  ['burningone', 'a burning one', 4], ['demon', 'a demon', 5],
  ['pitfiend', 'a pit fiend', 4], ['devil', 'a devil', 6, { caster: { range: 7, dmg: [8, 14], cdMs: 2600 } }],
  ['shadowbeast', 'a shadow beast', 4], ['hornedbrute', 'a horned brute', 5],
  ['pitlord', 'a pit lord', 6], ['magmafiend', 'a magma fiend', 7],
  // Tower
  ['adept', 'an adept', 1], ['gargoyle', 'a gargoyle', 2],
  ['stonegolem', 'a stone golem', 3], ['mage', 'a mage', 4, { caster: { range: 8, dmg: [6, 12], cdMs: 2500 } }],
  ['genie', 'a genie', 5], ['irongolem', 'an iron golem', 5],
  ['naga', 'a naga', 6], ['battleadept', 'a battle adept', 2],
  ['obsidiangargoyle', 'an obsidian gargoyle', 3], ['goldgolem', 'a gold golem', 6],
  ['archmage', 'an archmage', 5, { caster: { range: 9, dmg: [8, 15], cdMs: 2600 } }],
  ['djinn', 'a djinn', 6], ['nagaqueen', 'a naga queen', 7], ['titan', 'a titan', 7],
  // Necromancer
  ['cryptswarm', 'a crypt swarm', 1], ['wight', 'a wight', 3],
  ['lich', 'a lich', 6, { caster: { range: 8, dmg: [8, 14], cdMs: 2600 } }],
  ['deathknight', 'a death knight', 6], ['rottinghulk', 'a rotting hulk', 5],
  ['tombspider', 'a tomb spider', 3], ['vampirelord', 'a vampire lord', 7, { vampiric: true }],
  ['dreadknight', 'a dread knight', 7],
  // Stronghold
  ['centaur', 'a centaur', 3], ['orcshaman', 'an orc shaman', 4, { caster: { range: 7, dmg: [6, 11], cdMs: 2500 } }],
  ['ogre', 'an ogre', 5], ['cyclops', 'a cyclops', 6],
  ['goblinveteran', 'a goblin veteran', 2], ['rocrider', 'a roc rider', 5],
  ['wolfraider', 'a wolf raider', 4], ['boarrider', 'a boar rider', 4],
  ['cyclopsking', 'a cyclops king', 7],
  // Dwarves
  ['dwarfaxeman', 'a dwarf axeman', 3], ['dwarfcrossbow', 'a dwarf crossbowman', 3, { caster: { range: 8, dmg: [5, 10], cdMs: 2400, fx: 'arrow' } }],
  ['warram', 'a war ram', 2, { aggro: 4 }], ['dwarfspearman', 'a dwarf spearman', 3],
  ['dwarfoutrider', 'a dwarf outrider', 4], ['ramcavalier', 'a ram cavalier', 5],
  ['cavebear', 'a cave bear', 5, { aggro: 5 }], ['elkrider', 'an elk rider', 4],
  ['runicgolem', 'a runic golem', 6], ['stoneguardian', 'a stone guardian', 6],
  // Orcs Empire
  ['goblinarcher', 'a goblin archer', 2, { caster: { range: 7, dmg: [3, 7], cdMs: 2200, fx: 'arrow' } }],
  ['orcgrunt', 'an orc grunt', 2], ['orcspearman', 'an orc spearman', 3],
  ['orcraider', 'an orc raider', 4], ['orcchampion', 'an orc champion', 5],
  // WoodElves
  ['willowtreant', 'a willow treant', 5], ['autumntreant', 'an autumn treant', 5],
  ['elfswordsman', 'an elf swordsman', 3], ['elfscout', 'an elf scout', 2],
  ['forestcentaur', 'a forest centaur', 4], ['elfkeeper', 'an elf keeper', 4],
  ['brownbear', 'a brown bear', 5, { aggro: 5 }], ['direwolf', 'a dire wolf', 4],
  ['owlbear', 'an owlbear', 6], ['blackboar', 'a black boar', 3, { aggro: 4 }],
  ['bladedancer', 'a blade-dancer', 5],
  // Lizardmen
  ['hatchling', 'a hatchling', 1], ['marshraptor', 'a marsh raptor', 2],
  ['armoredcroc', 'an armored croc', 5], ['marshnaga', 'a marsh naga', 4],
  ['lizardassassin', 'a lizard assassin', 4], ['goldengecko', 'a golden gecko', 2],
  ['fenserpent', 'a fen serpent', 3], ['crocwarden', 'a croc warden', 5],
  ['duneserpent', 'a dune serpent', 3], ['bogcroc', 'a bog croc', 4],
  ['salamander', 'a salamander', 6], ['basilisk', 'a basilisk', 7],
  // Wildlife
  ['rabbit', 'a rabbit', 1, { aggro: 0, dmg: [0, 1], gold: 1 }],
  ['giantrat', 'a giant rat', 1, { aggro: 4 }],
  ['fox', 'a fox', 1, { aggro: 0 }],
  ['badger', 'a badger', 2, { aggro: 3 }],
];
for (const [kind, name, tier, opts] of BESTIARY) {
  MOB_KINDS[kind] = {
    name,
    hp: 12 + tier * 14,
    dmg: [tier, 2 + tier * 2],
    skill: 15 + tier * 10,
    gold: 3 + tier * 6,
    speedMs: 560 - tier * 25,
    aggro: 7,
    ...(opts || {}),
  };
}

const VILLAGER_NAMES = ['Tomlin', 'Berta', 'Old Casso', 'Wilmot', 'Ysolde', 'Pell',
  'Marta', 'Edric', 'Nan', 'Osric', 'Tilly', 'Bram', 'Greta', 'Hob', 'Sera', 'Dunstan'];

const VILLAGER_LINES = [
  'Fine weather for the crops.',
  'Mind the wolves if thou art headed north.',
  'They say the old keep is haunted. I believe it.',
  'A dragon took my cousin\'s sheep. The whole flock!',
  'The alchemist pays good coin... for what, I dare not ask.',
  'Welcome, traveller. The shrine will keep thee safe.',
  'I heard the standing stones can carry you across the world.',
  'Gems! A fellow came through with a fistful of gems last week.',
  'My grandmother swore something old sleeps at the rim of the world.',
];

// The quarry clans keep their own counsel.
const DWARF_LINES = [
  'The seam runs deep here, and the ore runs true.',
  'Ettins took the east quarry. We do not speak of the east quarry.',
  'Mind thy boots. The last one who kicked over a rune-stone limps yet.',
  'The mountain gives to those who ask with a pick, not a sword.',
  'We sell nothing. We owe nothing. Good day to thee.',
];
const GOSSIP_LINES = { dwarf: DWARF_LINES, dwarfguard: DWARF_LINES, dwarfpriest: DWARF_LINES };

// What corpses leave behind, beyond the guaranteed gold: [chance, item, min, max].
// Weapon rows are [chance, 'weapon', pool of ids, qualityMin, qualityMax].
const LOOT_TABLES = {
  goblin: [[0.18, 'gold', 4, 10], [0.08, 'mana', 1, 1], [0.04, 'weapon', ['dagger'], 0, 1]],
  skeleton: [[0.2, 'gold', 8, 20], [0.12, 'heal', 1, 1], [0.1, 'weapon', ['sword'], 0, 2]],
  skelmage: [[0.4, 'gold', 10, 26], [0.2, 'mana', 1, 2]],
  orc: [[0.22, 'gold', 12, 30], [0.12, 'heal', 1, 1], [0.1, 'ore', 1, 2], [0.08, 'weapon', ['sword', 'mace'], 0, 1], [0.04, 'tmap']],
  ettin: [[0.35, 'gold', 30, 70], [0.2, 'heal', 1, 1], [0.15, 'logs', 2, 4], [0.1, 'weapon', ['battleaxe'], 1, 2], [0.06, 'tmap']],
  dragon: [[1, 'gold', 150, 400], [0.8, 'heal', 1, 2], [0.6, 'mana', 1, 2], [0.5, 'gems', 1, 2], [0.5, 'weapon', ['greatsword'], 3, 4]],
  wolf: [[0.3, 'gold', 3, 10]],
  deer: [[0.35, 'gold', 2, 6], [0.5, 'meat', 1, 1]],
  snake: [[0.3, 'gold', 3, 9], [0.06, 'mana', 1, 1], [0.35, 'herbs', 1, 2]],
  crab: [[0.3, 'gold', 2, 7]],
  boar: [[0.35, 'gold', 3, 10], [0.08, 'heal', 1, 1], [0.6, 'meat', 1, 2]],
  whitestag: [[1, 'gold', 40, 90], [1, 'gems', 2, 4]],
  goblinking: [[1, 'gold', 100, 250], [1, 'gems', 1, 2], [0.6, 'heal', 1, 2], [1, 'weapon', ['sword', 'mace'], 2, 3], [0.5, 'tmap']],
  bonelord: [[1, 'gold', 120, 300], [1, 'gems', 1, 2], [0.6, 'mana', 1, 2], [1, 'weapon', ['battleaxe', 'greatsword'], 2, 4]],
  wolfking: [[1, 'gold', 100, 260], [1, 'gems', 1, 2], [0.6, 'heal', 1, 2], [1, 'weapon', ['sword'], 2, 3]],
  vyrmaur: [[1, 'gold', 800, 1500], [1, 'gems', 3, 6], [1, 'heal', 2, 3]],
  zombie: [[0.25, 'gold', 6, 16], [0.1, 'heal', 1, 1]],
  ghost: [[0.3, 'gold', 10, 24], [0.15, 'mana', 1, 2], [0.05, 'gems', 1, 1]],
  harpy: [[0.3, 'gold', 10, 26], [0.1, 'gems', 1, 1], [0.06, 'tmap']],
  wolfrider: [[0.28, 'gold', 12, 30], [0.1, 'heal', 1, 1], [0.06, 'weapon', ['mace', 'sword'], 0, 2]],
  vampire: [[1, 'gold', 200, 450], [1, 'gems', 2, 4], [0.6, 'heal', 1, 2], [0.6, 'mana', 1, 2],
            [1, 'weapon', ['greatsword', 'battleaxe'], 2, 4], [0.5, 'tmap']],
  orcbrute: [[0.3, 'gold', 20, 45], [0.14, 'heal', 1, 1], [0.12, 'ore', 1, 3],
             [0.08, 'weapon', ['mace', 'battleaxe'], 0, 2], [0.05, 'tmap']],
  orcwarlord: [[1, 'gold', 250, 500], [1, 'gems', 2, 3], [0.7, 'heal', 1, 2],
               [1, 'weapon', ['battleaxe', 'greatsword'], 2, 4], [0.6, 'tmap']],
  elfranger: [[0.3, 'gold', 12, 30], [0.1, 'mana', 1, 1], [0.1, 'weapon', ['longbow'], 1, 3]],
  dryad: [[0.3, 'gold', 8, 20], [0.15, 'mana', 1, 2], [0.2, 'logs', 1, 3], [0.6, 'herbs', 1, 3]],
  treant: [[0.6, 'gold', 40, 100], [0.8, 'logs', 4, 9], [0.3, 'gems', 1, 2], [0.5, 'herbs', 2, 4]],
  lizardman: [[0.3, 'gold', 14, 34], [0.1, 'heal', 1, 1], [0.08, 'gems', 1, 1],
              [0.06, 'weapon', ['sword', 'mace'], 0, 2]],
  raptor: [[0.3, 'gold', 5, 14], [0.4, 'meat', 1, 2]],
};

// Mirrors the client's sky exactly (same clock, same curve): darkness is 0
// at noon and ~0.62 at deepest night. Past 0.3 counts as night — the same
// threshold the client uses to switch to the night music.
const DAY_MS = 20 * 60_000;
function dayDarkness() {
  const phase = (Date.now() % DAY_MS) / DAY_MS;
  return Math.max(0, -Math.cos(phase * Math.PI * 2)) * 0.62;
}

const DROP_TTL_MS = 60_000;
const RESOURCE_RESPAWN_MS = 90_000;

const POTIONS = {
  heal: { name: 'Greater Heal Potion', restore: [25, 40] },
  mana: { name: 'Mana Potion', restore: [20, 30] },
};

// Alchemy: herbs + a little gold become potions at any alchemist's bench.
const BREWS = {
  heal: { name: 'Greater Heal Potion', herbs: 2, gold: 8 },
  mana: { name: 'Mana Potion', herbs: 2, gold: 5 },
};

// What a beast-tamer may win over, and the skill it takes to try.
// Chance also weighs the beast's own prowess, so a wolf resists harder
// than a chicken even for the same doorstep skill.
const TAMEABLE = {
  chicken: 0, rabbit: 0, sheep: 0, pig: 5, deer: 10, fox: 15,
  giantrat: 20, crab: 20, badger: 25, boar: 30, snake: 40, wolf: 45,
  blackboar: 50, silverstag: 50, greatelk: 55, warram: 55, direwolf: 60,
  brownbear: 70, cavebear: 75,
};

// dur is how many durability points a common example has; each landed hit
// has a 25% chance to spend one. craft lists the forge recipe materials.
const WEAPONS = {
  dagger:     { name: 'Dagger',     dmg: [3, 7],   speedMs: 1100, price: 40,  dur: 90,  sprite: 'dagger',     craft: { ore: 3, logs: 1, gold: 10 } },
  sword:      { name: 'Longsword',  dmg: [5, 12],  speedMs: 1500, price: 120, dur: 110, sprite: 'longsword',  craft: { ore: 8, logs: 3, gold: 30 } },
  mace:       { name: 'Mace',       dmg: [7, 14],  speedMs: 1800, price: 150, dur: 120, sprite: 'mace',       craft: { ore: 10, logs: 4, gold: 40 } },
  battleaxe:  { name: 'Battle Axe', dmg: [9, 17],  speedMs: 2100, price: 260, dur: 130, minSkill: 40, sprite: 'battle_axe', craft: { ore: 14, logs: 5, gold: 70, sunsteel: 2 } },
  greatsword: { name: 'Greatsword', dmg: [12, 22], speedMs: 2400, price: 420, dur: 140, minSkill: 60, sprite: 'greatsword', craft: { ore: 20, logs: 6, gold: 120, frostwood: 2 } },
  longbow:    { name: 'Longbow',    dmg: [6, 13],  speedMs: 1700, price: 180, dur: 100, minSkill: 30, sprite: 'longbow', ranged: true, range: 8, craft: { ore: 2, logs: 10, gold: 40 } },
  // Armor and shields share the same item machinery; slot routes the equip.
  leatherarmor: { name: 'Leather Tunic',  slot: 'chest', dr: 2, price: 100, dur: 120, sprite: 'leather', craft: { ore: 2, logs: 6, gold: 25 } },
  chainmail:    { name: 'Chain Cuirass',  slot: 'chest', dr: 4, price: 320, dur: 160, minSkill: 40, sprite: 'chain', craft: { ore: 16, logs: 2, gold: 90 } },
  buckler:      { name: 'Buckler',        slot: 'offhand', block: 10, price: 90,  dur: 100, sprite: 'buckler', craft: { ore: 4, logs: 4, gold: 20 } },
  kiteshield:   { name: 'Kite Shield',    slot: 'offhand', block: 18, price: 280, dur: 150, minSkill: 35, sprite: 'kite_shield', craft: { ore: 12, logs: 6, gold: 70, ironbark: 2 } },
  // There is only one. It is not for sale, and no forge will make another.
  dawnbreaker: { name: 'Dawnbreaker', dmg: [18, 30], speedMs: 2000, price: 2500, dur: 600, sprite: 'greatsword', secret: true },
};

const ARROW_BUNDLE = 20;

const QUALITIES = [
  { name: 'Shoddy',      dmgMul: 0.85, durMul: 0.6, priceMul: 0.5 },
  { name: '',            dmgMul: 1.0,  durMul: 1.0, priceMul: 1.0 },
  { name: 'Fine',        dmgMul: 1.15, durMul: 1.4, priceMul: 2.0 },
  { name: 'Exceptional', dmgMul: 1.3,  durMul: 1.9, priceMul: 4.0 },
  { name: 'Masterwork',  dmgMul: 1.45, durMul: 2.5, priceMul: 8.0 },
  { name: '',            dmgMul: 1.0,  durMul: 1.0, priceMul: 1.0 }, // the legend speaks for itself
];

const ITEM_CAP = 10;
const UNARMED = { dmg: [1, 4], speedMs: 1300 };

function weaponLabel(item) {
  const q = QUALITIES[item.q].name;
  return (q ? q + ' ' : '') + WEAPONS[item.id].name;
}

function weaponPrice(id, q) {
  return Math.round(WEAPONS[id].price * QUALITIES[q].priceMul);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const now = () => Date.now();

// Limit "pack is full" spam while standing on a weapon drop.
function t0Throttle(p) {
  const t = now();
  if (t < (p.nagAt || 0)) return false;
  p.nagAt = t + 4000;
  return true;
}

const DEED_NAMES = {
  firstblood: 'First Blood',
  dragonslayer: 'Dragonslayer',
  kingslayer: 'Slayer of Kings',
  legend: 'Bearer of the Dawn',
  angler: 'First Catch',
  smith: 'At the Anvil',
  wayfarer: 'Wayfarer',
  grandmaster: 'Grandmaster',
  brewer: 'First Draught',
  beastfriend: 'A Loyal Companion',
  digger: 'X Marks the Spot',
};

function titleOf(p) {
  for (const sk of SKILLS) {
    if (p.skills[sk] >= 100) {
      return 'Grandmaster ' + skillName(sk);
    }
  }
  return '';
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

class Game {
  constructor() {
    this.map = generate(1337);
    // The world builder's overlay sits on top of worldgen. It lives in the
    // data dir (a mounted volume in prod, so it survives redeploys); the
    // repo's world/edits.json is the published copy — whichever of the two
    // is newer wins, so a GitHub publish followed by a redeploy takes hold.
    this.editsPath = path.join(persist.DATA_DIR, 'edits.json');
    const legacyEditsPath = path.join(__dirname, '..', 'world', 'edits.json');
    const readEdits = (p) => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') console.error(`${p} is broken, skipping it:`, e.message);
        return null;
      }
    };
    // Pristine worldgen state, snapshotted before any edits: the live
    // editor needs it to un-remove things without a reboot.
    this.pristineProps = this.map.props.map((p) => ({ ...p }));
    this.pristineSpawners = this.map.spawners.map((s) => ({ ...s }));
    this.pristineSecrets = this.map.secrets.map((s) => ({ ...s }));
    this.pristineVendors = this.map.vendors.map((v) => JSON.parse(JSON.stringify(v)));
    const dataEdits = readEdits(this.editsPath);
    const repoEdits = readEdits(legacyEditsPath);
    const edits = (dataEdits && repoEdits)
      ? ((repoEdits.savedAt || 0) > (dataEdits.savedAt || 0) ? repoEdits : dataEdits)
      : (dataEdits || repoEdits);
    this.appliedEdits = edits ? JSON.parse(JSON.stringify(edits)) : {};
    if (edits) {
      const c = applyEdits(this.map, edits, { validKinds: new Set(Object.keys(MOB_KINDS)),
        validWeapons: new Set(Object.keys(WEAPONS)) });
      console.log(`map edits: ${c.tiles} tiles, ${c.props} props, ${c.spawners} spawners, ` +
        `${c.secrets} secrets, ${c.buildings || 0} buildings, ${c.vendors || 0} vendors, ` +
        `${c.removed} removals`);
    }
    this.players = new Map(); // id -> player (online only)
    this.mobs = new Map();    // id -> mob
    this.nextId = 1;
    this.records = persist.load();          // char key -> saved character
    this.accounts = persist.loadAccounts(); // email -> { salt, hash, charKey }
    this.dirty = false;
    this.resources = new Map(); // "x,y" -> gathers left before depletion
    this.depleted = new Map();  // "x,y" -> { tile, respawnAt }
    this.drops = new Map();     // id -> { id, x, y, item, amount, despawnAt, cacheIdx? }
    this.pendingAoes = [];      // telegraphed boss slams awaiting impact
    this.cacheRespawns = new Map(); // secret index -> respawn time

    // Vendors come from worldgen; negative ids keep them clear of mob ids.
    this.vendors = this.map.vendors.map((v, i) => ({ ...v, id: -(i + 1), kind: 'vendor' }));

    this.spawners = this.map.spawners;
    for (const sp of this.spawners) {
      sp.alive = new Set();
      for (let i = 0; i < sp.count; i++) this.spawnMob(sp);
    }

    // Hidden treasure caches start stocked.
    this.map.secrets.forEach((s, i) => {
      if (s.type === 'cache') this.stockCache(s, i);
    });

    this.miniData = this.buildMini();
    this.event = null;
    setInterval(() => this.maybeStartEvent(), 60_000);

    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.saveAll(), SAVE_INTERVAL_MS);
  }

  // A small overview of the world for the client's minimap: one byte (tile
  // id) per MINI_SCALE x MINI_SCALE block.
  buildMini() {
    const w = this.map.w / MINI_SCALE;
    const h = this.map.h / MINI_SCALE;
    const out = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Centre sample, but let towns and roads win so they stay visible.
        let t = this.map.tiles[(y * MINI_SCALE + 4) * this.map.w + x * MINI_SCALE + 4];
        for (let dy = 0; dy < MINI_SCALE; dy += 2) {
          for (let dx = 0; dx < MINI_SCALE; dx += 2) {
            const tt = this.map.tiles[(y * MINI_SCALE + dy) * this.map.w + x * MINI_SCALE + dx];
            if (tt === TILE.FLOOR || tt === TILE.ROAD || tt === TILE.SHRINE) t = tt;
          }
        }
        out[y * w + x] = t;
      }
    }
    return { w, h, s: MINI_SCALE, d: out.toString('base64') };
  }

  stockCache(secret, idx) {
    for (const [item, min, max] of secret.loot) {
      const amount = rand(min, max);
      if (amount <= 0) continue;
      this.drops.set(this.nextId, {
        id: this.nextId++,
        x: secret.x, y: secret.y,
        item, amount,
        despawnAt: Infinity,
        cacheIdx: idx,
      });
    }
  }

  // ---- connection lifecycle -------------------------------------------------

  join(ws, msg) {
    const email = String(msg.email || '').trim().toLowerCase();
    const password = String(msg.password || '');
    const name = String(msg.name || '').trim();
    const token = String(msg.token || '');

    let account = null;
    let rec;

    // A bearer token from a previous session signs in without a password.
    if (token) {
      const tb = Buffer.from(token);
      account = Object.values(this.accounts).find((a) =>
        a.token && a.token.exp > Date.now() && a.token.v.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(a.token.v), tb)) || null;
      if (!account) {
        return this.send(ws, { t: 'reject', reason: 'Your session has expired. Sign in again.', expired: true });
      }
      rec = this.records[account.charKey];
      if (!rec) {
        return this.send(ws, { t: 'reject', reason: 'Account has no character. Contact the shard keeper.', expired: true });
      }
    } else {
      if (!EMAIL_RE.test(email)) {
        return this.send(ws, { t: 'reject', reason: 'Enter a valid email address.' });
      }
      if (password.length < 6) {
        return this.send(ws, { t: 'reject', reason: 'Password must be at least 6 characters.' });
      }

      account = this.accounts[email];

      if (account) {
        const hash = hashPassword(password, account.salt);
        if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(account.hash))) {
          return this.send(ws, { t: 'reject', reason: 'Wrong password for that account.' });
        }
        rec = this.records[account.charKey];
        if (!rec) {
          return this.send(ws, { t: 'reject', reason: 'Account has no character. Contact the shard keeper.' });
        }
      } else {
        // New account: also creates its character.
        if (!/^[A-Za-z][A-Za-z0-9 '-]{1,14}$/.test(name)) {
          return this.send(ws, { t: 'reject', reason: 'New account: choose a character name (2-15 letters/numbers).' });
        }
        const key = name.toLowerCase();
        if (this.records[key]) {
          return this.send(ws, { t: 'reject', reason: 'That character name is already taken.' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        account = this.accounts[email] = {
          email, salt,
          hash: hashPassword(password, salt),
          charKey: key,
        };
        rec = this.records[key] = {
          name,
          x: this.map.spawn.x,
          y: this.map.spawn.y,
          str: 35, dex: 35, int: 30,
          hp: 67, mana: 30,
          skills: Object.fromEntries(SKILLS.map((s) => [s, 20])),
          gold: 100, logs: 0, ore: 0, gems: 0,
          pots: { heal: 1, mana: 0 },
          items: [{ uid: 1, id: 'dagger', q: 0, dur: 54, maxDur: 54 }],
          weapon: 1,
          armor: null,
          offhand: null,
          arrows: 0,
          itemUid: 2,
        };
        persist.saveAccounts(this.accounts);
        // save the record alongside the account, atomically from the player's
        // point of view — a crash between the two must not strand an account
        // that points at a character which was never written
        persist.save(this.records);
        this.dirty = false;
      }
    }

    for (const p of this.players.values()) {
      if (p.key === account.charKey) {
        return this.send(ws, { t: 'reject', reason: 'That character is already in the world.' });
      }
    }

    // Every successful sign-in rotates a fresh week-long session token, so
    // returning players skip the password screen.
    account.token = { v: crypto.randomBytes(24).toString('hex'), exp: Date.now() + 7 * 86_400_000 };
    persist.saveAccounts(this.accounts);

    const spot = isWalkable(this.map, rec.x, rec.y)
      ? { x: rec.x, y: rec.y }
      : nearestWalkable(this.map, rec.x, rec.y);

    const p = {
      id: this.nextId++,
      ws,
      name: rec.name,
      key: account.charKey,
      x: spot.x,
      y: spot.y,
      str: rec.str, dex: rec.dex, int: rec.int,
      hp: Math.min(rec.hp, maxHp(rec)), mana: Math.min(rec.mana, rec.int),
      skills: { ...Object.fromEntries(SKILLS.map((sk) => [sk, 20])), ...rec.skills },
      gold: rec.gold, logs: rec.logs, ore: rec.ore, gems: rec.gems || 0,
      fish: rec.fish || 0, meat: rec.meat || 0, food: rec.food || 0,
      herbs: rec.herbs || 0,
      // drop map indices that no longer point at a cache (the world layout
      // can change between versions; old saves must not crash the dig check)
      tmaps: (rec.tmaps || []).filter((i) => Number.isInteger(i) &&
        this.map.secrets[i] && this.map.secrets[i].type === 'cache'),
      mats: { frostwood: 0, sunsteel: 0, ironbark: 0, ...rec.mats },
      deeds: { ...rec.deeds },
      pots: { heal: 0, mana: 0, ...rec.pots },
      items: (rec.items || []).map((i) => ({ ...i })),
      weapon: rec.weapon ?? null,
      armor: rec.armor ?? null,
      offhand: rec.offhand ?? null,
      arrows: rec.arrows || 0,
      home: rec.home || null,
      buffUntil: 0,
      itemUid: rec.itemUid || 1,
      dead: false,
      target: 0,
      moveAt: 0, swingAt: 0, castAt: 0, bandageAt: 0, regenAt: 0, drinkAt: 0, portalAt: 0,
      whispered: new Set(),
    };
    ws.player = p;
    this.players.set(p.id, p);

    // A faithful companion waits out its master's absence at the door.
    if (rec.pet && MOB_KINDS[rec.pet.kind] && TAMEABLE[rec.pet.kind] !== undefined) {
      this.spawnPet(p, rec.pet.kind, rec.pet.hp);
    }

    this.send(ws, {
      t: 'welcome',
      id: p.id,
      token: account.token.v,
      charName: rec.name,
      map: { w: this.map.w, h: this.map.h, chunk: CHUNK },
      mini: this.miniData,
      buildings: this.map.buildings,
      props: this.map.props,
      villages: this.map.villages.map((v) => ({ name: v.name, x: v.x, y: v.y })),
      cities: (this.map.cities || []).map((c) => ({ name: c.name, x: c.x, y: c.y, r: c.r })),
      epoch: Date.now(),
      spells: SPELLS,
      weapons: WEAPONS,
      qualities: QUALITIES,
      brews: BREWS,
      vendors: this.vendors,
      // every kind's plate name + disposition, so the client can label
      // builder-placed creatures it has no hand-written style for
      bestiary: Object.fromEntries(Object.entries(MOB_KINDS).map(([k, d]) =>
        [k, { n: d.name, d: d.peaceful ? 'friendly' : d.aggro === 0 ? 'neutral' : 'hostile',
              ...(TAMEABLE[k] !== undefined ? { tm: TAMEABLE[k] } : {}) }])),
    });
    this.sendYou(p);
    this.sys(p, `Welcome to Shardlands, ${p.name}. The shrine in Briarhaven will raise you if you fall.`);
    this.broadcastSys(`${p.name} has entered the world.`, p.id);
  }

  leave(ws) {
    const p = ws.player;
    if (!p) return;
    this.persistPlayer(p); // records the pet before it leaves the world
    const pet = this.petOf(p);
    if (pet) {
      this.mobs.delete(pet.id);
      pet.spawner.alive.delete(pet.id);
    }
    this.players.delete(p.id);
    // straight to disk: a crash after a disconnect must not lose the session
    persist.save(this.records);
    this.dirty = false;
    this.broadcastSys(`${p.name} has left the world.`);
  }

  persistPlayer(p) {
    const rec = this.records[p.key];
    if (!rec) return;
    Object.assign(rec, {
      x: p.x, y: p.y,
      str: p.str, dex: p.dex, int: p.int,
      hp: Math.max(1, p.hp), mana: p.mana,
      skills: { ...p.skills },
      gold: p.gold, logs: p.logs, ore: p.ore, gems: p.gems,
      fish: p.fish, meat: p.meat, food: p.food,
      herbs: p.herbs,
      pet: (() => { const pet = this.petOf(p); return pet ? { kind: pet.kind, hp: pet.hp } : null; })(),
      tmaps: (p.tmaps || []).slice(),
      mats: { ...p.mats },
      deeds: { ...p.deeds },
      pots: { ...p.pots },
      items: p.items.map((i) => ({ ...i })),
      weapon: p.weapon,
      armor: p.armor,
      offhand: p.offhand,
      arrows: p.arrows,
      home: p.home ? { ...p.home } : null,
      itemUid: p.itemUid,
    });
    this.dirty = true;
  }

  deed(p, id) {
    if (p.deeds[id]) return;
    p.deeds[id] = Date.now();
    this.sys(p, `⚑ Deed accomplished: ${DEED_NAMES[id] || id}.`);
    this.sendYou(p);
  }

  saveAll() {
    for (const p of this.players.values()) this.persistPlayer(p);
    if (this.dirty) {
      persist.save(this.records);
      this.dirty = false;
    }
  }

  // ---- message handling -----------------------------------------------------

  handle(ws, msg) {
    const p = ws.player;
    if (!p) {
      if (msg.t === 'join') this.join(ws, msg);
      return;
    }
    switch (msg.t) {
      case 'move': return this.handleMove(p, msg.dx | 0, msg.dy | 0);
      case 'say': return this.handleSay(p, msg.text);
      case 'attack': return this.handleAttack(p, msg.id | 0);
      case 'cast': return this.handleCast(p, msg.spell, msg.id | 0);
      case 'bandage': return this.handleBandage(p);
      case 'gather': return this.handleGather(p);
      case 'buy': return this.handleBuy(p, msg.idx | 0);
      case 'drink': return this.handleDrink(p, String(msg.kind || ''));
      case 'equip': return this.handleEquip(p, msg.uid == null ? null : msg.uid | 0);
      case 'sell': return this.handleSell(p, msg.uid | 0);
      case 'craft': return this.handleCraft(p, String(msg.id || ''));
      case 'story': return this.handleStory(p, msg.id | 0);
      case 'cook': return this.handleCook(p);
      case 'eat': return this.handleEat(p);
      case 'brew': return this.handleBrew(p, String(msg.kind || ''));
      case 'tame': return this.handleTame(p, msg.id | 0);
      case 'chunks': return this.handleChunks(p, msg.l);
    }
  }

  // A bard near the hearth tells the next tale in their repertoire, a line
  // every few seconds. Some tales point at real places; some are nonsense.
  handleStory(p, id) {
    const bard = this.vendors.find((v) => v.id === id && v.stories);
    if (!bard || dist(p, bard) > 4) return;
    const t = now();
    if (t < (p.storyAt || 0)) return;
    const story = bard.stories[(bard.nextStory = (bard.nextStory || 0) + 1) % bard.stories.length];
    p.storyAt = t + story.length * 3500 + 4000;
    story.forEach((line, i) => {
      const speak = () => this.fxNear(bard, { t: 'chat', id: bard.id, name: bard.name, text: line });
      if (i === 0) speak();
      else setTimeout(speak, i * 3500);
    });
  }

  nearCampfire(p) {
    return this.map.props.some((pr) =>
      pr.name === 'fx.campfire' && Math.abs(pr.x - p.x) <= 2 && Math.abs(pr.y - p.y) <= 2);
  }

  handleCook(p) {
    if (p.dead) return;
    if (!this.nearCampfire(p)) return this.sys(p, 'You need a campfire to cook.');
    if (p.fish <= 0 && p.meat <= 0) return this.sys(p, 'Nothing raw to cook. Fish or hunt first.');
    if (p.fish > 0) p.fish -= 1;
    else p.meat -= 1;
    if (Math.random() * 100 < p.skills.cooking + 35) {
      p.food += 1;
      this.sys(p, 'A hot meal, fit for the road.');
    } else {
      this.sys(p, 'It burns to a sad black crisp.');
    }
    this.gainSkill(p, 'cooking');
    this.sendYou(p);
  }

  handleEat(p) {
    if (p.dead) return;
    if (p.food <= 0) return this.sys(p, 'Your pack holds no cooked meals.');
    p.food -= 1;
    p.fedUntil = now() + 20_000;
    this.sys(p, 'You eat well. Warmth spreads through you.');
    this.sendYou(p);
  }

  // ---- alchemy: herbs into bottles at an alchemist's bench --------------------

  handleBrew(p, kind) {
    if (p.dead) return this.sys(p, 'The dead cannot work a mortar.');
    const brew = BREWS[kind];
    if (!brew) return;
    const bench = this.vendors.find((v) => dist(p, v) <= 3 &&
      (v.goods || []).some((g) => g.item === 'heal' || g.item === 'mana' || g.item === 'herbs'));
    if (!bench) return this.sys(p, 'You need an alchemist\'s bench to brew.');
    const t = now();
    if (t < (p.brewAt || 0)) return;
    p.brewAt = t + 1500;
    if (p.herbs < brew.herbs || p.gold < brew.gold) {
      return this.sys(p, `Brewing a ${brew.name} takes ${brew.herbs} herbs and ${brew.gold} gold for the bottle.`);
    }
    p.herbs -= brew.herbs;
    p.gold -= brew.gold;
    this.gainSkill(p, 'alchemy');
    if (Math.random() * 100 < p.skills.alchemy + 35) {
      p.pots[kind] += 1;
      this.deed(p, 'brewer');
      // A practiced hand sometimes draws a double measure from the same herbs.
      if (Math.random() * 100 < p.skills.alchemy / 2) {
        p.pots[kind] += 1;
        this.sys(p, `The mixture runs rich — two ${brew.name}s from one brewing!`);
      } else {
        this.sys(p, `You decant a ${brew.name}.`);
      }
      this.gainStat(p, 'int');
    } else {
      this.sys(p, 'The mixture curdles into worthless sludge.');
    }
    this.sendYou(p);
  }

  // ---- taming: win a wild heart, keep a companion ------------------------------

  petOf(p) {
    for (const m of this.mobs.values()) {
      if (m.owner === p.id) return m;
    }
    return null;
  }

  spawnPet(p, kind, hp) {
    const def = MOB_KINDS[kind];
    const stub = { alive: new Set(), x: p.x, y: p.y, r: 2, kind, respawnMs: 0 };
    this.spawnMob(stub);
    const id = [...stub.alive][0];
    const pet = id && this.mobs.get(id);
    if (!pet) return null;
    pet.owner = p.id;
    pet.name = `${p.name}'s ${def.name.replace(/^an? /, '')}`;
    if (hp) pet.hp = Math.min(pet.maxhp, hp);
    return pet;
  }

  handleTame(p, mobId) {
    if (p.dead) return this.sys(p, 'The dead keep no company.');
    const mob = this.mobs.get(mobId);
    if (!mob || dist(p, mob) > 4) return this.sys(p, 'No creature close enough to tame.');
    const def = MOB_KINDS[mob.kind];
    const minSkill = TAMEABLE[mob.kind];
    if (minSkill === undefined) return this.sys(p, `${def.name} cannot be tamed.`);
    if (mob.owner) return this.sys(p, 'That creature already answers to another.');
    if (this.petOf(p)) return this.sys(p, 'You already have a companion. /release it first.');
    if (p.skills.taming < minSkill) {
      return this.sys(p, `You need ${minSkill} Taming to approach ${def.name}.`);
    }
    const t = now();
    if (t < (p.tameAt || 0)) return;
    p.tameAt = t + 2000;
    this.gainSkill(p, 'taming');
    const chance = clamp(40 + p.skills.taming - def.skill, 5, 95);
    if (Math.random() * 100 < chance) {
      // Won over: it leaves its old life behind (the wilds send another).
      mob.spawner.alive.delete(mob.id);
      mob.spawner.respawnAt = t + (mob.spawner.respawnMs || 20_000);
      mob.spawner = { alive: new Set([mob.id]), x: mob.x, y: mob.y, r: 2, kind: mob.kind, respawnMs: 0 };
      mob.owner = p.id;
      mob.name = `${p.name}'s ${def.name.replace(/^an? /, '')}`;
      mob.target = 0;
      mob.fleeUntil = 0;
      mob.dest = null;
      this.deed(p, 'beastfriend');
      this.fxNear(mob, { t: 'fx', kind: 'heal', x: mob.x, y: mob.y, amount: 0 });
      this.sys(p, `${def.name.charAt(0).toUpperCase() + def.name.slice(1)} accepts you as its master.`);
    } else {
      mob.fleeUntil = t + 3000;
      mob.fleeFrom = { x: p.x, y: p.y };
      this.sys(p, `${def.name.charAt(0).toUpperCase() + def.name.slice(1)} shies away from you.`);
    }
  }

  // The companion's turn: heel to its master, savage its master's quarry.
  petTick(pet, t, def) {
    const owner = this.players.get(pet.owner);
    if (!owner) { // orphaned somehow: the bond breaks, the beast goes wild
      pet.owner = null;
      return;
    }
    let foe = owner.target ? this.mobs.get(owner.target) : null;
    if (foe && (foe === pet || foe.owner ||
        (MOB_KINDS[foe.kind].peaceful) || dist(owner, foe) > 12)) {
      foe = null;
    }
    if (foe && !owner.dead) {
      if (dist(pet, foe) <= 1.5) {
        if (t >= pet.swingAt) {
          pet.swingAt = t + 1200;
          pet.swungAt = t;
          const dmg = rand(def.dmg[0], def.dmg[1]) + Math.floor(owner.skills.taming / 20);
          foe.hp -= dmg;
          this.fxNear(foe, { t: 'fx', kind: 'hit', x: foe.x, y: foe.y, amount: dmg });
          if (foe.hp <= 0) return this.killMob(owner, foe);
        }
        // The quarry bites back: a beast in melee takes its share of wounds.
        const fdef = MOB_KINDS[foe.kind];
        if (t >= foe.swingAt) {
          foe.swingAt = t + 1600;
          foe.swungAt = t;
          const dmg = rand(fdef.dmg[0], fdef.dmg[1]);
          pet.hp -= dmg;
          this.fxNear(pet, { t: 'fx', kind: 'hit', x: pet.x, y: pet.y, amount: dmg });
          if (pet.hp <= 0) {
            this.mobs.delete(pet.id);
            pet.spawner.alive.delete(pet.id);
            this.fxNear(pet, { t: 'fx', kind: 'die', x: pet.x, y: pet.y });
            this.sys(owner, `${pet.name} has died defending you.`);
          }
        }
      } else if (t >= pet.moveAt) {
        pet.moveAt = t + (t < (pet.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
        this.stepToward(pet, foe.x, foe.y);
      }
      return;
    }
    // No fight: keep to heel. A pet left far behind finds its own way over.
    const d = dist(pet, owner);
    if (d > 18) {
      const spot = nearestWalkable(this.map, owner.x, owner.y);
      pet.x = spot.x;
      pet.y = spot.y;
    } else if (d > 2 && t >= pet.moveAt) {
      pet.moveAt = t + def.speedMs;
      this.stepToward(pet, owner.x, owner.y);
    }
    pet.homeX = pet.x;
    pet.homeY = pet.y;
    if (pet.hp < pet.maxhp && Math.random() < 0.03) pet.hp += 1;
  }

  chunkData(cx, cy) {
    const buf = Buffer.alloc(CHUNK * CHUNK);
    for (let y = 0; y < CHUNK; y++) {
      const row = (cy * CHUNK + y) * this.map.w + cx * CHUNK;
      for (let x = 0; x < CHUNK; x++) buf[y * CHUNK + x] = this.map.tiles[row + x];
    }
    return buf.toString('base64');
  }

  handleChunks(p, list) {
    if (!Array.isArray(list)) return;
    const maxC = this.map.w / CHUNK;
    for (const pair of list.slice(0, 48)) {
      if (!Array.isArray(pair)) continue;
      const cx = pair[0] | 0;
      const cy = pair[1] | 0;
      if (cx < 0 || cy < 0 || cx >= maxC || cy >= maxC) continue;
      this.send(p.ws, { t: 'chunk', cx, cy, d: this.chunkData(cx, cy) });
    }
  }

  handleBuy(p, idx) {
    if (p.dead) return this.sys(p, 'The dead cannot trade.');
    const vendor = this.vendors.find((v) => dist(p, v) <= 3);
    if (!vendor) return this.sys(p, 'You are too far from a shopkeeper.');
    const good = vendor.goods[idx];
    if (!good) return;

    if (good.type === 'weapon') {
      const price = weaponPrice(good.item, good.q);
      if (p.gold < price) {
        return this.sys(p, `${vendor.name} says: That is ${price} gold, which thou dost not have.`);
      }
      if (p.items.length >= ITEM_CAP) return this.sys(p, 'Your pack is full.');
      p.gold -= price;
      const item = this.makeItem(p, good.item, good.q);
      p.items.push(item);
      this.sys(p, `You buy a ${weaponLabel(item)} for ${price} gold.`);
      this.sendYou(p);
      return;
    }

    if (p.gold < good.price) {
      return this.sys(p, `${vendor.name} says: That is ${good.price} gold, which thou dost not have.`);
    }
    p.gold -= good.price;
    if (good.item === 'arrow') {
      p.arrows += ARROW_BUNDLE;
      this.sys(p, `You buy ${ARROW_BUNDLE} arrows for ${good.price} gold.`);
    } else if (good.item === 'herbs') {
      p.herbs += 4;
      this.sys(p, `You buy a bundle of herbs for ${good.price} gold.`);
    } else {
      p.pots[good.item] = (p.pots[good.item] || 0) + 1;
      this.sys(p, `You buy a ${good.name} for ${good.price} gold.`);
    }
    this.sendYou(p);
  }

  makeItem(p, id, q) {
    const maxDur = Math.round(WEAPONS[id].dur * QUALITIES[q].durMul);
    return { uid: p.itemUid++, id, q, dur: maxDur, maxDur };
  }

  equippedWeapon(p) {
    if (p.weapon == null) return null;
    const item = p.items.find((i) => i.uid === p.weapon);
    if (!item) p.weapon = null;
    return item || null;
  }

  slotOf(def) {
    if (def.slot === 'chest') return 'armor';
    return def.slot || 'weapon';
  }

  handleEquip(p, uid) {
    if (uid === null || uid === 0) {
      p.weapon = null;
      this.sys(p, 'You put your weapon away.');
      return this.sendYou(p);
    }
    const item = p.items.find((i) => i.uid === uid);
    if (!item) return;
    const def = WEAPONS[item.id];
    const slot = this.slotOf(def);
    if (def.minSkill && p.skills.swordsmanship < def.minSkill) {
      return this.sys(p, `You need ${def.minSkill} Swordsmanship to use a ${def.name}.`);
    }
    if (p[slot] === uid) {
      p[slot] = null;
      this.sys(p, `You remove your ${weaponLabel(item)}.`);
    } else {
      p[slot] = uid;
      this.sys(p, `You ready your ${weaponLabel(item)}.`);
    }
    this.sendYou(p);
  }

  equippedIn(p, slot) {
    if (p[slot] == null) return null;
    const item = p.items.find((i) => i.uid === p[slot]);
    if (!item) p[slot] = null;
    return item || null;
  }

  handleSell(p, uid) {
    if (p.dead) return this.sys(p, 'The dead cannot trade.');
    const vendor = this.vendors.find((v) => dist(p, v) <= 3);
    if (!vendor) return this.sys(p, 'You are too far from a shopkeeper.');
    const item = p.items.find((i) => i.uid === uid);
    if (!item) return;
    const price = Math.floor(weaponPrice(item.id, item.q) * 0.4);
    p.items = p.items.filter((i) => i.uid !== uid);
    for (const slot of ['weapon', 'armor', 'offhand']) if (p[slot] === uid) p[slot] = null;
    p.gold += price;
    this.sys(p, `You sell your ${weaponLabel(item)} for ${price} gold.`);
    this.sendYou(p);
  }

  handleCraft(p, id) {
    if (p.dead) return this.sys(p, 'The dead cannot work a forge.');
    const def = WEAPONS[id];
    if (!def || !def.craft || def.secret) return;
    const vendor = this.vendors.find((v) => v.forge && dist(p, v) <= 3);
    if (!vendor) return this.sys(p, 'You need a blacksmith\'s forge for that.');
    const c = def.craft;
    const matNeeds = ['frostwood', 'sunsteel', 'ironbark'].filter((m) => c[m]);
    const matsShort = matNeeds.filter((m) => p.mats[m] < c[m]);
    if (p.ore < c.ore || p.logs < c.logs || p.gold < c.gold || matsShort.length) {
      const extras = matNeeds.map((m) => `${c[m]} ${m}`).join(', ');
      return this.sys(p, `Forging a ${def.name} takes ${c.ore} ore, ${c.logs} logs, ${c.gold} gold${extras ? ' and ' + extras : ''}.`);
    }
    if (p.items.length >= ITEM_CAP) return this.sys(p, 'Your pack is full.');
    p.ore -= c.ore;
    p.logs -= c.logs;
    p.gold -= c.gold;
    for (const m of matNeeds) p.mats[m] -= c[m];
    this.deed(p, 'smith');
    this.gainSkill(p, 'blacksmithy');
    // The smith's own hand decides the quality.
    const k = p.skills.blacksmithy / 100;
    const r = Math.random();
    const q = r < 0.05 * k ? 4 : r < 0.2 * k ? 3 : r < 0.55 * k ? 2 : r < 0.55 * k + 0.5 ? 1 : 0;
    const item = this.makeItem(p, id, q);
    p.items.push(item);
    this.sys(p, `You forge a ${weaponLabel(item)}!`);
    this.sendYou(p);
  }

  handleDrink(p, kind) {
    const potion = POTIONS[kind];
    if (!potion) return;
    if (p.dead) return this.sys(p, 'The dead cannot drink.');
    const t = now();
    if (t < p.drinkAt) return this.sys(p, 'You must wait a moment between potions.');
    if (!p.pots[kind]) {
      return this.sys(p, `You have no ${potion.name.toLowerCase()}s. The town alchemists sell them.`);
    }
    p.pots[kind] -= 1;
    p.drinkAt = t + 4000;
    const amount = rand(potion.restore[0], potion.restore[1]);
    if (kind === 'heal') {
      p.hp = Math.min(maxHp(p), p.hp + amount);
      this.fxNear(p, { t: 'fx', kind: 'heal', x: p.x, y: p.y, amount });
      this.sys(p, `You drink the potion and recover ${amount} health.`);
    } else {
      p.mana = Math.min(p.int, p.mana + amount);
      this.sys(p, `You drink the potion and recover ${amount} mana.`);
    }
    this.sendYou(p);
  }

  handleMove(p, dx, dy) {
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return;
    const t = now();
    if (t < p.moveAt) return;
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (!p.dead && !isWalkable(this.map, nx, ny)) return;
    if (p.dead && (nx < 0 || ny < 0 || nx >= this.map.w || ny >= this.map.h)) return;
    p.x = nx;
    p.y = ny;
    const stride = dx !== 0 && dy !== 0 ? 165 : 118;
    p.moveAt = t + (t < (p.hasteUntil || 0) ? Math.round(stride * 0.7) : stride);

    if (tileAt(this.map, p.x, p.y) === TILE.SHRINE) {
      if (p.dead) this.resurrect(p);
      // touching any shrine binds your recall there — cities are bases
      if (!p.home || p.home.x !== p.x || p.home.y !== p.y) {
        p.home = { x: p.x, y: p.y };
        const c = this.cityAt(p.x, p.y);
        this.sys(p, c
          ? `The shrine of ${c.name} accepts you. /home will carry you back here.`
          : 'The shrine hums softly. /home will carry you back here.');
      }
    }
    // Ghosts may use the portals too — a shade must be able to climb out
    // of the deeps to reach a shrine — but the world only whispers to,
    // and buries treasure for, the living (handled in checkSecrets).
    this.checkSecrets(p, t);
  }

  cityAt(x, y) {
    return (this.map.cities || []).find((c) =>
      Math.abs(c.x - x) <= c.r && Math.abs(c.y - y) <= c.r) || null;
  }

  inCity(x, y) {
    return this.cityAt(x, y) !== null;
  }

  checkSecrets(p, t) {
    for (let i = 0; i < this.map.secrets.length; i++) {
      if (this.map.secrets[i].dead) continue; // live-removed by the builder
      const s = this.map.secrets[i];
      if (s.type === 'portal' && s.x === p.x && s.y === p.y) {
        if (t < p.portalAt) return;
        p.portalAt = t + 4000; // don't bounce straight back
        this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
        p.x = s.tx;
        p.y = s.ty;
        p.moveAt = t + 600;
        this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
        this.sys(p, s.door
          ? 'You step through the door.'
          : 'The standing stones flare with old magic, and the world lurches.');
        return;
      }
      if (s.type === 'whisper' && !p.dead && !p.whispered.has(i) &&
          Math.abs(s.x - p.x) <= 2 && Math.abs(s.y - p.y) <= 2) {
        p.whispered.add(i);
        this.sys(p, s.text);
      }
    }
  }

  // ---- the world builder's live hand ----------------------------------------
  //
  // The editor always sends its full cumulative overlay; we diff it against
  // what was last applied, so saving twice is a no-op and nothing ever
  // materialises twice. Everything lands on the running world immediately —
  // except building removal, whose ground truth is only known at reboot.
  applyEditsLive(rawEdits) {
    const clean = sanitizeEdits(this.map, rawEdits, { validKinds: new Set(Object.keys(MOB_KINDS)),
      validWeapons: new Set(Object.keys(WEAPONS)) });
    const prev = this.appliedEdits || {};
    const key = (o) => `${o.x},${o.y}`;
    const keyN = (o) => `${o.x},${o.y},${o.name}`;
    const keyS = (o) => `${o.type},${o.x},${o.y}`;
    const diff = (a, b, k) => {
      const bs = new Set((b || []).map(k));
      return (a || []).filter((o) => !bs.has(k(o)));
    };
    const pk = ([x, y]) => `${x},${y}`;
    const diffPairs = (a, b) => {
      const bs = new Set((b || []).map(pk));
      return (a || []).filter((p) => !bs.has(pk(p)));
    };
    const counts = { tiles: 0, props: 0, spawners: 0, secrets: 0, buildings: 0, vendors: 0, removed: 0, restored: 0 };
    const changedTiles = [];
    const touchTile = (x, y, v) => {
      this.map.tiles[y * this.map.w + x] = v;
      changedTiles.push([x, y, v]);
    };
    let propsDirty = false;

    // -- tiles: new paints, plus reverted paints go back to... nothing we can
    // know cheaply, so tile removal isn't offered; the editor paints over.
    for (const [x, y, v] of diff(clean.tiles, prev.tiles, (t) => `${t[0]},${t[1]},${t[2]}`)) {
      touchTile(x, y, v);
      counts.tiles++;
    }

    // -- buildings: stamp the new ones live (slot index = position in the
    // full list, same rule as boot, so reboots land in the same rooms)
    (clean.buildings || []).forEach((b, i) => {
      const had = (prev.buildings || []).some((o) => keyN(o) === keyN(b));
      if (had) return;
      placeBuilding(this.map, b.x, b.y, b.name, EDIT_INTERIOR_X0 + i * 16, (x, y, v) => {
        changedTiles.push([x, y, v]);
      });
      propsDirty = true;
      counts.buildings++;
    });

    // -- props: additions, retractions of overlay props, worldgen removals
    // and worldgen un-removals (restored from the pristine snapshot)
    for (const p of diff(clean.props, prev.props, keyN)) {
      this.map.props.push({ ...p });
      propsDirty = true;
      counts.props++;
    }
    for (const p of diff(prev.props, clean.props, keyN)) {
      const i = this.map.props.findIndex((o) => keyN(o) === keyN(p));
      if (i >= 0) { this.map.props.splice(i, 1); propsDirty = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(clean.removeProps, prev.removeProps)) {
      const i = this.map.props.findIndex((o) => o.x === x && o.y === y);
      if (i >= 0) { this.map.props.splice(i, 1); propsDirty = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(prev.removeProps, clean.removeProps)) {
      const orig = this.pristineProps.find((o) => o.x === x && o.y === y);
      if (orig && !this.map.props.some((o) => o.x === x && o.y === y)) {
        this.map.props.push({ ...orig });
        propsDirty = true;
        counts.restored++;
      }
    }

    // -- spawners: materialise additions now, despawn removals' flocks
    const materialize = (desc) => {
      const sp = { ...desc, alive: new Set() };
      this.map.spawners.push(sp);
      for (let i = 0; i < sp.count; i++) this.spawnMob(sp);
      counts.spawners++;
    };
    const dematerialize = (x, y) => {
      const i = this.map.spawners.findIndex((s) => s.x === x && s.y === y);
      if (i < 0) return false;
      for (const id of this.map.spawners[i].alive || []) this.mobs.delete(id);
      this.map.spawners.splice(i, 1);
      return true;
    };
    const spKey = (o) => `${o.x},${o.y},${o.kind},${o.count},${o.r},` +
      `${JSON.stringify(o.lines || null)},${JSON.stringify(o.loot || null)}`;
    for (const s of diff(clean.spawners, prev.spawners, spKey)) {
      dematerialize(s.x, s.y); // same spot with new settings = replace
      materialize(s);
    }
    for (const s of diff(prev.spawners, clean.spawners, spKey)) {
      if (!(clean.spawners || []).some((o) => o.x === s.x && o.y === s.y)) {
        if (dematerialize(s.x, s.y)) counts.removed++;
      }
    }
    for (const [x, y] of diffPairs(clean.removeSpawners, prev.removeSpawners)) {
      if (dematerialize(x, y)) counts.removed++;
    }
    for (const [x, y] of diffPairs(prev.removeSpawners, clean.removeSpawners)) {
      const orig = this.pristineSpawners.find((s) => s.x === x && s.y === y);
      if (orig && !this.map.spawners.some((s) => s.x === x && s.y === y)) {
        materialize({ ...orig });
        counts.restored++;
      }
    }

    // -- secrets: push additions; removals are TOMBSTONES, never splices —
    // treasure maps and stocked caches hold indexes into map.secrets.
    for (const sc of diff(clean.secrets, prev.secrets, keyS)) {
      this.map.secrets.push({ ...sc });
      if (sc.type === 'cache') this.stockCache(sc, this.map.secrets.length - 1);
      counts.secrets++;
    }
    for (const sc of diff(prev.secrets, clean.secrets, keyS)) {
      const s = this.map.secrets.find((o) => keyS(o) === keyS(sc) && !o.dead);
      if (s) { s.dead = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(clean.removeSecrets, prev.removeSecrets)) {
      const s = this.map.secrets.find((o) => o.x === x && o.y === y && !o.dead);
      if (s) { s.dead = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(prev.removeSecrets, clean.removeSecrets)) {
      const s = this.map.secrets.find((o) => o.x === x && o.y === y && o.dead);
      if (s) { delete s.dead; counts.restored++; }
    }

    // -- merchants: the shop list is small, so rebuild and rebroadcast it
    let vendorsDirty = false;
    const vKey = (o) => `${o.x},${o.y},${o.name},${JSON.stringify(o.goods || null)},` +
      `${o.model || ''},${o.forge ? 1 : 0},${o.greeting || ''}`;
    for (const v of diff(clean.vendors, prev.vendors, vKey)) {
      const i = this.map.vendors.findIndex((o) => o.x === v.x && o.y === v.y);
      if (i >= 0) this.map.vendors.splice(i, 1); // same spot, new terms
      this.map.vendors.push(JSON.parse(JSON.stringify(v)));
      vendorsDirty = true;
      counts.vendors = (counts.vendors || 0) + 1;
    }
    for (const v of diff(prev.vendors, clean.vendors, vKey)) {
      if ((clean.vendors || []).some((o) => o.x === v.x && o.y === v.y)) continue;
      const i = this.map.vendors.findIndex((o) => o.x === v.x && o.y === v.y);
      if (i >= 0) { this.map.vendors.splice(i, 1); vendorsDirty = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(clean.removeVendors, prev.removeVendors)) {
      const i = this.map.vendors.findIndex((o) => o.x === x && o.y === y);
      if (i >= 0) { this.map.vendors.splice(i, 1); vendorsDirty = true; counts.removed++; }
    }
    for (const [x, y] of diffPairs(prev.removeVendors, clean.removeVendors)) {
      const orig = this.pristineVendors.find((o) => o.x === x && o.y === y);
      if (orig && !this.map.vendors.some((o) => o.x === x && o.y === y)) {
        this.map.vendors.push(JSON.parse(JSON.stringify(orig)));
        vendorsDirty = true;
        counts.restored++;
      }
    }
    if (vendorsDirty) {
      this.vendors = this.map.vendors.map((v, i) => ({ ...v, id: -(i + 1), kind: 'vendor' }));
      this.broadcast({ t: 'vendors', vendors: this.vendors });
    }

    // -- tell the world: cheap tile pings for small paints, whole chunks for
    // floods, one props refresh, one minimap refresh
    if (changedTiles.length <= 800) {
      for (const [x, y, v] of changedTiles) {
        this.broadcast({ t: 'tile', x, y, tile: v });
      }
    } else {
      const chunks = new Set(changedTiles.map(([x, y]) => `${x >> 6},${y >> 6}`));
      for (const c of chunks) {
        const [cx, cy] = c.split(',').map(Number);
        this.broadcast({ t: 'chunk', cx, cy, d: this.chunkData(cx, cy) });
      }
    }
    if (propsDirty) this.broadcast({ t: 'props', props: this.map.props });
    if (changedTiles.length) {
      this.miniData = this.buildMini();
      this.broadcast({ t: 'mini', mini: this.miniData });
    }

    // -- persist the sanitized overlay atomically; it IS the new baseline
    clean.savedAt = Date.now();
    this.appliedEdits = JSON.parse(JSON.stringify(clean));
    fs.mkdirSync(path.dirname(this.editsPath), { recursive: true });
    const tmp = this.editsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 1));
    fs.renameSync(tmp, this.editsPath);
    return counts;
  }

  handleSay(p, text) {
    text = String(text || '').slice(0, 120).trim();
    if (!text) return;
    if (text.startsWith('/')) return this.handleCommand(p, text);
    this.broadcast({ t: 'chat', id: p.id, name: p.name, text });
  }

  handleCommand(p, text) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
    if (cmd === 'forget') {
      const sk = (text.split(/\s+/)[1] || '').toLowerCase();
      if (!SKILLS.includes(sk)) {
        return this.sys(p, `Forget which art? ${SKILLS.join(', ')}.`);
      }
      if (p.gold < 100) return this.sys(p, 'The mind is willing, but the ritual costs 100 gold.');
      p.gold -= 100;
      p.skills[sk] = 20;
      this.sys(p, `You let your ${skillName(sk)} fade back to instinct. (now 20.0)`);
      return this.sendYou(p);
    }
    if (cmd === 'release') {
      const pet = this.petOf(p);
      if (!pet) return this.sys(p, 'You have no companion to release.');
      pet.owner = null;
      pet.name = undefined;
      pet.homeX = pet.x;
      pet.homeY = pet.y;
      this.sys(p, `You release ${MOB_KINDS[pet.kind].name} back to the wild.`);
      return;
    }
    if (cmd === 'teleport' || cmd === 'home' || cmd === 'recall') {
      if (p.dead) return this.sys(p, 'The dead must walk to a shrine.');
      const t = now();
      if (t < (p.teleportAt || 0)) {
        return this.sys(p, `The winds are spent. Try again in ${Math.ceil((p.teleportAt - t) / 1000)} seconds.`);
      }
      p.teleportAt = t + 60_000;
      this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
      const home = p.home || this.map.spawn;
      p.x = home.x;
      p.y = home.y;
      p.moveAt = t + 600;
      p.target = 0;
      this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
      const c = this.cityAt(p.x, p.y);
      this.sys(p, `The winds carry you home${c ? ' to ' + c.name : ''}.`);
      return;
    }
    this.sys(p, `Unknown command: /${cmd}. Commands: /teleport`);
  }

  handleAttack(p, mobId) {
    if (p.dead) return this.sys(p, 'You are a ghost. Seek the shrine.');
    const mob = this.mobs.get(mobId);
    if (!mob) return;
    const def = MOB_KINDS[mob.kind];
    // Townsfolk are protected. Guards are not — they can protect themselves,
    // and every guard in earshot will make that point together.
    if (def.peaceful && !def.guard) {
      return this.sys(p, 'The townsfolk are under the crown\'s protection.');
    }
    if (mob.owner) {
      return this.sys(p, 'That creature answers to another. Leave it be.');
    }
    p.target = mobId;
    this.sys(p, `You attack ${mob.name || def.name}.`);
  }

  handleCast(p, spellId, targetId) {
    if (p.dead) return this.sys(p, 'The dead cannot weave magic.');
    const spell = SPELLS[spellId];
    if (!spell) return;
    const t = now();
    if (t < p.castAt) return;
    if (p.skills.magery < spell.minSkill) {
      return this.sys(p, `You need ${spell.minSkill} Magery to cast ${spell.name}.`);
    }
    if (p.mana < spell.mana) return this.sys(p, 'Insufficient mana.');

    p.castAt = t + 1500;
    p.mana -= spell.mana;
    this.broadcast({ t: 'chat', id: p.id, name: p.name, text: spell.words, magic: true });

    // Fizzle chance shrinks as Magery rises.
    if (Math.random() * 100 > p.skills.magery + 35) {
      this.sys(p, 'The spell fizzles.');
      this.gainSkill(p, 'magery');
      this.sendYou(p);
      return;
    }

    if (spell.heal) {
      const amount = rand(spell.heal[0], spell.heal[1]);
      p.hp = Math.min(maxHp(p), p.hp + amount);
      this.fxNear(p, { t: 'fx', kind: 'heal', x: p.x, y: p.y, amount });
    } else if (spell.buff) {
      p.buffUntil = t + spell.buffMs;
      this.fxNear(p, { t: 'fx', kind: 'heal', x: p.x, y: p.y, amount: 0 });
      this.sys(p, 'Your arm feels surer. (+damage for a minute)');
    } else if (spell.hasteMs) {
      p.hasteUntil = t + spell.hasteMs;
      this.fxNear(p, { t: 'fx', kind: 'haste', x: p.x, y: p.y });
      this.sys(p, 'The world slows around you. (+speed for ten seconds)');
    } else if (spell.dot) {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else if (mob.owner || (MOB_KINDS[mob.kind].peaceful && !MOB_KINDS[mob.kind].guard)) {
        this.sys(p, mob.owner ? 'That creature answers to another. Leave it be.'
          : 'The townsfolk are under the crown\'s protection.');
      } else {
        mob.poison = { left: 5, dmg: rand(spell.dot[0], spell.dot[1]), nextAt: t + 2000, by: p.id };
        this.fxNear(mob, { t: 'fx', kind: 'poison', x: mob.x, y: mob.y });
        this.sys(p, `${mob.name || MOB_KINDS[mob.kind].name} turns a sickly green.`);
        if (MOB_KINDS[mob.kind].guard) this.raiseTheWatch(p, mob);
      }
    } else {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else if (mob.owner || (MOB_KINDS[mob.kind].peaceful && !MOB_KINDS[mob.kind].guard)) {
        this.sys(p, mob.owner ? 'That creature answers to another. Leave it be.'
          : 'The townsfolk are under the crown\'s protection.');
      } else {
        const dmg = rand(spell.dmg[0], spell.dmg[1]) + Math.floor(p.skills.magery / (spellId === 'energybolt' ? 8 : 12));
        this.fxNear(p, { t: 'fx', kind: spellId, x: p.x, y: p.y, tx: mob.x, ty: mob.y, amount: dmg });
        if (spell.slowMs) mob.slowUntil = t + spell.slowMs; // frost grips the legs
        this.damageMob(p, mob, dmg);
        if (spell.chain) {
          // the bolt arcs onward to the nearest packmates
          let struck = 0;
          for (const m2 of this.mobs.values()) {
            if (struck >= spell.chain) break;
            if (m2 === mob || m2.owner || MOB_KINDS[m2.kind].peaceful || dist(mob, m2) > 5) continue;
            const d2 = Math.round(dmg * 0.7);
            this.fxNear(m2, { t: 'fx', kind: 'chainarc', x: mob.x, y: mob.y, tx: m2.x, ty: m2.y, amount: d2 });
            this.damageMob(p, m2, d2);
            struck++;
          }
        }
        this.gainStat(p, 'int');
      }
    }
    this.gainSkill(p, 'magery');
    this.sendYou(p);
  }

  handleBandage(p) {
    if (p.dead) return;
    const t = now();
    if (t < p.bandageAt) return this.sys(p, 'You are still applying bandages.');
    p.bandageAt = t + 8000;
    if (p.hp >= maxHp(p)) return this.sys(p, 'You are at full health.');
    const amount = rand(3, 8) + Math.floor(p.skills.healing / 5);
    p.hp = Math.min(maxHp(p), p.hp + amount);
    this.fxNear(p, { t: 'fx', kind: 'heal', x: p.x, y: p.y, amount });
    this.sys(p, `You bandage your wounds for ${amount}.`);
    this.gainSkill(p, 'healing');
    this.gainStat(p, 'dex');
    this.sendYou(p);
  }

  handleGather(p) {
    if (p.dead) return;
    const t = now();
    if (t < p.swingAt) return;
    p.swingAt = t + 1200;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const tx = p.x + dx;
      const ty = p.y + dy;
      const tile = tileAt(this.map, tx, ty);
      if (tile === TILE.TREE || tile === TILE.SNOWTREE || tile === TILE.SWAMPTREE) {
        if (Math.random() * 100 < p.skills.lumberjacking + 40) {
          p.logs += 1;
          this.sys(p, 'You chop some logs.');
          if (tile === TILE.SNOWTREE && Math.random() < 0.15) {
            p.mats.frostwood += 1;
            this.sys(p, 'Beneath the bark: pale frostwood!');
          } else if (tile === TILE.SWAMPTREE && Math.random() < 0.15) {
            p.mats.ironbark += 1;
            this.sys(p, 'This bough is heavy ironbark!');
          }
          this.consumeResource(p, tx, ty, tile, 'The tree falls.');
        } else {
          this.sys(p, 'You hack at the tree but produce nothing useful.');
        }
        this.gainSkill(p, 'lumberjacking');
        this.gainStat(p, 'str');
        this.sendYou(p);
        return;
      }
      if (tile === TILE.ROCK) {
        if (Math.random() * 100 < p.skills.mining + 40) {
          p.ore += 1;
          this.sys(p, 'You dig some ore and put it in your pack.');
          if (tileAt(this.map, p.x, p.y) === TILE.SAND && Math.random() < 0.15) {
            p.mats.sunsteel += 1;
            this.sys(p, 'A vein of desert sunsteel glitters in the rubble!');
          }
          this.consumeResource(p, tx, ty, tile, 'The rock face crumbles to rubble.');
        } else {
          this.sys(p, 'You loosen some rocks but fail to find anything.');
        }
        this.gainSkill(p, 'mining');
        this.gainStat(p, 'str');
        this.sendYou(p);
        return;
      }
    }
    // No tree, no rock — but water means fish.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (tileAt(this.map, p.x + dx, p.y + dy) === TILE.WATER) {
        if (Math.random() * 100 < p.skills.fishing + 30) {
          p.fish += 1;
          this.sys(p, 'You pull a wriggling fish from the water.');
          this.deed(p, 'angler');
        } else {
          this.sys(p, 'The fish are not biting.');
        }
        this.gainSkill(p, 'fishing');
        this.sendYou(p);
        return;
      }
    }
    // Mire ground grows what the alchemists want.
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (tileAt(this.map, p.x + dx, p.y + dy) === TILE.SWAMP) {
        if (Math.random() * 100 < p.skills.alchemy + 50) {
          p.herbs += rand(1, 2);
          this.sys(p, 'You gather a handful of marsh herbs.');
        } else {
          this.sys(p, 'Nothing here but reeds and stinging flies.');
        }
        this.gainSkill(p, 'alchemy');
        this.sendYou(p);
        return;
      }
    }
    this.sys(p, 'There is nothing here to gather. Stand beside a tree, rock face, water or marsh.');
  }

  // Each tree or rock yields a few harvests, then vanishes and regrows later.
  consumeResource(p, x, y, tile, message) {
    const key = x + ',' + y;
    const left = (this.resources.get(key) ?? rand(2, 4)) - 1;
    if (left > 0) {
      this.resources.set(key, left);
      return;
    }
    this.resources.delete(key);
    this.setTile(x, y,
      tile === TILE.SNOWTREE ? TILE.SNOW : tile === TILE.SWAMPTREE ? TILE.SWAMP : TILE.GRASS);
    this.depleted.set(key, { tile, respawnAt: now() + RESOURCE_RESPAWN_MS });
    this.sys(p, message);
  }

  setTile(x, y, tile) {
    this.map.tiles[y * this.map.w + x] = tile;
    this.broadcast({ t: 'tile', x, y, tile });
  }

  respawnResources(t) {
    for (const [key, d] of this.depleted) {
      if (t < d.respawnAt) continue;
      const [x, y] = key.split(',').map(Number);
      // Never regrow a tree on top of someone standing there.
      let blocked = false;
      for (const p of this.players.values()) {
        if (p.x === x && p.y === y) { blocked = true; break; }
      }
      if (!blocked) {
        for (const m of this.mobs.values()) {
          if (m.x === x && m.y === y) { blocked = true; break; }
        }
      }
      if (blocked) {
        d.respawnAt = t + 5000;
        continue;
      }
      this.depleted.delete(key);
      this.setTile(x, y, d.tile);
    }
  }

  // ---- combat ---------------------------------------------------------------

  // Striking the watch is a crime: every guard in earshot drops what it is
  // doing and answers. They give up (and go home, and forgive) only if the
  // criminal flees far past the walls — the usual leash applies.
  raiseTheWatch(attacker, struck) {
    let raised = 0;
    for (const m of this.mobs.values()) {
      if (!MOB_KINDS[m.kind].guard) continue;
      if (Math.abs(m.x - struck.x) > 30 || Math.abs(m.y - struck.y) > 30) continue;
      m.target = attacker.id;
      m.evading = false;
      raised++;
    }
    if (raised > 1 && now() >= (attacker.crimeNagAt || 0)) {
      attacker.crimeNagAt = now() + 8000;
      this.sys(attacker, 'The watch cries out: "Criminal! To arms!"');
    }
  }

  damageMob(attacker, mob, dmg) {
    mob.hp -= dmg;
    const def = MOB_KINDS[mob.kind];
    if (def.guard) this.raiseTheWatch(attacker, mob);
    if (def.aggro === 0 && !def.peaceful) {
      // Prey bolts rather than bites.
      mob.fleeUntil = now() + 6000;
      mob.fleeFrom = { x: attacker.x, y: attacker.y };
    } else {
      mob.target = attacker.id; // fighting back
      mob.evading = false;      // a fresh wound re-opens the argument
      // The camp answers: nearby campmates without a fight of their own
      // turn on the attacker. Picking fights near a warband is a choice.
      for (const id of mob.spawner.alive) {
        if (id === mob.id) continue;
        const ally = this.mobs.get(id);
        if (!ally || ally.target) continue;
        const adef = MOB_KINDS[ally.kind];
        if (adef.peaceful || adef.guard || (adef.aggro === 0 && !ally.aggroBoost)) continue;
        if (dist(ally, mob) <= 8) ally.target = attacker.id;
      }
    }
    this.fxNear(mob, { t: 'fx', kind: 'hit', x: mob.x, y: mob.y, amount: dmg });
    if (mob.hp <= 0) this.killMob(attacker, mob);
  }

  killMob(killer, mob) {
    const def = MOB_KINDS[mob.kind];
    const gold = rand(Math.ceil(def.gold * 0.6), def.gold);
    killer.gold += gold;
    this.mobs.delete(mob.id);
    mob.spawner.alive.delete(mob.id);
    mob.spawner.respawnAt = now() + (mob.spawner.respawnMs || 20_000);
    this.sys(killer, `You have slain ${mob.name || def.name}! You loot ${gold} gold.`);
    this.deed(killer, 'firstblood');
    if (mob.kind === 'dragon' || mob.kind === 'vyrmaur') this.deed(killer, 'dragonslayer');
    if (def.boss && mob.kind !== 'dragon') this.deed(killer, 'kingslayer');
    if (mob.spawner.respawnMs) {
      this.broadcastSys(`${killer.name} has slain ${mob.name || def.name}!`);
    }
    this.fxNear(mob, { t: 'fx', kind: 'die', x: mob.x, y: mob.y });
    this.rollLoot(mob);
    this.sendYou(killer);
  }

  // The corpse sometimes leaves something on the ground; first to step on
  // the tile claims it.
  // True singletons: nothing drops again while a copy exists anywhere —
  // in a pack, in a saved record, or lying on the ground.
  legendOwned(id) {
    for (const rec of Object.values(this.records)) {
      if ((rec.items || []).some((i) => i.id === id)) return true;
    }
    for (const q of this.players.values()) {
      if (q.items.some((i) => i.id === id)) return true;
    }
    for (const d of this.drops.values()) {
      if (d.item === 'weapon' && d.w && d.w.id === id) return true;
    }
    return false;
  }

  rollLoot(mob) {
    if (mob.kind === 'vyrmaur' && !this.legendOwned('dawnbreaker')) {
      const def = WEAPONS.dawnbreaker;
      this.drops.set(this.nextId, {
        id: this.nextId++,
        x: mob.x, y: mob.y,
        item: 'weapon', w: { id: 'dawnbreaker', q: 5, dur: def.dur, maxDur: def.dur },
        despawnAt: now() + 10 * 60_000, // it waits longer than common spoils
      });
    }
    const lootTable = (mob.spawner && mob.spawner.loot) || LOOT_TABLES[mob.kind] || [];
    for (const entry of lootTable) {
      if (Math.random() > entry[0]) continue;
      if (entry[1] === 'tmap') {
        const cacheIdxs = this.map.secrets
          .map((sc, i) => (sc.type === 'cache' && !sc.dead ? i : -1)).filter((i) => i >= 0);
        if (!cacheIdxs.length) continue;
        const m = cacheIdxs[rand(0, cacheIdxs.length - 1)];
        this.drops.set(this.nextId, {
          id: this.nextId++, x: mob.x, y: mob.y,
          item: 'tmap', m, despawnAt: now() + DROP_TTL_MS,
        });
        continue;
      }
      if (entry[1] === 'weapon') {
        const [, , pool, qMin, qMax] = entry;
        const id = pool[rand(0, pool.length - 1)];
        const q = rand(qMin, qMax);
        const maxDur = Math.round(WEAPONS[id].dur * QUALITIES[q].durMul);
        this.drops.set(this.nextId, {
          id: this.nextId++,
          x: mob.x, y: mob.y,
          item: 'weapon', w: { id, q, dur: maxDur, maxDur },
          despawnAt: now() + DROP_TTL_MS,
        });
        continue;
      }
      const [, item, min, max] = entry;
      this.drops.set(this.nextId, {
        id: this.nextId++,
        x: mob.x, y: mob.y,
        item, amount: rand(min, max),
        despawnAt: now() + DROP_TTL_MS,
      });
    }
  }

  pickupDrops(p) {
    for (const [id, d] of this.drops) {
      if (d.x !== p.x || d.y !== p.y) continue;
      if (d.item === 'weapon') {
        if (p.items.length >= ITEM_CAP) {
          if (t0Throttle(p)) this.sys(p, 'Your pack is full.');
          continue; // it stays on the ground
        }
        this.drops.delete(id);
        if (d.cacheIdx !== undefined) {
          this.cacheRespawns.set(d.cacheIdx, now() + CACHE_RESPAWN_MS);
        }
        const item = { uid: p.itemUid++, ...d.w };
        p.items.push(item);
        this.sys(p, `You pick up a ${weaponLabel(item)}.`);
        if (item.id === 'dawnbreaker') this.deed(p, 'legend');
        this.sendYou(p);
        continue;
      }
      if (d.item === 'tmap' && (p.tmaps || []).length >= 3) {
        if (t0Throttle(p)) this.sys(p, 'You cannot carry more maps.');
        continue; // it stays on the ground — deleting and re-adding the key
                  // mid-iteration would make the iterator visit it forever
      }
      this.drops.delete(id);
      if (d.cacheIdx !== undefined) {
        this.cacheRespawns.set(d.cacheIdx, now() + CACHE_RESPAWN_MS);
      }
      switch (d.item) {
        case 'gold':
          p.gold += d.amount;
          this.sys(p, `You pick up ${d.amount} gold.`);
          break;
        case 'heal':
        case 'mana':
          p.pots[d.item] += d.amount;
          this.sys(p, `You pick up ${d.amount > 1 ? d.amount + ' ' : 'a '}${d.item === 'heal' ? 'heal' : 'mana'} potion${d.amount > 1 ? 's' : ''}.`);
          break;
        case 'logs':
          p.logs += d.amount;
          this.sys(p, `You pick up ${d.amount} logs.`);
          break;
        case 'ore':
          p.ore += d.amount;
          this.sys(p, `You pick up ${d.amount} ore.`);
          break;
        case 'gems':
          p.gems += d.amount;
          this.sys(p, `You pick up ${d.amount > 1 ? d.amount + ' sparkling gems' : 'a sparkling gem'}!`);
          break;
        case 'meat':
          p.meat += d.amount;
          this.sys(p, `You take ${d.amount > 1 ? d.amount + ' cuts' : 'a cut'} of meat.`);
          break;
        case 'herbs':
          p.herbs += d.amount;
          this.sys(p, `You gather ${d.amount > 1 ? d.amount + ' sprigs' : 'a sprig'} of herbs.`);
          break;
        case 'tmap': {
          p.tmaps = p.tmaps || [];
          p.tmaps.push(d.m);
          this.sys(p, 'A weathered map! Someone marked an X far from here.');
          break;
        }
      }
      this.sendYou(p);
    }
  }

  // A blow lands on a player: shields may turn it, armor blunts it,
  // and worn gear wears further.
  hitPlayer(p, raw, byName) {
    const shield = this.equippedIn(p, 'offhand');
    if (shield && Math.random() * 100 < WEAPONS[shield.id].block) {
      this.fxNear(p, { t: 'fx', kind: 'miss', x: p.x, y: p.y });
      this.sys(p, 'You catch the blow on your shield.');
      this.wearGear(p, shield);
      return;
    }
    const armor = this.equippedIn(p, 'armor');
    let dmg = raw;
    if (armor) {
      dmg = Math.max(1, raw - WEAPONS[armor.id].dr);
      this.wearGear(p, armor);
    }
    p.hp -= dmg;
    this.fxNear(p, { t: 'fx', kind: 'hit', x: p.x, y: p.y, amount: dmg });
    if (p.hp <= 0) this.killPlayer(p, byName);
    else this.sendYou(p);
  }

  wearGear(p, item) {
    if (Math.random() >= 0.15) return;
    item.dur -= 1;
    if (item.dur <= 0) {
      p.items = p.items.filter((i) => i.uid !== item.uid);
      for (const slot of ['weapon', 'armor', 'offhand']) if (p[slot] === item.uid) p[slot] = null;
      this.sys(p, `Your ${weaponLabel(item)} falls apart!`);
      this.fxNear(p, { t: 'fx', kind: 'break', x: p.x, y: p.y });
    }
    this.sendYou(p);
  }

  killPlayer(p, byName) {
    p.dead = true;
    p.hp = 0;
    p.target = 0;
    this.sys(p, `You have been slain by ${byName}. Walk your ghost to a shrine.`);
    this.broadcastSys(`${p.name} has been slain by ${byName}.`, p.id);
    this.fxNear(p, { t: 'fx', kind: 'die', x: p.x, y: p.y });
    this.sendYou(p);
  }

  resurrect(p) {
    p.dead = false;
    p.hp = Math.ceil(maxHp(p) * 0.3);
    this.fxNear(p, { t: 'fx', kind: 'heal', x: p.x, y: p.y, amount: p.hp });
    this.sys(p, 'The ankh glows and breathes life back into you.');
    this.sendYou(p);
  }

  // Player swings at their current target each tick when in range.
  meleeTick(p, t) {
    if (p.dead || !p.target) return;
    const mob = this.mobs.get(p.target);
    if (!mob) {
      p.target = 0;
      return;
    }
    const item = this.equippedWeapon(p);
    const wdef = item ? WEAPONS[item.id] : UNARMED;
    const reach = wdef.ranged ? wdef.range : 1.5;
    if (dist(p, mob) > reach || t < p.swingAt) return;
    if (wdef.ranged) {
      if (p.arrows <= 0) {
        if (t0Throttle(p)) this.sys(p, 'You are out of arrows. The fletchers sell bundles.');
        return;
      }
      p.arrows -= 1;
      this.fxNear(p, { t: 'fx', kind: 'arrow', x: p.x, y: p.y, tx: mob.x, ty: mob.y });
    }
    p.swingAt = t + Math.max(900, wdef.speedMs - p.dex * 10);
    p.swungAt = t;

    const hitChance = clamp(50 + (p.skills.swordsmanship - MOB_KINDS[mob.kind].skill) / 2, 10, 95);
    this.gainSkill(p, 'swordsmanship');
    if (Math.random() * 100 > hitChance) {
      this.fxNear(mob, { t: 'fx', kind: 'miss', x: mob.x, y: mob.y });
      return;
    }
    this.gainSkill(p, 'tactics');
    this.gainStat(p, 'str');
    const roll = rand(wdef.dmg[0], wdef.dmg[1]);
    const blessBonus = p.buffUntil > t ? 3 : 0;
    const base = (item ? Math.round(roll * QUALITIES[item.q].dmgMul) : roll) + Math.floor(p.str / 10) + blessBonus;
    const dmg = Math.max(1, Math.floor(base * (0.5 + p.skills.tactics / 150)));
    this.damageMob(p, mob, dmg);
    if (item) this.wearWeapon(p, item);
  }

  // Steel is mortal too: each landed blow has a chance to wear the blade.
  wearWeapon(p, item) {
    if (Math.random() >= 0.25) return;
    item.dur -= 1;
    if (item.dur <= 0) {
      p.items = p.items.filter((i) => i.uid !== item.uid);
      for (const slot of ['weapon', 'armor', 'offhand']) if (p[slot] === item.uid) p[slot] = null;
      this.sys(p, `Your ${weaponLabel(item)} shatters!`);
      this.fxNear(p, { t: 'fx', kind: 'break', x: p.x, y: p.y });
    } else if (item.dur === Math.ceil(item.maxDur * 0.25)) {
      this.sys(p, `Your ${weaponLabel(item)} is badly worn.`);
    } else if (item.dur === Math.ceil(item.maxDur * 0.1)) {
      this.sys(p, `Your ${weaponLabel(item)} is about to break!`);
    }
    this.sendYou(p);
  }

  // ---- skills & stats ---------------------------------------------------------

  gainSkill(p, skill) {
    const cur = p.skills[skill];
    if (cur >= SKILL_CAP) return;
    // Classic use-based gains: the better you are, the rarer the gain.
    if (Math.random() < (SKILL_CAP - cur) / 220 + 0.02) {
      p.skills[skill] = Math.min(SKILL_CAP, Math.round((cur + 0.5) * 10) / 10);
      this.sys(p, `Your ${skillName(skill)} has risen to ${p.skills[skill].toFixed(1)}.`);
      if (p.skills[skill] >= SKILL_CAP) this.deed(p, 'grandmaster');
      this.sendYou(p);
    }
  }

  gainStat(p, stat) {
    if (p[stat] >= STAT_CAP) return;
    if (Math.random() < 0.012) {
      p[stat] += 1;
      this.sys(p, `Your ${stat === 'str' ? 'strength' : stat === 'dex' ? 'dexterity' : 'intelligence'} has increased!`);
      this.sendYou(p);
    }
  }

  // ---- mobs -------------------------------------------------------------------

  spawnMob(spawner) {
    const def = MOB_KINDS[spawner.kind];
    for (let tries = 0; tries < 40; tries++) {
      const x = spawner.x + rand(-spawner.r, spawner.r);
      const y = spawner.y + rand(-spawner.r, spawner.r);
      if (!isWalkable(this.map, x, y)) continue;
      const mob = {
        id: this.nextId++,
        kind: spawner.kind,
        x, y,
        homeX: x, homeY: y,
        hp: def.hp, maxhp: def.hp,
        target: 0,
        moveAt: 0, swingAt: 0, chatAt: 0,
        spawner,
      };
      if (spawner.kind === 'villager') {
        mob.name = VILLAGER_NAMES[mob.id % VILLAGER_NAMES.length];
      }
      // Every barrow raises the occasional necromancer.
      if (spawner.kind === 'skeleton' && Math.random() < 0.18) {
        mob.kind = 'skelmage';
        mob.hp = mob.maxhp = MOB_KINDS.skelmage.hp;
      }
      this.mobs.set(mob.id, mob);
      spawner.alive.add(mob.id);
      return;
    }
  }

  mobTick(mob, t) {
    const def = MOB_KINDS[mob.kind];

    // Poison eats at the afflicted.
    if (mob.poison && t >= mob.poison.nextAt) {
      mob.poison.nextAt = t + 2000;
      mob.poison.left -= 1;
      const killer = this.players.get(mob.poison.by);
      mob.hp -= mob.poison.dmg;
      this.fxNear(mob, { t: 'fx', kind: 'hit', x: mob.x, y: mob.y, amount: mob.poison.dmg });
      if (mob.poison.left <= 0) mob.poison = null;
      if (mob.hp <= 0) {
        if (killer) this.killMob(killer, mob);
        else {
          this.mobs.delete(mob.id);
          mob.spawner.alive.delete(mob.id);
        }
        return;
      }
    }

    // A tamed beast follows its own drum: its master's.
    if (mob.owner) return this.petTick(mob, t, def);

    // The frightened run first and think later.
    if (mob.fleeUntil && t < mob.fleeUntil) {
      if (t >= mob.moveAt) {
        mob.moveAt = t + (t < (mob.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
        this.stepToward(mob, 2 * mob.x - mob.fleeFrom.x, 2 * mob.y - mob.fleeFrom.y);
      }
      return;
    }

    // Guards hunt whatever hostile thing has strayed nearest their post,
    // and otherwise behave like (heavily armed) townsfolk.
    if (def.guard) {
      let foe = mob.foe ? this.mobs.get(mob.foe) : null;
      if (foe && (foe.hp <= 0 || dist(mob, foe) > 14)) foe = null;
      if (!foe && t >= (mob.scanAt || 0)) {
        mob.scanAt = t + 1500;
        let best = 12;
        for (const m of this.mobs.values()) {
          const mdef = MOB_KINDS[m.kind];
          if (mdef.peaceful || m.owner || (mdef.aggro === 0 && !m.aggroBoost)) continue;
          // never abandon the walls: only foes near the guard's post matter
          if (Math.abs(m.x - mob.homeX) > 14 || Math.abs(m.y - mob.homeY) > 14) continue;
          const d = dist(mob, m);
          if (d < best) { best = d; foe = m; }
        }
        mob.foe = foe ? foe.id : 0;
      }
      if (foe) {
        if (dist(mob, foe) <= 1.5) {
          if (t >= mob.swingAt) {
            mob.swingAt = t + 1200;
            mob.swungAt = t;
            const dmg = rand(def.dmg[0], def.dmg[1]);
            foe.hp -= dmg;
            this.fxNear(foe, { t: 'fx', kind: 'hit', x: foe.x, y: foe.y, amount: dmg });
            if (foe.hp <= 0) {
              this.fxNear(foe, { t: 'fx', kind: 'die', x: foe.x, y: foe.y });
              this.rollLoot(foe); // the spoils are left for travellers
              this.mobs.delete(foe.id);
              foe.spawner.alive.delete(foe.id);
              mob.foe = 0;
            }
          }
        } else if (t >= mob.moveAt) {
          mob.moveAt = t + (t < (mob.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
          this.stepToward(mob, foe.x, foe.y);
        }
        return;
      }
    }

    // Leash-evade: a mob kited too far from its home shrugs off its wounds
    // and strides back, deaf to taunts until it arrives. No more dragging
    // a dragon across the world one arrow at a time. (Raiders are exempt —
    // marching on a village is the whole point.)
    const leashed = !mob.aggroBoost &&
      (Math.abs(mob.x - mob.homeX) > 18 || Math.abs(mob.y - mob.homeY) > 18);
    if (mob.target && leashed) {
      mob.target = 0;
      mob.hp = mob.maxhp;
      mob.poison = null;
      mob.evading = true;
      this.fxNear(mob, { t: 'fx', kind: 'evade', x: mob.x, y: mob.y });
    }
    if (mob.evading) {
      if (Math.abs(mob.x - mob.homeX) <= 4 && Math.abs(mob.y - mob.homeY) <= 4) {
        mob.evading = false;
      } else {
        if (t >= mob.moveAt) {
          mob.moveAt = t + (t < (mob.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
          this.stepToward(mob, mob.homeX, mob.homeY);
        }
        return;
      }
    }

    // Acquire or validate a target. The walls of a city are sanctuary:
    // nothing hunts a traveller standing inside them — except the watch,
    // for whom the walls are precisely the jurisdiction.
    let target = mob.target ? this.players.get(mob.target) : null;
    if (target && (target.dead || dist(mob, target) > 14 ||
        (this.inCity(target.x, target.y) && !def.guard))) {
      mob.target = 0;
      target = null;
    }
    if (!target && (def.aggro > 0 || mob.aggroBoost)) {
      const reach = (def.aggro || 0) + (mob.aggroBoost || 0);
      const cx = mob.x >> 5;
      const cy = mob.y >> 5;
      outer:
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const cell = this.playerGrid && this.playerGrid.get((gx << 16) | gy);
          if (!cell) continue;
          for (const p of cell) {
            if (dist(mob, p) <= reach && !this.inCity(p.x, p.y)) {
              mob.target = p.id;
              target = p;
              break outer;
            }
          }
        }
      }
    }

    if (target) {
      const d = dist(mob, target);

      // Bosses telegraph a ground slam: stand clear or suffer.
      if (def.boss && d <= 8 && t >= (mob.aoeAt || 0)) {
        mob.aoeAt = t + 9000;
        const ax = target.x;
        const ay = target.y;
        this.fxNear(mob, { t: 'fx', kind: 'telegraph', x: ax, y: ay });
        this.pendingAoes.push({ x: ax, y: ay, at: t + 1600, dmg: Math.round(def.dmg[1] * 1.4), by: mob.name || def.name });
      }

      // Casters bombard from range.
      if (def.caster && d <= def.caster.range && d > 1.5 && t >= (mob.castAt || 0)) {
        mob.castAt = t + def.caster.cdMs;
        this.fxNear(mob, { t: 'fx', kind: def.caster.fx || 'mbolt', x: mob.x, y: mob.y, tx: target.x, ty: target.y });
        this.hitPlayer(target, rand(def.caster.dmg[0], def.caster.dmg[1]), mob.name || def.name);
        return;
      }

      if (d <= 1.5) {
        if (t >= mob.swingAt) {
          mob.swingAt = t + 1600;
          mob.swungAt = t;
          const hitChance = clamp(50 + (def.skill - target.skills.swordsmanship) / 2, 10, 95);
          if (Math.random() * 100 <= hitChance) {
            const dmg = rand(def.dmg[0], def.dmg[1]);
            this.hitPlayer(target, dmg, mob.name || def.name);
            if (def.vampiric && mob.hp < mob.maxhp) {
              // every wound he deals closes one of his own
              mob.hp = Math.min(mob.maxhp, mob.hp + Math.ceil(dmg / 2));
            }
          } else {
            this.fxNear(target, { t: 'fx', kind: 'miss', x: target.x, y: target.y });
          }
        }
      } else if (t >= mob.moveAt) {
        mob.moveAt = t + (t < (mob.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
        this.stepToward(mob, target.x, target.y);
      }
      return;
    }

    // Townsfolk gossip at passers-by — and any camp the keeper gave lines.
    const campLines = mob.spawner && mob.spawner.lines;
    if ((def.peaceful || campLines) && t >= mob.chatAt && Math.random() < 0.004) {
      for (const p of this.players.values()) {
        if (dist(mob, p) <= 7) {
          mob.chatAt = t + 25_000;
          const lines = campLines || GOSSIP_LINES[mob.kind] || VILLAGER_LINES;
          this.fxNear(mob, {
            t: 'chat', id: mob.id, name: mob.name || def.name,
            text: lines[rand(0, lines.length - 1)],
          });
          break;
        }
      }
    }

    // Raiders march on their objective before all else.
    if (mob.dest) {
      if (dist(mob, mob.dest) <= 2) mob.dest = null;
      else if (t >= mob.moveAt) {
        mob.moveAt = t + (t < (mob.slowUntil || 0) ? def.speedMs * 2 : def.speedMs);
        this.stepToward(mob, mob.dest.x, mob.dest.y);
      }
      return;
    }

    // No target: leash home if wandered far, otherwise amble around.
    if (t >= mob.moveAt && Math.random() < 0.25) {
      mob.moveAt = t + def.speedMs * 2;
      const home = { x: mob.homeX, y: mob.homeY };
      if (dist(mob, home) > mob.spawner.r + 4) this.stepToward(mob, home.x, home.y);
      else this.stepToward(mob, mob.x + rand(-1, 1), mob.y + rand(-1, 1));
    }
  }

  stepToward(mob, tx, ty) {
    const dx = Math.sign(tx - mob.x);
    const dy = Math.sign(ty - mob.y);
    // Direct routes first, then perpendicular sidesteps so mobs slide along
    // cliffs and shorelines instead of jamming against them forever.
    const options = [[dx, dy], [dx, 0], [0, dy], [-dy, dx], [dy, -dx]];
    for (const [ox, oy] of options) {
      if (ox === 0 && oy === 0) continue;
      const nx = mob.x + ox;
      const ny = mob.y + oy;
      if (!isWalkable(this.map, nx, ny)) continue;
      // Don't let mobs stack on each other.
      let blocked = false;
      for (const id of mob.spawner.alive) {
        const m = this.mobs.get(id);
        if (m && m !== mob && m.x === nx && m.y === ny) { blocked = true; break; }
      }
      if (blocked) continue;
      mob.x = nx;
      mob.y = ny;
      return;
    }
  }

  // ---- world events: every so often, raiders march on a village -------------------

  maybeStartEvent() {
    if (this.event || this.players.size === 0 || Math.random() > 0.22) return;
    const v = this.map.villages[rand(0, this.map.villages.length - 1)];
    const kind = Math.random() > 0.5 ? 'orc' : 'goblin';
    const stub = { alive: new Set(), x: v.x + 18, y: v.y + 18, r: 4, kind, respawnMs: Infinity };
    const ids = new Set();
    for (let i = 0; i < 8; i++) {
      this.spawnMob(stub);
    }
    if (kind === 'orc') {
      // wolf-riders ride at the head of every orc warband
      const outriders = { alive: new Set(), x: v.x + 18, y: v.y + 18, r: 4, kind: 'wolfrider', respawnMs: Infinity };
      for (let i = 0; i < 3; i++) this.spawnMob(outriders);
      for (const id of outriders.alive) stub.alive.add(id);
    }
    for (const id of stub.alive) {
      const m = this.mobs.get(id);
      if (m) {
        m.dest = { x: v.x + rand(-3, 3), y: v.y + rand(-3, 3) };
        m.aggroBoost = 12; // raiders look for trouble
        ids.add(id);
      }
    }
    this.event = { village: v, ids, until: now() + 6 * 60_000, kind };
    this.broadcastSys(`⚔ ${kind === 'orc' ? 'An orc warband' : 'A goblin mob'} is raiding ${v.name}! Defenders needed!`);
  }

  tickEvent(t) {
    if (!this.event) return;
    for (const id of this.event.ids) {
      if (!this.mobs.has(id)) this.event.ids.delete(id);
    }
    if (this.event.ids.size === 0) {
      const v = this.event.village;
      this.broadcastSys(`🏆 The raid on ${v.name} is broken! The grateful villagers leave a reward.`);
      for (const [item, min, max] of [['gold', 80, 160], ['heal', 1, 2], ['mana', 1, 2]]) {
        this.drops.set(this.nextId, {
          id: this.nextId++, x: v.x + rand(-1, 1), y: v.y + rand(-1, 1),
          item, amount: rand(min, max), despawnAt: t + 3 * 60_000,
        });
      }
      this.event = null;
    } else if (t > this.event.until) {
      for (const id of this.event.ids) {
        const m = this.mobs.get(id);
        if (m) {
          this.mobs.delete(id);
          m.spawner.alive.delete(id);
        }
      }
      this.broadcastSys(`The raiders have taken what they could from ${this.event.village.name} and slunk away.`);
      this.event = null;
    }
  }

  // ---- main loop ----------------------------------------------------------------

  tick() {
    const tickStart = process.hrtime.bigint();
    const t = now();

    // Telegraphed slams land.
    if (this.pendingAoes.length) {
      const due = this.pendingAoes.filter((a) => t >= a.at);
      this.pendingAoes = this.pendingAoes.filter((a) => t < a.at);
      for (const a of due) {
        this.fxNear(a, { t: 'fx', kind: 'slam', x: a.x, y: a.y });
        for (const q of this.players.values()) {
          if (!q.dead && Math.abs(q.x - a.x) <= 1 && Math.abs(q.y - a.y) <= 1) {
            this.hitPlayer(q, a.dmg, a.by);
          }
        }
      }
    }

    this.tickEvent(t);

    // Bucket players into a coarse grid so each mob's aggro scan only looks
    // at its own neighbourhood instead of every player online.
    this.playerGrid = new Map();
    for (const q of this.players.values()) {
      if (q.dead) continue;
      const key = ((q.x >> 5) << 16) | (q.y >> 5);
      const cell = this.playerGrid.get(key);
      if (cell) cell.push(q);
      else this.playerGrid.set(key, [q]);
    }

    for (const mob of this.mobs.values()) this.mobTick(mob, t);

    for (const p of this.players.values()) {
      this.meleeTick(p, t);
      if (!p.dead) this.pickupDrops(p);
      if (!p.dead && p.tmaps && p.tmaps.length) {
        for (const i of p.tmaps.slice()) {
          const sc = this.map.secrets[i];
          if (Math.abs(sc.x - p.x) <= 2 && Math.abs(sc.y - p.y) <= 2) {
            p.tmaps = p.tmaps.filter((m) => m !== i);
            const stocked = [...this.drops.values()].some((d) => d.cacheIdx === i);
            if (!stocked) {
              this.cacheRespawns.delete(i);
              this.stockCache(sc, i);
            }
            // A practiced eye reads the ground itself: the better the
            // treasure hunter, the more the dig turns up beyond the cache.
            const th = p.skills.treasurehunting;
            this.drops.set(this.nextId, {
              id: this.nextId++, x: sc.x, y: sc.y,
              item: 'gold', amount: rand(5, 5 + Math.round(th * 2)),
              despawnAt: t + DROP_TTL_MS,
            });
            if (Math.random() * 100 < th / 2) {
              this.drops.set(this.nextId, {
                id: this.nextId++, x: sc.x, y: sc.y,
                item: 'gems', amount: rand(1, 2), despawnAt: t + DROP_TTL_MS,
              });
            }
            this.deed(p, 'digger');
            this.gainSkill(p, 'treasurehunting');
            this.sys(p, 'This is the place. X marks the spot — and the ground gives easily.');
            this.sendYou(p);
          }
        }
      }
      if (!p.dead && !p.deeds.wayfarer && t % 1000 < TICK_MS) {
        for (const v of this.map.villages) {
          if (Math.abs(v.x - p.x) < 12 && Math.abs(v.y - p.y) < 12) {
            this.deed(p, 'wayfarer');
            break;
          }
        }
      }
      // Passive regeneration, once a second.
      if (!p.dead && t >= p.regenAt) {
        p.regenAt = t + 1000;
        let changed = false;
        if (p.hp < maxHp(p) && Math.random() < 0.35) { p.hp += 1; changed = true; }
        if (p.fedUntil > t && p.hp < maxHp(p)) { p.hp = Math.min(maxHp(p), p.hp + 2); changed = true; }
        if (p.mana < p.int) { p.mana = Math.min(p.int, p.mana + 1); changed = true; }
        if (changed) this.sendYou(p);
      }
    }

    const night = dayDarkness() > 0.3;
    for (const sp of this.spawners) {
      if (sp.nightOnly && !night) {
        // dawn lays the restless back down — unless they're mid-fight
        for (const id of [...sp.alive]) {
          const m = this.mobs.get(id);
          if (m && !m.target) {
            this.mobs.delete(id);
            sp.alive.delete(id);
            this.fxNear(m, { t: 'fx', kind: 'evade', x: m.x, y: m.y });
          }
        }
        continue;
      }
      if (sp.alive.size < sp.count && t >= (sp.respawnAt || 0)) {
        sp.respawnAt = t + (sp.respawnMs || 20_000);
        this.spawnMob(sp);
      }
    }

    this.respawnResources(t);

    for (const [id, d] of this.drops) {
      if (t >= d.despawnAt) this.drops.delete(id);
    }
    for (const [idx, at] of this.cacheRespawns) {
      if (t >= at) {
        this.cacheRespawns.delete(idx);
        this.stockCache(this.map.secrets[idx], idx);
      }
    }

    // Interest-managed state: each player sees only what's near them.
    const players = [...this.players.values()];
    const mobs = [...this.mobs.values()];
    const drops = [...this.drops.values()];
    for (const p of players) {
      const near = (e) => Math.abs(e.x - p.x) <= VIEW_RADIUS && Math.abs(e.y - p.y) <= VIEW_RADIUS;
      this.send(p.ws, {
        t: 'state',
        players: players.filter(near).map((q) => {
          const gear = (slot) => {
            const it = q[slot] != null && q.items.find((i) => i.uid === q[slot]);
            return it ? it.id : 0;
          };
          return {
            id: q.id, name: q.name, x: q.x, y: q.y,
            hp: q.hp, maxhp: maxHp(q), dead: q.dead,
            a: t - (q.swungAt || 0) < 600 ? 1 : 0,
            w: gear('weapon'), ar: gear('armor'), oh: gear('offhand'),
          };
        }),
        mobs: mobs.filter(near).map((m) => ({
          id: m.id, kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxhp: m.maxhp,
          a: t - (m.swungAt || 0) < 700 ? 1 : 0,
          name: m.name,
          pet: m.owner ? 1 : undefined,
        })),
        drops: drops.filter(near).map((d) => ({ id: d.id, x: d.x, y: d.y, item: d.item, q: d.w ? d.w.q : undefined })),
      });
    }

    this.lastTickMs = Number(process.hrtime.bigint() - tickStart) / 1e6;
  }

  // ---- plumbing -------------------------------------------------------------------

  sendYou(p) {
    this.send(p.ws, {
      t: 'you',
      hp: p.hp, maxhp: maxHp(p), mana: p.mana, maxmana: p.int,
      str: p.str, dex: p.dex, int: p.int,
      skills: p.skills,
      gold: p.gold, logs: p.logs, ore: p.ore, gems: p.gems,
      fish: p.fish, meat: p.meat, food: p.food, herbs: p.herbs,
      tmaps: (p.tmaps || []).map((i) => {
        const sc = this.map.secrets[i];
        return { i, x: sc.x, y: sc.y };
      }),
      mats: p.mats,
      deeds: p.deeds,
      title: titleOf(p),
      pots: p.pots,
      items: p.items,
      weapon: p.weapon,
      armor: p.armor,
      offhand: p.offhand,
      arrows: p.arrows,
      blessed: p.buffUntil > now() ? 1 : 0,
      dead: p.dead,
    });
  }

  sys(p, text) {
    this.send(p.ws, { t: 'sys', text });
  }

  broadcastSys(text, exceptId) {
    for (const p of this.players.values()) {
      if (p.id !== exceptId) this.sys(p, text);
    }
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === 1) p.ws.send(data);
    }
  }

  // Effects only matter to players close enough to see them.
  fxNear(at, msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (Math.abs(p.x - at.x) <= VIEW_RADIUS && Math.abs(p.y - at.y) <= VIEW_RADIUS &&
          p.ws.readyState === 1) {
        p.ws.send(data);
      }
    }
  }
}

function maxHp(p) {
  return 50 + Math.floor(p.str / 2);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function skillName(skill) {
  if (skill === 'treasurehunting') return 'Treasure Hunting';
  return skill.charAt(0).toUpperCase() + skill.slice(1);
}

module.exports = { Game, MOB_KINDS, WEAPONS };
