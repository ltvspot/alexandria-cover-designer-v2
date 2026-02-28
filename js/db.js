// db.js — In-memory storage for Alexandria Cover Designer v2
// Works in sandboxed iframes where persistent storage APIs are unavailable

const _stores = {
  books: {},
  jobs: {},
  winners: {},
  prompts: {},
  settings: {},
  cost_ledger: {},
  batches: {},
};

const _counters = {};

// Store configs — which field is the keyPath, and which auto-increment
const STORE_CONFIG = {
  books:       { keyPath: 'id', autoIncrement: false },
  jobs:        { keyPath: 'id', autoIncrement: false },
  winners:     { keyPath: 'book_id', autoIncrement: false },
  prompts:     { keyPath: 'id', autoIncrement: true },
  settings:    { keyPath: 'key', autoIncrement: false },
  cost_ledger: { keyPath: 'id', autoIncrement: true },
  batches:     { keyPath: 'id', autoIncrement: false },
};

function _nextId(storeName) {
  _counters[storeName] = (_counters[storeName] || 0) + 1;
  return _counters[storeName];
}

// Generic CRUD — same interface as the IndexedDB version
async function dbPut(storeName, item) {
  const config = STORE_CONFIG[storeName] || { keyPath: 'id', autoIncrement: false };
  if (!_stores[storeName]) _stores[storeName] = {};

  // Handle auto-increment
  if (config.autoIncrement && (item[config.keyPath] === undefined || item[config.keyPath] === null)) {
    item[config.keyPath] = _nextId(storeName);
  }

  const key = String(item[config.keyPath]);
  _stores[storeName][key] = item;
  return item[config.keyPath];
}

async function dbGet(storeName, key) {
  if (!_stores[storeName]) return undefined;
  return _stores[storeName][String(key)] || undefined;
}

async function dbGetAll(storeName) {
  if (!_stores[storeName]) return [];
  return Object.values(_stores[storeName]);
}

async function dbDelete(storeName, key) {
  if (_stores[storeName]) {
    delete _stores[storeName][String(key)];
  }
}

async function dbClear(storeName) {
  _stores[storeName] = {};
}

async function dbGetByIndex(storeName, indexName, value) {
  const all = Object.values(_stores[storeName] || {});
  return all.filter(item => item[indexName] === value);
}

async function dbCount(storeName) {
  return Object.keys(_stores[storeName] || {}).length;
}

// Settings helpers
async function getSetting(key, defaultValue = null) {
  const row = await dbGet('settings', key);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  return dbPut('settings', { key, value });
}

// Initialize default settings (API keys pre-embedded)
async function initDefaults() {
  const defaults = {
    openrouter_key: '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',
    google_api_key: 'AIzaSyAY6XvPxrdS_fMNMZEUkJd7UW9b9yuJDgI',
    drive_source_folder: '1ybFYDJk7Y3VlbsEjRAh1LOfdyVsHM_cS',
    drive_output_folder: '1Vr184ZsX3k38xpmZkd8g2vwB5y9LYMRC',
    drive_winner_folder: '1vOGdGjryzErrzB0kT3qmu3PJrRLOoqBg',
    budget_limit: 50,
    default_variant_count: 1,
    quality_threshold: 0.6,
    medallion_cx: 2850,
    medallion_cy: 1350,
    medallion_radius: 520,
  };
  for (const [k, v] of Object.entries(defaults)) {
    const existing = await getSetting(k);
    if (existing === null || existing === undefined) {
      await setSetting(k, v);
    }
  }
}

// No-op for compatibility
async function openDB() {
  return true;
}

// Export globally
window.DB = {
  openDB, dbPut, dbGet, dbGetAll, dbDelete, dbClear, dbGetByIndex, dbCount,
  getSetting, setSetting, initDefaults
};