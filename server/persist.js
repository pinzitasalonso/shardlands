'use strict';

// Persistence: SQLite (better-sqlite3) when the native module is available,
// JSON flat files otherwise. Same interface either way; records and accounts
// are stored as one row per key so saves are atomic and partial.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

let db = null;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'shardlands.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS players (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
} catch {
  db = null; // JSON fallback below
}

function loadTable(table, file) {
  if (db) {
    const out = {};
    for (const row of db.prepare(`SELECT key, data FROM ${table}`).all()) {
      out[row.key] = JSON.parse(row.data);
    }
    // one-time migration from the old JSON files
    if (Object.keys(out).length === 0 && fs.existsSync(file)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
        saveTable(table, file, legacy);
        return legacy;
      } catch { /* fall through */ }
    }
    return out;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveTable(table, file, records) {
  if (db) {
    const upsert = db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data`);
    const tx = db.transaction((recs) => {
      for (const [key, value] of Object.entries(recs)) upsert.run(key, JSON.stringify(value));
    });
    tx(records);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  usingSqlite: () => !!db,
  load: () => loadTable('players', PLAYERS_FILE),
  save: (records) => saveTable('players', PLAYERS_FILE, records),
  loadAccounts: () => loadTable('accounts', ACCOUNTS_FILE),
  saveAccounts: (accounts) => saveTable('accounts', ACCOUNTS_FILE, accounts),
};
