const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "../data/zeinzy.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

// ── Create table (idempotent) ─────────────────────────────────────────────────
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

// ── Safe migration: tambah kolom ledger tracking jika belum ada ───────────────
// Menggunakan PRAGMA table_info() untuk cek keberadaan kolom sebelum ALTER.
// Restart bot berkali-kali aman — ALTER hanya dijalankan jika kolom belum ada.
(function runMigrations() {
    const existingColumns = db
        .prepare("PRAGMA table_info(expenses)")
        .all()
        .map(col => col.name);

    if (!existingColumns.includes("ledger_message_id")) {
        db.exec("ALTER TABLE expenses ADD COLUMN ledger_message_id TEXT");
        console.log("✅ [DB Migration] Kolom 'ledger_message_id' berhasil ditambahkan.");
    }

    if (!existingColumns.includes("ledger_posted_at")) {
        db.exec("ALTER TABLE expenses ADD COLUMN ledger_posted_at TEXT");
        console.log("✅ [DB Migration] Kolom 'ledger_posted_at' berhasil ditambahkan.");
    }
})();

// ── Startup stale-lock cleanup ────────────────────────────────────────────────
// 'PENDING' adalah transient lock yang diset oleh /expense repost sesaat
// sebelum Discord .send() dipanggil. Jika bot/VPS crash di tengah proses
// (setelah PENDING tersimpan tetapi sebelum .send() selesai atau sebelum
// PENDING diganti dengan real Discord message ID), PENDING akan tertinggal
// di database secara permanen karena rollback inline tidak sempat berjalan.
//
// Cleanup ini me-reset semua PENDING → NULL setiap kali bot start, sehingga
// expense yang sebelumnya crash menjadi recoverable via /expense repost.
//
// ⚠️  ASUMSI SINGLE-INSTANCE: Mekanisme ini HANYA aman jika ZEINZY Bot
// berjalan sebagai satu process tunggal. Jika bot dijalankan dalam beberapa
// process/container secara bersamaan, instance yang baru start TIDAK boleh
// membersihkan lock milik instance lain yang masih aktif. Dalam kondisi
// multi-instance, desain ini harus diganti dengan distributed locking atau
// time-based expiry. Jangan aktifkan multi-instance tanpa redesign terlebih
// dahulu.
(function cleanupStalePending() {
    const result = db.prepare(`
        UPDATE expenses
        SET ledger_message_id = NULL,
            ledger_posted_at  = NULL
        WHERE ledger_message_id = 'PENDING'
    `).run();

    if (result.changes > 0) {
        console.warn(
            `⚠️  [DB Startup] ${result.changes} stale PENDING lock(s) ditemukan dan di-reset ke NULL. ` +
            `Expense tersebut sekarang recoverable via /expense repost.`
        );
    }
})();

module.exports = db;