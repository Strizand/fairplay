// База данных пользователей, сессий и платежей — встроенный в Node.js SQLite (файл data/app.db).

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    paid_until    TEXT                -- до какого момента оплачен доступ (ISO, UTC); NULL — не оплачен
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,      -- в базе хранится только хеш токена из cookie
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,      -- хеш одноразового токена из письма
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS payments (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    plan_id       TEXT NOT NULL,
    days          INTEGER NOT NULL,
    amount        TEXT NOT NULL,      -- сумма в рублях, строкой "990.00"
    provider      TEXT NOT NULL,      -- yookassa | test | manual
    provider_id   TEXT,
    status        TEXT NOT NULL,      -- pending | succeeded | canceled
    created_at    TEXT NOT NULL,
    paid_at       TEXT,
    period_from   TEXT,               -- какой период оплачен этим платежом
    period_to     TEXT,
    note          TEXT
  );
  CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS payments_provider ON payments(provider, provider_id);

  CREATE TABLE IF NOT EXISTS draws (
    report_id  TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    network    TEXT NOT NULL,
    title      TEXT,
    demo       INTEGER NOT NULL,
    total      INTEGER NOT NULL,
    winners    TEXT NOT NULL          -- JSON: [{id, name}]
  );
  CREATE INDEX IF NOT EXISTS draws_user ON draws(user_id, created_at);
`);

// Транзакция: fn выполняется целиком или не выполняется вовсе
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx };
