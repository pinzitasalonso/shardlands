'use strict';

// Flat-file persistence. Characters are saved to data/players.json and
// accounts (email + password hash) to data/accounts.json. Good enough for a
// shard of this size; swap for a real database when the population grows.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  load: () => loadJson(PLAYERS_FILE),
  save: (records) => saveJson(PLAYERS_FILE, records),
  loadAccounts: () => loadJson(ACCOUNTS_FILE),
  saveAccounts: (accounts) => saveJson(ACCOUNTS_FILE, accounts),
};
