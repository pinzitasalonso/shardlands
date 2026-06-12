'use strict';

// Core game simulation: players, mobs, combat, skills, magic, gathering.
// The server is authoritative; clients only send intents.

const crypto = require('crypto');
const { TILE, generate, isWalkable, tileAt, nearestWalkable } = require('./world');
const persist = require('./persist');

const TICK_MS = 100;
const SAVE_INTERVAL_MS = 30_000;
const SKILL_CAP = 100;
const STAT_CAP = 100;

const SKILLS = ['swordsmanship', 'tactics', 'magery', 'healing', 'lumberjacking', 'mining'];

const SPELLS = {
  magicarrow: { name: 'Magic Arrow', mana: 4, minSkill: 0, dmg: [5, 10], words: 'In Por Ylem' },
  fireball: { name: 'Fireball', mana: 9, minSkill: 40, dmg: [12, 22], words: 'Vas Flam' },
  greaterheal: { name: 'Greater Heal', mana: 11, minSkill: 30, heal: [15, 25], words: 'In Vas Mani' },
};

const MOB_KINDS = {
  mongbat: { name: 'a mongbat', hp: 14, dmg: [1, 3], skill: 20, gold: 5, speedMs: 350, aggro: 6 },
  skeleton: { name: 'a skeleton', hp: 32, dmg: [3, 7], skill: 45, gold: 18, speedMs: 500, aggro: 7 },
  orc: { name: 'an orc', hp: 48, dmg: [4, 9], skill: 55, gold: 30, speedMs: 450, aggro: 7 },
  ettin: { name: 'an ettin', hp: 95, dmg: [8, 16], skill: 65, gold: 70, speedMs: 600, aggro: 8 },
  dragon: { name: 'a dragon', hp: 320, dmg: [16, 30], skill: 95, gold: 600, speedMs: 400, aggro: 10 },
};

// Spawn regions: kind, how many to keep alive, centre and radius.
const SPAWNERS = [
  { kind: 'mongbat', count: 6, x: 80, y: 80, r: 14 },
  { kind: 'mongbat', count: 4, x: 48, y: 90, r: 12 },
  { kind: 'skeleton', count: 6, x: 31, y: 33, r: 8 },   // the graveyard
  { kind: 'orc', count: 5, x: 95, y: 40, r: 12 },
  { kind: 'ettin', count: 2, x: 30, y: 95, r: 10 },
  { kind: 'dragon', count: 1, x: 105, y: 105, r: 8 },
];

const SPAWN_POINT = { x: 64, y: 66 };

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const now = () => Date.now();

class Game {
  constructor() {
    this.map = generate(1337);
    this.players = new Map(); // id -> player (online only)
    this.mobs = new Map();    // id -> mob
    this.nextId = 1;
    this.records = persist.load(); // lowercase name -> saved character
    this.dirty = false;

    for (const sp of SPAWNERS) {
      sp.alive = new Set();
      for (let i = 0; i < sp.count; i++) this.spawnMob(sp);
    }

    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.saveAll(), SAVE_INTERVAL_MS);
  }

  // ---- connection lifecycle -------------------------------------------------

  join(ws, name, token) {
    name = String(name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9 '-]{1,14}$/.test(name)) {
      return this.send(ws, { t: 'reject', reason: 'Name must be 2-15 letters/numbers.' });
    }
    const key = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === key) {
        return this.send(ws, { t: 'reject', reason: 'That character is already in the world.' });
      }
    }

    let rec = this.records[key];
    if (rec && rec.token !== token) {
      return this.send(ws, { t: 'reject', reason: 'That name belongs to another player.' });
    }
    if (!rec) {
      rec = this.records[key] = {
        token: crypto.randomBytes(16).toString('hex'),
        name,
        x: SPAWN_POINT.x,
        y: SPAWN_POINT.y,
        str: 35, dex: 35, int: 30,
        hp: 67, mana: 30,
        skills: Object.fromEntries(SKILLS.map((s) => [s, 20])),
        gold: 100, logs: 0, ore: 0,
      };
      this.dirty = true;
    }

    const spot = isWalkable(this.map, rec.x, rec.y)
      ? { x: rec.x, y: rec.y }
      : nearestWalkable(this.map, rec.x, rec.y);

    const p = {
      id: this.nextId++,
      ws,
      name: rec.name,
      key,
      x: spot.x,
      y: spot.y,
      str: rec.str, dex: rec.dex, int: rec.int,
      hp: Math.min(rec.hp, maxHp(rec)), mana: Math.min(rec.mana, rec.int),
      skills: { ...rec.skills },
      gold: rec.gold, logs: rec.logs, ore: rec.ore,
      dead: false,
      target: 0,
      moveAt: 0, swingAt: 0, castAt: 0, bandageAt: 0, regenAt: 0,
    };
    ws.player = p;
    this.players.set(p.id, p);

    this.send(ws, {
      t: 'welcome',
      id: p.id,
      token: rec.token,
      map: { w: this.map.w, h: this.map.h, tiles: Buffer.from(this.map.tiles).toString('base64') },
      spells: SPELLS,
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
      gold: p.gold, logs: p.logs, ore: p.ore,
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
      if (msg.t === 'join') this.join(ws, msg.name, msg.token);
      return;
    }
    switch (msg.t) {
      case 'move': return this.handleMove(p, msg.dx | 0, msg.dy | 0);
      case 'say': return this.handleSay(p, msg.text);
      case 'attack': return this.handleAttack(p, msg.id | 0);
      case 'cast': return this.handleCast(p, msg.spell, msg.id | 0);
      case 'bandage': return this.handleBandage(p);
      case 'gather': return this.handleGather(p);
    }
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
      this.broadcast({ t: 'fx', kind: 'heal', x: p.x, y: p.y, amount });
    } else {
      const mob = this.mobs.get(targetId || p.target);
      if (!mob || dist(p, mob) > 10) {
        this.sys(p, 'No target in range.');
      } else {
        const dmg = rand(spell.dmg[0], spell.dmg[1]) + Math.floor(p.skills.magery / 12);
        this.broadcast({ t: 'fx', kind: spellId, x: p.x, y: p.y, tx: mob.x, ty: mob.y, amount: dmg });
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
    this.broadcast({ t: 'fx', kind: 'heal', x: p.x, y: p.y, amount });
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
      const tile = tileAt(this.map, p.x + dx, p.y + dy);
      if (tile === TILE.TREE) {
        if (Math.random() * 100 < p.skills.lumberjacking + 40) {
          p.logs += 1;
          this.sys(p, 'You chop some logs.');
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

  // ---- combat ---------------------------------------------------------------

  damageMob(attacker, mob, dmg) {
    mob.hp -= dmg;
    mob.target = attacker.id; // fighting back
    this.broadcast({ t: 'fx', kind: 'hit', x: mob.x, y: mob.y, amount: dmg });
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
    this.broadcast({ t: 'fx', kind: 'die', x: mob.x, y: mob.y });
    this.sendYou(killer);
  }

  killPlayer(p, byName) {
    p.dead = true;
    p.hp = 0;
    p.target = 0;
    this.sys(p, `You have been slain by ${byName}. Walk your ghost to the shrine in Briarhaven.`);
    this.broadcastSys(`${p.name} has been slain by ${byName}.`, p.id);
    this.broadcast({ t: 'fx', kind: 'die', x: p.x, y: p.y });
    this.sendYou(p);
  }

  resurrect(p) {
    p.dead = false;
    p.hp = Math.ceil(maxHp(p) * 0.3);
    this.broadcast({ t: 'fx', kind: 'heal', x: p.x, y: p.y, amount: p.hp });
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
      this.broadcast({ t: 'fx', kind: 'miss', x: mob.x, y: mob.y });
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
            this.broadcast({ t: 'fx', kind: 'hit', x: target.x, y: target.y, amount: dmg });
            if (target.hp <= 0) this.killPlayer(target, def.name);
            else this.sendYou(target);
          } else {
            this.broadcast({ t: 'fx', kind: 'miss', x: target.x, y: target.y });
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
    const options = [[dx, dy], [dx, 0], [0, dy]];
    for (const [ox, oy] of options) {
      if (ox === 0 && oy === 0) continue;
      const nx = mob.x + ox;
      const ny = mob.y + oy;
      if (!isWalkable(this.map, nx, ny)) continue;
      // Don't let mobs stack on each other.
      let blocked = false;
      for (const m of this.mobs.values()) {
        if (m !== mob && m.x === nx && m.y === ny) { blocked = true; break; }
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
      // Passive regeneration, once a second.
      if (!p.dead && t >= p.regenAt) {
        p.regenAt = t + 1000;
        let changed = false;
        if (p.hp < maxHp(p) && Math.random() < 0.35) { p.hp += 1; changed = true; }
        if (p.mana < p.int) { p.mana = Math.min(p.int, p.mana + 1); changed = true; }
        if (changed) this.sendYou(p);
      }
    }

    for (const sp of SPAWNERS) {
      if (sp.alive.size < sp.count && t >= (sp.respawnAt || 0)) {
        sp.respawnAt = t + 20_000;
        this.spawnMob(sp);
      }
    }

    this.broadcast({
      t: 'state',
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, x: p.x, y: p.y,
        hp: p.hp, maxhp: maxHp(p), dead: p.dead,
      })),
      mobs: [...this.mobs.values()].map((m) => ({
        id: m.id, kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxhp: m.maxhp,
      })),
    });
  }

  // ---- plumbing -------------------------------------------------------------------

  sendYou(p) {
    this.send(p.ws, {
      t: 'you',
      hp: p.hp, maxhp: maxHp(p), mana: p.mana, maxmana: p.int,
      str: p.str, dex: p.dex, int: p.int,
      skills: p.skills,
      gold: p.gold, logs: p.logs, ore: p.ore,
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
