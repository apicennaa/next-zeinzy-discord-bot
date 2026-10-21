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

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    ledger_message_id TEXT,
    ledger_posted_at TEXT,
    recurring_series_id INTEGER,
    cycle_status TEXT
  )
`);

// ── Safe migration: schema upgrades & persistent tables ───────────────────────
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

    if (!existingColumns.includes("recurring_series_id")) {
        db.exec("ALTER TABLE expenses ADD COLUMN recurring_series_id INTEGER");
        console.log("✅ [DB Migration] Kolom 'recurring_series_id' berhasil ditambahkan.");
    }

    if (!existingColumns.includes("cycle_status")) {
        db.exec("ALTER TABLE expenses ADD COLUMN cycle_status TEXT");
        console.log("✅ [DB Migration] Kolom 'cycle_status' berhasil ditambahkan.");
    }

    // ── Backfill existing recurring series (idempotent) ───────────────────────
    // Hanya baris dengan is_recurring = 1 dan belum memiliki recurring_series_id
    // yang di-backfill. Founder recurring menggunakan own id sebagai series ID.
    // Expense non-recurring (is_recurring = 0) dibiarkan tetap NULL.
    const backfillResult = db.prepare(`
        UPDATE expenses
        SET recurring_series_id = id,
            cycle_status = 'ACTIVE'
        WHERE is_recurring = 1
          AND recurring_series_id IS NULL
    `).run();

    if (backfillResult.changes > 0) {
        console.log(`✅ [DB Migration] Backfill ${backfillResult.changes} existing recurring row(s) to ACTIVE recurring series.`);
    }

    // ── Partial UNIQUE index: maksimal 1 ACTIVE expense per recurring series ──
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_one_active_per_series
        ON expenses(recurring_series_id)
        WHERE cycle_status = 'ACTIVE';
    `);

    // ── Tabel reminder_log untuk tracking deduplikasi pengingat ───────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS reminder_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            expense_id INTEGER NOT NULL,
            reminder_type TEXT NOT NULL,
            sent_date_jakarta TEXT NOT NULL,
            discord_message_id TEXT,
            sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (expense_id) REFERENCES expenses(id)
        )
    `);

    // ── Unique index: mencegah milestone yang sama dikirim ulang di hari Jakarta yang sama
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_reminder_per_day
        ON reminder_log(expense_id, reminder_type, sent_date_jakarta);
    `);
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