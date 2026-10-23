const { EmbedBuilder } = require("discord.js");
const db = require("../database/db");
const {
    formatRupiah,
    getJakartaDateString,
} = require("../utils/formatters");

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Validasi format input bulan YYYY-MM (01 s/d 12).
 * @param {string} str
 * @returns {boolean}
 */
function isValidMonth(str) {
    if (typeof str !== "string") return false;
    return MONTH_REGEX.test(str.trim());
}

/**
 * Mendapatkan bulan berjalan (YYYY-MM) berdasarkan timezone Asia/Jakarta.
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function getDefaultMonth(date = new Date()) {
    return getJakartaDateString(date).slice(0, 7);
}

/**
 * Format string YYYY-MM menjadi nama bulan yang mudah dibaca dalam Bahasa Indonesia.
 * Contoh: "2026-10" -> "Oktober 2026"
 * @param {string} monthStr
 * @returns {string}
 */
function formatMonthReadable(monthStr) {
    const [year, month] = monthStr.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, 1));
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        month: "long",
        year: "numeric",
    }).format(date);
}

/**
 * Menghitung tanggal kalender di masa depan berdasarkan Asia/Jakarta (YYYY-MM-DD).
 * @param {number} daysAhead
 * @param {string} [baseDateStr=getJakartaDateString()]
 * @returns {string}
 */
function getFutureJakartaDate(daysAhead, baseDateStr = getJakartaDateString()) {
    const [y, m, d] = baseDateStr.split("-").map(Number);
    const targetUtc = Date.UTC(y, m - 1, d + daysAhead);
    const dt = new Date(targetUtc);
    const yStr = dt.getUTCFullYear();
    const mStr = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dStr = String(dt.getUTCDate()).padStart(2, "0");
    return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Mengambil ringkasan pengeluaran bulanan (100% READ-ONLY).
 *
 * @param {string} targetMonth - format YYYY-MM
 * @param {object} [options]
 * @param {import("better-sqlite3").Database} [options.dbInstance]
 * @param {string} [options.todayJakartaStr]
 * @returns {{
 *   month: string,
 *   monthReadable: string,
 *   totalAmount: number,
 *   txCount: number,
 *   aiAmount: number,
 *   weddingAmount: number,
 *   activeRecurringCount: number,
 *   upcomingCount: number,
 *   upcomingAmount: number,
 *   largestExpense: { name: string, amount: number, paid_at: string, id: number } | null
 * }}
 */
function getFinanceSummary(targetMonth, options = {}) {
    const activeDb = options.dbInstance || db;
    const todayJakarta = options.todayJakartaStr || getJakartaDateString();
    const maxUpcomingDate = getFutureJakartaDate(30, todayJakarta);

    // 1. Total pengeluaran & jumlah transaksi bulan yang dipilih (berdasarkan paid_at)
    const totalRow = activeDb.prepare(`
        SELECT
            COUNT(*) as tx_count,
            COALESCE(SUM(amount), 0) as total_amount
        FROM expenses
        WHERE substr(paid_at, 1, 7) = ?
    `).get(targetMonth);

    const txCount = totalRow?.tx_count ?? 0;
    const totalAmount = totalRow?.total_amount ?? 0;

    // 2. Breakdown per scope (AI & WEDDING)
    const scopeRows = activeDb.prepare(`
        SELECT
            scope,
            COALESCE(SUM(amount), 0) as scope_amount
        FROM expenses
        WHERE substr(paid_at, 1, 7) = ?
        GROUP BY scope
    `).all(targetMonth);

    let aiAmount = 0;
    let weddingAmount = 0;
    for (const row of scopeRows) {
        if (row.scope === "AI") {
            aiAmount = row.scope_amount;
        } else if (row.scope === "WEDDING") {
            weddingAmount = row.scope_amount;
        }
    }

    // 3. Recurring Aktif SAAT INI (seluruh kondisi bot saat ini, tidak dibatasi bulan summary)
    const recurringRow = activeDb.prepare(`
        SELECT COUNT(*) as active_recurring_count
        FROM expenses
        WHERE is_recurring = 1
          AND cycle_status = 'ACTIVE'
    `).get();
    const activeRecurringCount = recurringRow?.active_recurring_count ?? 0;

    // 4. Upcoming 30 Hari (recurring aktif dengan next_due_at dalam rentang [today..today+30])
    const upcomingRow = activeDb.prepare(`
        SELECT
            COUNT(*) as upcoming_count,
            COALESCE(SUM(amount), 0) as upcoming_amount
        FROM expenses
        WHERE is_recurring = 1
          AND cycle_status = 'ACTIVE'
          AND next_due_at IS NOT NULL
          AND next_due_at >= ?
          AND next_due_at <= ?
    `).get(todayJakarta, maxUpcomingDate);

    const upcomingCount = upcomingRow?.upcoming_count ?? 0;
    const upcomingAmount = upcomingRow?.upcoming_amount ?? 0;

    // 5. Expense terbesar bulan ini (deterministic tie-break: amount DESC, paid_at DESC, id DESC)
    const largestExpense = activeDb.prepare(`
        SELECT id, name, amount, paid_at
        FROM expenses
        WHERE substr(paid_at, 1, 7) = ?
        ORDER BY amount DESC, paid_at DESC, id DESC
        LIMIT 1
    `).get(targetMonth) || null;

    return {
        month: targetMonth,
        monthReadable: formatMonthReadable(targetMonth),
        totalAmount,
        txCount,
        aiAmount,
        weddingAmount,
        activeRecurringCount,
        upcomingCount,
        upcomingAmount,
        largestExpense,
    };
}

/**
 * Membangun Discord embed clean untuk finance summary.
 * @param {ReturnType<typeof getFinanceSummary>} summary
 * @returns {EmbedBuilder}
 */
function buildSummaryEmbed(summary) {
    const largestText = summary.largestExpense
        ? `**${summary.largestExpense.name}**\n${formatRupiah(summary.largestExpense.amount)}`
        : "Belum ada pengeluaran tercatat.";

    return new EmbedBuilder()
        .setColor(0x5865F2) // Discord Blurple
        .setTitle(`💰 Expense Summary — ${summary.monthReadable}`)
        .addFields(
            {
                name: "TOTAL PENGELUARAN",
                value: `**${formatRupiah(summary.totalAmount)}**`,
                inline: false,
            },
            {
                name: "🤖 ZEINZY AI",
                value: formatRupiah(summary.aiAmount),
                inline: true,
            },
            {
                name: "💒 ZEINZY WEDDING",
                value: formatRupiah(summary.weddingAmount),
                inline: true,
            },
            {
                name: "TRANSAKSI",
                value: `${summary.txCount} pembayaran tercatat`,
                inline: true,
            },
            {
                name: "RECURRING AKTIF",
                value: `${summary.activeRecurringCount} recurring expense aktif`,
                inline: true,
            },
            {
                name: "UPCOMING 30 HARI",
                value: `${summary.upcomingCount} pembayaran\nEstimasi ${formatRupiah(summary.upcomingAmount)}`,
                inline: true,
            },
            {
                name: "EXPENSE TERBESAR BULAN INI",
                value: largestText,
                inline: false,
            }
        )
        .setFooter({ text: "ZEINZY Bot • Finance Summary • Basis paid_at • Asia/Jakarta" })
        .setTimestamp();
}

module.exports = {
    isValidMonth,
    getDefaultMonth,
    formatMonthReadable,
    getFutureJakartaDate,
    getFinanceSummary,
    buildSummaryEmbed,
};
