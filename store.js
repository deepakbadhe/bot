'use strict';

/**
 * Tiny zero-dependency record store for scanned Netflix accounts.
 * Persists to records.json so /hold, /update and /done survive across commands.
 *
 * DURABILITY: by default the file lives next to the bot, which on Railway means
 * it resets on every restart/redeploy. Point DATA_DIR at a Railway Volume mount
 * to make the record permanent — no code change needed.
 *
 * Record shape (per account):
 *   { id, email, countryOfSignUp, currentCountry, membershipStatus,
 *     onHold, hold, plan, cookie, link, userGuid, updatedAt }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'records.json');

let state = { nextId: 1, accounts: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.nextId = Number(parsed.nextId) || 1;
      state.accounts = parsed.accounts || {};
    }
  } catch (_) {
    /* no file yet or unreadable → start empty */
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('store save failed:', e.message);
  }
}

load();

// Insert a new account or update an existing one (matched by userGuid), so
// re-scanning the same account refreshes it in place instead of duplicating.
function upsert(acct) {
  let id = null;
  if (acct.userGuid) {
    for (const [k, v] of Object.entries(state.accounts)) {
      if (v.userGuid && v.userGuid === acct.userGuid) { id = k; break; }
    }
  }
  if (id == null) id = String(state.nextId++);
  state.accounts[id] = { ...(state.accounts[id] || {}), ...acct, id };
  save();
  return state.accounts[id];
}

// Update named fields on an existing record by id.
function patch(id, fields) {
  id = String(id);
  if (!state.accounts[id]) return null;
  state.accounts[id] = { ...state.accounts[id], ...fields, id };
  save();
  return state.accounts[id];
}

function all()   { return Object.values(state.accounts); }
function holds() { return all().filter(a => a.onHold); }
function get(id) { return state.accounts[String(id)] || null; }

function remove(id) {
  id = String(id);
  if (!state.accounts[id]) return false;
  delete state.accounts[id];
  save();
  return true;
}

function clear() {
  state = { nextId: state.nextId, accounts: {} };
  save();
}

module.exports = { upsert, patch, all, holds, get, remove, clear, FILE, DATA_DIR };
