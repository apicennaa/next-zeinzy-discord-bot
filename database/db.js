const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "../data/zeinzy.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    paid_at TEXT NOT NULL,

    scope TEXT NOT NULL
      CHECK (scope IN ('AI', 'WEDDING')),

    is_recurring INTEGER NOT NULL DEFAULT 0,

    next_due_at TEXT,

    payment_proof_url TEXT NOT NULL,

    notes TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;