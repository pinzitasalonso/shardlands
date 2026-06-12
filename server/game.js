'use strict';

// Core game simulation: players, mobs, combat, skills, magic, gathering,
// vendors, loot and the world's secrets. The server is authoritative;
// clients only send intents.
//
// The world is large (2048x2048), so two things are streamed rather than
// broadcast wholesale: map tiles go out in 64x64 chunks on request, and each
// player only receives entities within their interest radius.

const crypto = require('crypto');
const { TILE, generate, isWalkable, tileAt, nearestWalkable } = require('./world');
const persist = require('./persist');

const TICK_MS = 100;
const SAVE_INTERVAL_MS = 30_000;
const SKILL_CAP = 100;
const STAT_CAP = 100;
const CHUNK = 64;
const MINI_SCALE = 8;
const VIEW_RADIUS = 60;          // tiles; entities beyond this aren't sent
const CACHE_RESPAWN_MS = 15 * 60_000;

const SKILLS = ['swordsmanship', 'tactics', 'magery', 'healing', 'lumberjacking', 'mining', 'fishing', 'cooking', 'blacksmithy'];

const SPELLS = {
  magicarrow: { name: 'Magic Arrow', mana: 4, minSkill: 0, dmg: [5, 10], words: 'In Por Ylem' },
  fireball: { name: 'Fireball', mana: 9, minSkill: 40, dmg: [12, 22], words: 'Vas Flam' },
  greaterheal: { name: 'Greater Heal', mana: 11, minSkill: 30, heal: [15, 25], words: 'In Vas Mani' },
  bless: { name: 'Bless', mana: 8, minSkill: 25, buff: 8, buffMs: 60_000, words: 'Rel Sanct' },
  poison: { name: 'Poison', mana: 6, minSkill: 20, dot: [3, 5], words: 'In Nox' },
  energybolt: { name: 'Energy Bolt', mana: 14, minSkill: 55, dmg: [20, 30], words: 'Corp Por' },
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
  // Crowned terrors. Slain ones return after a long while.
  goblinking: { name: 'Skarg, the Goblin King', hp: 130, dmg: [6, 12], skill: 60, gold: 220, speedMs: 320, aggro: 9, boss: true },
  vyrmaur: { name: 'Vyrmaur the Undying', hp: 900, dmg: [22, 40], skill: 110, gold: 1500, speedMs: 380, aggro: 12, boss: true },
  bonelord: { name: 'the Bone Lord', hp: 170, dmg: [8, 14], skill: 75, gold: 280, speedMs: 450, aggro: 9, boss: true },
  wolfking: { name: 'Greyfang, the Wolf King', hp: 150, dmg: [7, 13], skill: 70, gold: 240, speedMs: 330, aggro: 9, boss: true },
  skelmage: { name: 'a skeleton mage', hp: 26, dmg: [2, 4], skill: 50, gold: 24, speedMs: 550, aggro: 8, caster: { range: 7, dmg: [6, 12], cdMs: 2600 } },
};

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

// What corpses leave behind, beyond the guaranteed gold: [chance, item, min, max].
// Weapon rows are [chance, 'weapon', pool of ids, qualityMin, qualityMax].
const LOOT_TABLES = {
  goblin: [[0.18, 'gold', 4, 10], [0.08, 'mana', 1, 1], [0.04, 'weapon', ['dagger'], 0, 1]],
  skeleton: [[0.2, 'gold', 8, 20], [0.12, 'heal', 1, 1], [0.1, 'weapon', ['sword'], 0, 2]],
  skelmage: [[0.4, 'gold', 10, 26], [0.2, 'mana', 1, 2]],
  orc: [[0.22, 'gold', 12, 30], [0.12, 'heal', 1, 1], [0.1, 'ore', 1, 2], [0.08, 'weapon', ['sword', 'mace'], 0, 1]],
  ettin: [[0.35, 'gold', 30, 70], [0.2, 'heal', 1, 1], [0.15, 'logs', 2, 4], [0.1, 'weapon', ['battleaxe'], 1, 2]],
  dragon: [[1, 'gold', 150, 400], [0.8, 'heal', 1, 2], [0.6, 'mana', 1, 2], [0.5, 'gems', 1, 2], [0.5, 'weapon', ['greatsword'], 3, 4]],
  wolf: [[0.3, 'gold', 3, 10]],
  deer: [[0.35, 'gold', 2, 6]],
  snake: [[0.3, 'gold', 3, 9], [0.06, 'mana', 1, 1]],
  crab: [[0.3, 'gold', 2, 7]],
  boar: [[0.35, 'gold', 3, 10], [0.08, 'heal', 1, 1]],
  goblinking: [[1, 'gold', 100, 250], [1, 'gems', 1, 2], [0.6, 'heal', 1, 2], [1, 'weapon', ['sword', 'mace'], 2, 3]],
  bonelord: [[1, 'gold', 120, 300], [1, 'gems', 1, 2], [0.6, 'mana', 1, 2], [1, 'weapon', ['battleaxe', 'greatsword'], 2, 4]],
  wolfking: [[1, 'gold', 100, 260], [1, 'gems', 1, 2], [0.6, 'heal', 1, 2], [1, 'weapon', ['sword'], 2, 3]],
  vyrmaur: [[1, 'gold', 800, 1500], [1, 'gems', 3, 6], [1, 'heal', 2, 3]],
};

const DROP_TTL_MS = 60_000;
const RESOURCE_RESPAWN_MS = 90_000;

const POTIONS = {
  heal: { name: 'Greater Heal Potion', restore: [25, 40] },
  mana: { name: 'Mana Potion', restore: [20, 30] },
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
};

function titleOf(p) {
  for (const sk of SKILLS) {
    if (p.skills[sk] >= 100) {
      return 'Grandmaster ' + sk.charAt(0).toUpperCase() + sk.slice(1);
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

    if (!EMAIL_RE.test(email)) {
      return this.send(ws, { t: 'reject', reason: 'Enter a valid email address.' });
    }
    if (password.length < 6) {
      return this.send(ws, { t: 'reject', reason: 'Password must be at least 6 characters.' });
    }

    let account = this.accounts[email];
    let rec;

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
      this.dirty = true;
    }

    for (const p of this.players.values()) {
      if (p.key === account.charKey) {
        return this.send(ws, { t: 'reject', reason: 'That character is already in the world.' });
      }
    }

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
      mats: { frostwood: 0, sunsteel: 0, ironbark: 0, ...rec.mats },
      deeds: { ...rec.deeds },
      pots: { heal: 0, mana: 0, ...rec.pots },
      items: (rec.items || []).map((i) => ({ ...i })),
      weapon: rec.weapon ?? null,
      armor: rec.armor ?? null,
      offhand: rec.offhand ?? null,
      arrows: rec.arrows || 0,
      buffUntil: 0,
      itemUid: rec.itemUid || 1,
      dead: false,
      target: 0,
      moveAt: 0, swingAt: 0, castAt: 0, bandageAt: 0, regenAt: 0, drinkAt: 0, portalAt: 0,
      whispered: new Set(),
    };
    ws.player = p;
    this.players.set(p.id, p);

    this.send(ws, {
      t: 'welcome',
      id: p.id,
      map: { w: this.map.w, h: this.map.h, chunk: CHUNK },
      mini: this.miniData,
      buildings: this.map.buildings,
      props: this.map.props,
      villages: this.map.villages.map((v) => ({ name: v.name, x: v.x, y: v.y })),
      epoch: Date.now(),
      spells: SPELLS,
      weapons: WEAPONS,
      qualities: QUALITIES,
      vendors: this.vendors,
    });
    this.sendYou(p);
    this.sys(p, `Welcome to Shardlands, ${p.name}. The shrine in Briarhaven will raise you if you fall.`);
    this.broadcastSys(`${p.name} has entered the world.`, p.id);
  }

  leave(ws) {
    const p = ws.player;
    if (!p) return;
    this.players.delete(p.id);
    this.persistPlayer(p);
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
      mats: { ...p.mats },
      deeds: { ...p.deeds },
      pots: { ...p.pots },
      items: p.items.map((i) => ({ ...i })),
      weapon: p.weapon,
      armor: p.armor,
      offhand: p.offhand,
      arrows: p.arrows,
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

  handleChunks(p, list) {
    if (!Array.isArray(list)) return;
    const maxC = this.map.w / CHUNK;
    for (const pair of list.slice(0, 48)) {
      if (!Array.isArray(pair)) continue;
      const cx = pair[0] | 0;
      const cy = pair[1] | 0;
      if (cx < 0 || cy < 0 || cx >= maxC || cy >= maxC) continue;
      const buf = Buffer.alloc(CHUNK * CHUNK);
      for (let y = 0; y < CHUNK; y++) {
        const row = (cy * CHUNK + y) * this.map.w + cx * CHUNK;
        for (let x = 0; x < CHUNK; x++) buf[y * CHUNK + x] = this.map.tiles[row + x];
      }
      this.send(p.ws, { t: 'chunk', cx, cy, d: buf.toString('base64') });
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
    p.moveAt = t + (dx !== 0 && dy !== 0 ? 165 : 118);

    if (p.dead && tileAt(this.map, p.x, p.y) === TILE.SHRINE) this.resurrect(p);
    if (!p.dead) this.checkSecrets(p, t);
  }

  checkSecrets(p, t) {
    for (let i = 0; i < this.map.secrets.length; i++) {
      const s = this.map.secrets[i];
      if (s.type === 'portal' && s.x === p.x && s.y === p.y) {
        if (t < p.portalAt) return;
        p.portalAt = t + 4000; // don't bounce straight back
        this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
        p.x = s.tx;
        p.y = s.ty;
        p.moveAt = t + 600;
        this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
        this.sys(p, 'The standing stones flare with old magic, and the world lurches.');
        return;
      }
      if (s.type === 'whisper' && !p.whispered.has(i) &&
          Math.abs(s.x - p.x) <= 2 && Math.abs(s.y - p.y) <= 2) {
        p.whispered.add(i);
        this.sys(p, s.text);
      }
    }
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
    if (cmd === 'teleport' || cmd === 'home' || cmd === 'recall') {
      if (p.dead) return this.sys(p, 'The dead must walk to a shrine.');
      const t = now();
      if (t < (p.teleportAt || 0)) {
        return this.sys(p, `The winds are spent. Try again in ${Math.ceil((p.teleportAt - t) / 1000)} seconds.`);
      }
      p.teleportAt = t + 60_000;
      this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
      p.x = this.map.spawn.x;
      p.y = this.map.spawn.y;
      p.moveAt = t + 600;
      p.target = 0;
      this.fxNear(p, { t: 'fx', kind: 'portal', x: p.x, y: p.y });
      this.sys(p, 'The winds carry you home to the Briarhaven plaza.');
      return;
    }
    this.sys(p, `Unknown command: /${cmd}. Commands: /teleport`);
  }

  handleAttack(p, mobId) {
    if (p.dead) return this.sys(p, 'You are a ghost. Seek the shrine.');
    const mob = this.mobs.get(mobId);
    if (!mob) return;
    if (MOB_KINDS[mob.kind].peaceful) {
      return this.sys(p, 'The townsfolk are under the crown\'s protection.');
    }
    p.target = mobId;
    this.sys(p, `You attack ${mob.name || MOB_KINDS[mob.kind].name}.`);
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
    } else if (spell.dot) {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else if (MOB_KINDS[mob.kind].peaceful) {
        this.sys(p, 'The townsfolk are under the crown\'s protection.');
      } else {
        mob.poison = { left: 5, dmg: rand(spell.dot[0], spell.dot[1]), nextAt: t + 2000, by: p.id };
        this.fxNear(mob, { t: 'fx', kind: 'poison', x: mob.x, y: mob.y });
        this.sys(p, `${mob.name || MOB_KINDS[mob.kind].name} turns a sickly green.`);
      }
    } else {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else if (MOB_KINDS[mob.kind].peaceful) {
        this.sys(p, 'The townsfolk are under the crown\'s protection.');
      } else {
        const dmg = rand(spell.dmg[0], spell.dmg[1]) + Math.floor(p.skills.magery / (spellId === 'energybolt' ? 8 : 12));
        this.fxNear(p, { t: 'fx', kind: spellId === 'energybolt' ? 'fireball' : spellId, x: p.x, y: p.y, tx: mob.x, ty: mob.y, amount: dmg });
        this.damageMob(p, mob, dmg);
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
    this.sys(p, 'There is nothing here to gather. Stand beside a tree, rock face or water.');
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

  damageMob(attacker, mob, dmg) {
    mob.hp -= dmg;
    const def = MOB_KINDS[mob.kind];
    if (def.aggro === 0 && !def.peaceful) {
      // Prey bolts rather than bites.
      mob.fleeUntil = now() + 6000;
      mob.fleeFrom = { x: attacker.x, y: attacker.y };
    } else {
      mob.target = attacker.id; // fighting back
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
      if (d.item === 'weapon' && d.w.id === id) return true;
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
    for (const entry of LOOT_TABLES[mob.kind] || []) {
      if (Math.random() > entry[0]) continue;
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

    // The frightened run first and think later.
    if (mob.fleeUntil && t < mob.fleeUntil) {
      if (t >= mob.moveAt) {
        mob.moveAt = t + def.speedMs;
        this.stepToward(mob, 2 * mob.x - mob.fleeFrom.x, 2 * mob.y - mob.fleeFrom.y);
      }
      return;
    }

    // Acquire or validate a target.
    let target = mob.target ? this.players.get(mob.target) : null;
    if (target && (target.dead || dist(mob, target) > 14)) {
      mob.target = 0;
      target = null;
    }
    if (!target && def.aggro > 0) {
      for (const p of this.players.values()) {
        if (!p.dead && dist(mob, p) <= def.aggro) {
          mob.target = p.id;
          target = p;
          break;
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
        this.fxNear(mob, { t: 'fx', kind: 'mbolt', x: mob.x, y: mob.y, tx: target.x, ty: target.y });
        this.hitPlayer(target, rand(def.caster.dmg[0], def.caster.dmg[1]), mob.name || def.name);
        return;
      }

      if (d <= 1.5) {
        if (t >= mob.swingAt) {
          mob.swingAt = t + 1600;
          mob.swungAt = t;
          const hitChance = clamp(50 + (def.skill - target.skills.swordsmanship) / 2, 10, 95);
          if (Math.random() * 100 <= hitChance) {
            this.hitPlayer(target, rand(def.dmg[0], def.dmg[1]), mob.name || def.name);
          } else {
            this.fxNear(target, { t: 'fx', kind: 'miss', x: target.x, y: target.y });
          }
        }
      } else if (t >= mob.moveAt) {
        mob.moveAt = t + def.speedMs;
        this.stepToward(mob, target.x, target.y);
      }
      return;
    }

    // Townsfolk gossip at passers-by.
    if (def.peaceful && t >= mob.chatAt && Math.random() < 0.004) {
      for (const p of this.players.values()) {
        if (dist(mob, p) <= 7) {
          mob.chatAt = t + 25_000;
          this.fxNear(mob, {
            t: 'chat', id: mob.id, name: mob.name || def.name,
            text: VILLAGER_LINES[rand(0, VILLAGER_LINES.length - 1)],
          });
          break;
        }
      }
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

  // ---- main loop ----------------------------------------------------------------

  tick() {
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

    for (const mob of this.mobs.values()) this.mobTick(mob, t);

    for (const p of this.players.values()) {
      this.meleeTick(p, t);
      if (!p.dead) this.pickupDrops(p);
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

    for (const sp of this.spawners) {
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
        })),
        drops: drops.filter(near).map((d) => ({ id: d.id, x: d.x, y: d.y, item: d.item, q: d.w ? d.w.q : undefined })),
      });
    }
  }

  // ---- plumbing -------------------------------------------------------------------

  sendYou(p) {
    this.send(p.ws, {
      t: 'you',
      hp: p.hp, maxhp: maxHp(p), mana: p.mana, maxmana: p.int,
      str: p.str, dex: p.dex, int: p.int,
      skills: p.skills,
      gold: p.gold, logs: p.logs, ore: p.ore, gems: p.gems,
      fish: p.fish, meat: p.meat, food: p.food,
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
  return skill.charAt(0).toUpperCase() + skill.slice(1);
}

module.exports = { Game };
