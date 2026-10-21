/**
 * Utility helpers untuk formatting angka, tanggal, validasi, dan timezone.
 */

// ─── Warna embed per scope ───────────────────────────────────────────────────
const SCOPE_COLOR = {
    AI:      0x5865F2, // Discord Blurple — untuk ZEINZY AI
    WEDDING: 0xF47FFF, // Soft Pink/Lavender — untuk ZEINZY WEDDING
};

/**
 * Validasi format dan keabsahan tanggal YYYY-MM-DD.
 * @param {string} str
 * @returns {boolean}
 */
function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const d = new Date(str);
    if (isNaN(d.getTime())) return false;
    return d.toISOString().startsWith(str);
}

/**
 * Format integer Rupiah menjadi "Rp1.000.000"
 * @param {number} amount
 * @returns {string}
 */
function formatRupiah(amount) {
    return "Rp" + Number(amount).toLocaleString("id-ID");
}

/**
 * Format tanggal ISO "YYYY-MM-DD" menjadi "19 Oktober 2026" (Bahasa Indonesia).
 * @param {string} isoDate
 * @returns {string}
 */
function formatTanggalReadable(isoDate) {
    if (!isoDate) return "-";
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

/**
 * Mengambil tanggal kalender saat ini dalam timezone Asia/Jakarta (format: YYYY-MM-DD).
 * Menggunakan Node built-in Intl (tanpa external library).
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function getJakartaDateString(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

/**
 * Mengambil jam saat ini (0-23) dalam timezone Asia/Jakarta.
 * @param {Date} [date=new Date()]
 * @returns {number}
 */
function getJakartaHour(date = new Date()) {
    const hourStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Jakarta",
        hour: "numeric",
        hour12: false,
    }).format(date);
    return parseInt(hourStr, 10);
}

/**
 * Menghitung selisih hari kalender antara dua tanggal (nextDueStr - todayJakartaStr).
 * Nilai positif: hari sebelum due date (misal 7 = H-7).
 * 0: tepat hari H (H0).
 * Nilai negatif: hari setelah due date (misal -1 = overdue 1 hari).
 * @param {string} todayJakartaStr - format YYYY-MM-DD
 * @param {string} nextDueStr - format YYYY-MM-DD
 * @returns {number}
 */
function calculateDaysUntilDue(todayJakartaStr, nextDueStr) {
    const [tY, tM, tD] = todayJakartaStr.split("-").map(Number);
    const [dY, dM, dD] = nextDueStr.split("-").map(Number);
    const todayUtc = Date.UTC(tY, tM - 1, tD);
    const dueUtc = Date.UTC(dY, dM - 1, dD);
    return Math.round((dueUtc - todayUtc) / (24 * 60 * 60 * 1000));
}

/**
 * Menentukan tipe reminder berdasarkan selisih hari kalender.
 * Aturan:
 *  7  -> H7
 *  3  -> H3
 *  1  -> H1
 *  0  -> H0
 * <0  -> OVERDUE
 * lainnya -> null (tidak ada reminder)
 * @param {number} daysUntilDue
 * @returns {"H7"|"H3"|"H1"|"H0"|"OVERDUE"|null}
 */
function getReminderType(daysUntilDue) {
    if (daysUntilDue === 7) return "H7";
    if (daysUntilDue === 3) return "H3";
    if (daysUntilDue === 1) return "H1";
    if (daysUntilDue === 0) return "H0";
    if (daysUntilDue < 0) return "OVERDUE";
    return null;
}

module.exports = {
    SCOPE_COLOR,
    isValidDate,
    formatRupiah,
    formatTanggalReadable,
    getJakartaDateString,
    getJakartaHour,
    calculateDaysUntilDue,
    getReminderType,
};
