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

const SKILLS = ['swordsmanship', 'tactics', 'magery', 'healing', 'lumberjacking', 'mining'];

const SPELLS = {
  magicarrow: { name: 'Magic Arrow', mana: 4, minSkill: 0, dmg: [5, 10], words: 'In Por Ylem' },
  fireball: { name: 'Fireball', mana: 9, minSkill: 40, dmg: [12, 22], words: 'Vas Flam' },
  greaterheal: { name: 'Greater Heal', mana: 11, minSkill: 30, heal: [15, 25], words: 'In Vas Mani' },
};

const MOB_KINDS = {
  goblin: { name: 'a goblin', hp: 16, dmg: [2, 4], skill: 22, gold: 6, speedMs: 350, aggro: 6 },
  skeleton: { name: 'a skeleton', hp: 32, dmg: [3, 7], skill: 45, gold: 18, speedMs: 500, aggro: 7 },
  orc: { name: 'an orc', hp: 48, dmg: [4, 9], skill: 55, gold: 30, speedMs: 450, aggro: 7 },
  ettin: { name: 'an ettin', hp: 95, dmg: [8, 16], skill: 65, gold: 70, speedMs: 600, aggro: 8 },
  dragon: { name: 'a dragon', hp: 320, dmg: [16, 30], skill: 95, gold: 600, speedMs: 400, aggro: 10 },
};

// What corpses leave behind, beyond the guaranteed gold: [chance, item, min, max].
const LOOT_TABLES = {
  goblin: [[0.18, 'gold', 4, 10], [0.08, 'mana', 1, 1]],
  skeleton: [[0.2, 'gold', 8, 20], [0.12, 'heal', 1, 1]],
  orc: [[0.22, 'gold', 12, 30], [0.12, 'heal', 1, 1], [0.1, 'ore', 1, 2]],
  ettin: [[0.35, 'gold', 30, 70], [0.2, 'heal', 1, 1], [0.15, 'logs', 2, 4]],
  dragon: [[1, 'gold', 150, 400], [0.8, 'heal', 1, 2], [0.6, 'mana', 1, 2], [0.5, 'gems', 1, 2]],
};

const DROP_TTL_MS = 60_000;
const RESOURCE_RESPAWN_MS = 90_000;

const POTIONS = {
  heal: { name: 'Greater Heal Potion', restore: [25, 40] },
  mana: { name: 'Mana Potion', restore: [20, 30] },
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const now = () => Date.now();

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
      skills: { ...rec.skills },
      gold: rec.gold, logs: rec.logs, ore: rec.ore, gems: rec.gems || 0,
      pots: { heal: 0, mana: 0, ...rec.pots },
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
      spells: SPELLS,
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
      pots: { ...p.pots },
    });
    this.dirty = true;
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
      case 'buy': return this.handleBuy(p, String(msg.item || ''));
      case 'drink': return this.handleDrink(p, String(msg.kind || ''));
      case 'chunks': return this.handleChunks(p, msg.l);
    }
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

  handleBuy(p, item) {
    if (p.dead) return this.sys(p, 'The dead cannot trade.');
    const vendor = this.vendors.find((v) => dist(p, v) <= 3);
    if (!vendor) return this.sys(p, 'You are too far from a shopkeeper.');
    const good = vendor.goods.find((g) => g.item === item);
    if (!good) return;
    if (p.gold < good.price) {
      return this.sys(p, `${vendor.name} says: That is ${good.price} gold, which thou dost not have.`);
    }
    p.gold -= good.price;
    p.pots[item] = (p.pots[item] || 0) + 1;
    this.sys(p, `You buy a ${good.name} for ${good.price} gold.`);
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
    p.moveAt = t + (dx !== 0 && dy !== 0 ? 210 : 150);

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
    this.broadcast({ t: 'chat', id: p.id, name: p.name, text });
  }

  handleAttack(p, mobId) {
    if (p.dead) return this.sys(p, 'You are a ghost. Seek the shrine.');
    const mob = this.mobs.get(mobId);
    if (!mob) return;
    p.target = mobId;
    this.sys(p, `You attack ${MOB_KINDS[mob.kind].name}.`);
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
    } else {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else {
        const dmg = rand(spell.dmg[0], spell.dmg[1]) + Math.floor(p.skills.magery / 12);
        this.fxNear(p, { t: 'fx', kind: spellId, x: p.x, y: p.y, tx: mob.x, ty: mob.y, amount: dmg });
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
      if (tile === TILE.TREE) {
        if (Math.random() * 100 < p.skills.lumberjacking + 40) {
          p.logs += 1;
          this.sys(p, 'You chop some logs.');
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
    this.sys(p, 'There is nothing here to gather. Stand beside a tree or rock face.');
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
    this.setTile(x, y, TILE.GRASS);
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
    mob.target = attacker.id; // fighting back
    this.fxNear(mob, { t: 'fx', kind: 'hit', x: mob.x, y: mob.y, amount: dmg });
    if (mob.hp <= 0) this.killMob(attacker, mob);
  }

  killMob(killer, mob) {
    const def = MOB_KINDS[mob.kind];
    const gold = rand(Math.ceil(def.gold * 0.6), def.gold);
    killer.gold += gold;
    this.mobs.delete(mob.id);
    mob.spawner.alive.delete(mob.id);
    mob.spawner.respawnAt = now() + 20_000;
    this.sys(killer, `You have slain ${def.name}! You loot ${gold} gold.`);
    this.fxNear(mob, { t: 'fx', kind: 'die', x: mob.x, y: mob.y });
    this.rollLoot(mob);
    this.sendYou(killer);
  }

  // The corpse sometimes leaves something on the ground; first to step on
  // the tile claims it.
  rollLoot(mob) {
    for (const [chance, item, min, max] of LOOT_TABLES[mob.kind] || []) {
      if (Math.random() > chance) continue;
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
    if (dist(p, mob) > 1.5 || t < p.swingAt) return;
    p.swingAt = t + Math.max(900, 2000 - p.dex * 10);

    const hitChance = clamp(50 + (p.skills.swordsmanship - MOB_KINDS[mob.kind].skill) / 2, 10, 95);
    this.gainSkill(p, 'swordsmanship');
    if (Math.random() * 100 > hitChance) {
      this.fxNear(mob, { t: 'fx', kind: 'miss', x: mob.x, y: mob.y });
      return;
    }
    this.gainSkill(p, 'tactics');
    this.gainStat(p, 'str');
    const base = rand(2, 8) + Math.floor(p.str / 10);
    const dmg = Math.max(1, Math.floor(base * (0.5 + p.skills.tactics / 150)));
    this.damageMob(p, mob, dmg);
  }

  // ---- skills & stats ---------------------------------------------------------

  gainSkill(p, skill) {
    const cur = p.skills[skill];
    if (cur >= SKILL_CAP) return;
    // Classic use-based gains: the better you are, the rarer the gain.
    if (Math.random() < (SKILL_CAP - cur) / 220 + 0.02) {
      p.skills[skill] = Math.min(SKILL_CAP, Math.round((cur + 0.5) * 10) / 10);
      this.sys(p, `Your ${skillName(skill)} has risen to ${p.skills[skill].toFixed(1)}.`);
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
        moveAt: 0, swingAt: 0,
        spawner,
      };
      this.mobs.set(mob.id, mob);
      spawner.alive.add(mob.id);
      return;
    }
  }

  mobTick(mob, t) {
    const def = MOB_KINDS[mob.kind];

    // Acquire or validate a target.
    let target = mob.target ? this.players.get(mob.target) : null;
    if (target && (target.dead || dist(mob, target) > 14)) {
      mob.target = 0;
      target = null;
    }
    if (!target) {
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
      if (d <= 1.5) {
        if (t >= mob.swingAt) {
          mob.swingAt = t + 1600;
          const hitChance = clamp(50 + (def.skill - target.skills.swordsmanship) / 2, 10, 95);
          if (Math.random() * 100 <= hitChance) {
            const dmg = rand(def.dmg[0], def.dmg[1]);
            target.hp -= dmg;
            this.fxNear(target, { t: 'fx', kind: 'hit', x: target.x, y: target.y, amount: dmg });
            if (target.hp <= 0) this.killPlayer(target, def.name);
            else this.sendYou(target);
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

    for (const mob of this.mobs.values()) this.mobTick(mob, t);

    for (const p of this.players.values()) {
      this.meleeTick(p, t);
      if (!p.dead) this.pickupDrops(p);
      // Passive regeneration, once a second.
      if (!p.dead && t >= p.regenAt) {
        p.regenAt = t + 1000;
        let changed = false;
        if (p.hp < maxHp(p) && Math.random() < 0.35) { p.hp += 1; changed = true; }
        if (p.mana < p.int) { p.mana = Math.min(p.int, p.mana + 1); changed = true; }
        if (changed) this.sendYou(p);
      }
    }

    for (const sp of this.spawners) {
      if (sp.alive.size < sp.count && t >= (sp.respawnAt || 0)) {
        sp.respawnAt = t + 20_000;
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
        players: players.filter(near).map((q) => ({
          id: q.id, name: q.name, x: q.x, y: q.y,
          hp: q.hp, maxhp: maxHp(q), dead: q.dead,
        })),
        mobs: mobs.filter(near).map((m) => ({
          id: m.id, kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxhp: m.maxhp,
        })),
        drops: drops.filter(near).map((d) => ({ id: d.id, x: d.x, y: d.y, item: d.item })),
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
      pots: p.pots,
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
