const { EmbedBuilder } = require("discord.js");
const db = require("../database/db");
const {
    SCOPE_COLOR,
    formatRupiah,
    formatTanggalReadable,
    getJakartaDateString,
    getJakartaHour,
    calculateDaysUntilDue,
    getReminderType,
} = require("../utils/formatters");

// ─── Prepared Statements ─────────────────────────────────────────────────────

const getActiveRecurringExpenses = db.prepare(`
    SELECT
        id,
        name,
        amount,
        paid_at,
        scope,
        is_recurring,
        next_due_at,
        recurring_series_id,
        cycle_status
    FROM expenses
    WHERE
        is_recurring = 1
        AND cycle_status = 'ACTIVE'
        AND next_due_at IS NOT NULL
    ORDER BY id ASC
`);

const checkReminderSentToday = db.prepare(`
    SELECT 1 FROM reminder_log
    WHERE
        expense_id = ?
        AND reminder_type = ?
        AND sent_date_jakarta = ?
`);

const insertReminderLog = db.prepare(`
    INSERT OR IGNORE INTO reminder_log (
        expense_id,
        reminder_type,
        sent_date_jakarta,
        discord_message_id,
        sent_at
    ) VALUES (
        @expense_id,
        @reminder_type,
        @sent_date_jakarta,
        @discord_message_id,
        @sent_at
    )
`);

const getExpenseStatusById = db.prepare(`
    SELECT is_recurring, cycle_status FROM expenses WHERE id = ?
`);

// ─── Embed Builder untuk Reminder ────────────────────────────────────────────

/**
 * Membangun embed Discord untuk pengingat recurring expense.
 * @param {object} expense
 * @param {string} reminderType - "H7"|"H3"|"H1"|"H0"|"OVERDUE"
 * @param {number} daysUntilDue
 * @returns {EmbedBuilder}
 */
function buildReminderEmbed(expense, reminderType, daysUntilDue) {
    const scopeLabel = expense.scope === "AI" ? "🤖 ZEINZY AI" : "💍 ZEINZY WEDDING";
    let statusText = "";
    let embedColor = SCOPE_COLOR[expense.scope] ?? 0x5865F2;

    switch (reminderType) {
        case "H7":
            statusText = "⏰ Jatuh tempo dalam **7 hari** (H-7)";
            break;
        case "H3":
            statusText = "⏰ Jatuh tempo dalam **3 hari** (H-3)";
            break;
        case "H1":
            statusText = "⚠️ Jatuh tempo **BESOK** (H-1)";
            embedColor = 0xFEE75C; // Warning Yellow
            break;
        case "H0":
            statusText = "🚨 **JATUH TEMPO HARI INI** (Hari H)";
            embedColor = 0xED4245; // Danger Red
            break;
        case "OVERDUE": {
            const overdueDays = Math.abs(daysUntilDue);
            statusText = `🔴 **MELEWATI JATUH TEMPO (${overdueDays} hari)**`;
            embedColor = 0xED4245; // Danger Red
            break;
        }
        default:
            statusText = "-";
    }

    return new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(`🔔 Pengingat Tagihan: ${expense.name}`)
        .setDescription(`Pengingat pembayaran untuk pengeluaran recurring berikut:`)
        .addFields(
            { name: "Tagihan",          value: expense.name,                                            inline: true },
            { name: "Scope",            value: scopeLabel,                                              inline: true },
            { name: "Nominal Terakhir", value: formatRupiah(expense.amount),                            inline: true },
            { name: "Jatuh Tempo",      value: `${formatTanggalReadable(expense.next_due_at)} (\`${expense.next_due_at}\`)`, inline: true },
            { name: "Status",           value: statusText,                                              inline: true },
            { name: "Siklus Aktif",     value: `Expense ID **#${expense.id}** (Series #${expense.recurring_series_id})`, inline: true },
            { name: "Cara Perbarui",    value: `Setelah dibayar, perbarui dengan command:\n\`/expense mark-paid id:${expense.id}\``, inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `ZEINZY Bot • Recurring Reminder • ${reminderType}` });
}

// ─── Core Reminder Processing ────────────────────────────────────────────────

/**
 * Memeriksa seluruh expense recurring aktif dan mengirim reminder yang memenuhi syarat.
 * Menggunakan policy: send-before-log
 *
 * ⚠️ LIMITASI SINGLE-INSTANCE (ACCEPTED UNTUK MVP):
 * Jika bot crash tepat setelah Discord .send() berhasil tetapi sebelum
 * insertReminderLog selesai, reminder dapat terkirim ulang saat bot restart.
 *
 * @param {import("discord.js").Client} client
 */
async function checkAndSendReminders(client) {
    const channelId = process.env.FINANCE_CHANNEL_ID;

    // 1. Validasi env FINANCE_CHANNEL_ID
    if (!channelId) {
        console.warn("⚠️ [Reminder Scheduler] FINANCE_CHANNEL_ID belum dikonfigurasi di .env. Reminder scheduler dilewati.");
        return;
    }

    // 2. Cek jam target (>= 09:00 Asia/Jakarta)
    const currentHourJakarta = getJakartaHour();
    if (currentHourJakarta < 9) {
        // Belum jam 09:00 WIB — lewati check
        return;
    }

    // 3. Fetch channel Discord
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error(`❌ [Reminder Scheduler] Gagal fetch channel ${channelId}:`, err);
        return;
    }

    if (!channel || !channel.isTextBased()) {
        console.error(`❌ [Reminder Scheduler] Channel ${channelId} tidak valid atau bukan text channel.`);
        return;
    }

    // 4. Tanggal kalender Jakarta hari ini
    const todayJakarta = getJakartaDateString();

    // 5. Query semua active recurring expenses
    let activeExpenses;
    try {
        activeExpenses = getActiveRecurringExpenses.all();
    } catch (dbErr) {
        console.error("❌ [Reminder Scheduler] Gagal query expenses dari database:", dbErr);
        return;
    }

    if (!activeExpenses || activeExpenses.length === 0) {
        return;
    }

    for (const expense of activeExpenses) {
        // Hitung selisih hari kalender
        const daysUntilDue = calculateDaysUntilDue(todayJakarta, expense.next_due_at);
        const reminderType = getReminderType(daysUntilDue);

        // Jika bukan milestone yang dijadwalkan (H7, H3, H1, H0, OVERDUE), lewati
        if (!reminderType) {
            continue;
        }

        // Cek apakah milestone ini sudah terkirim hari ini di Jakarta
        const alreadySent = checkReminderSentToday.get(expense.id, reminderType, todayJakarta);
        if (alreadySent) {
            // Sudah terkirim hari ini — skip
            continue;
        }

        // Re-read status expense tepat sebelum send untuk memastikan belum dimark-paid di thread lain
        const currentStatus = getExpenseStatusById.get(expense.id);
        if (!currentStatus || currentStatus.cycle_status !== "ACTIVE" || currentStatus.is_recurring !== 1) {
            console.log(`ℹ️ [Reminder Scheduler] Expense #${expense.id} sudah bukan ACTIVE recurring cycle saat akan dikirim. Dilewati.`);
            continue;
        }

        // Bangun embed
        const embed = buildReminderEmbed(expense, reminderType, daysUntilDue);

        // Send-before-log: kirim ke Discord terlebih dahulu
        let sentMessage;
        try {
            sentMessage = await channel.send({ embeds: [embed] });
        } catch (sendErr) {
            console.error(`❌ [Reminder Scheduler] Gagal mengirim reminder expense #${expense.id} (${reminderType}):`, sendErr);
            // Gagal kirim -> JANGAN catat ke reminder_log agar interval berikutnya dapat mencoba kembali
            continue;
        }

        // Jika send berhasil -> catat ke reminder_log
        try {
            insertReminderLog.run({
                expense_id:         expense.id,
                reminder_type:      reminderType,
                sent_date_jakarta:  todayJakarta,
                discord_message_id: sentMessage?.id ?? null,
                sent_at:            new Date().toISOString(),
            });
            console.log(`✅ [Reminder Scheduler] Reminder expense #${expense.id} (${reminderType}) berhasil dikirim ke <#${channelId}>.`);
        } catch (logErr) {
            // Discord message sudah terkirim. Log warning jika DB insert gagal.
            console.error(`⚠️ [Reminder Scheduler] Reminder expense #${expense.id} terkirim tapi gagal simpan reminder_log:`, logErr);
        }
    }
}

// ─── Scheduler Initialization ────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 menit

/**
 * Menjalankan interval scheduler pengingat.
 * Dipanggil sekali saat client Discord ready.
 * @param {import("discord.js").Client} client
 */
function startReminderScheduler(client) {
    const channelId = process.env.FINANCE_CHANNEL_ID;
    if (!channelId) {
        console.warn("⚠️ [Reminder Scheduler] FINANCE_CHANNEL_ID belum dikonfigurasi di .env. Reminder scheduler dilewati.");
        return;
    }

    console.log("⏰ [Reminder Scheduler] Memulai scheduler pengingat recurring (interval: 15 menit, target: >= 09:00 WIB).");

    // Jalankan satu kali segera setelah startup
    checkAndSendReminders(client).catch(err => {
        console.error("❌ [Reminder Scheduler] Error pada pengecekan awal reminder:", err);
    });

    // Jalankan periodik setiap 15 menit
    setInterval(() => {
        checkAndSendReminders(client).catch(err => {
            console.error("❌ [Reminder Scheduler] Error pada pengecekan periodik reminder:", err);
        });
    }, CHECK_INTERVAL_MS);
}

module.exports = {
    startReminderScheduler,
    checkAndSendReminders,
    buildReminderEmbed,
};
