const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const db = require("../database/db");
const {
    isValidDate,
    formatRupiah,
    formatTanggalReadable,
    SCOPE_COLOR,
} = require("../utils/formatters");

// ─── Prepared statements ─────────────────────────────────────────────────────

const insertExpense = db.prepare(`
    INSERT INTO expenses
        (name, amount, paid_at, scope, is_recurring, next_due_at, payment_proof_url, notes, recurring_series_id, cycle_status)
    VALUES
        (@name, @amount, @paid_at, @scope, @is_recurring, @next_due_at, @payment_proof_url, @notes, @recurring_series_id, @cycle_status)
`);

/**
 * Transaksi pembuatan expense baru:
 * Jika is_recurring = 1, recurring_series_id langsung diisi dengan own id.
 * Jika is_recurring = 0, recurring_series_id dan cycle_status tetap NULL.
 */
const createExpenseTx = db.transaction(params => {
    const result = insertExpense.run(params);
    const newId = result.lastInsertRowid;
    if (params.is_recurring === 1) {
        db.prepare(`
            UPDATE expenses
            SET recurring_series_id = id
            WHERE id = ?
        `).run(newId);
    }
    return newId;
});

const getExpenseById = db.prepare(`
    SELECT * FROM expenses WHERE id = ?
`);

/**
 * Update ledger tracking setelah Discord post berhasil.
 * Menggunakan conditional UPDATE (WHERE ledger_message_id IS NULL) sebagai
 * proteksi race-condition minimal di level SQLite.
 */
const updateLedgerTracking = db.prepare(`
    UPDATE expenses
    SET
        ledger_message_id = @messageId,
        ledger_posted_at  = @postedAt
    WHERE
        id = @expenseId
        AND ledger_message_id IS NULL
`);

/**
 * Transaksi Mark Paid:
 * 1. Re-read source expense di dalam transaksi
 * 2. Validasi status masih ACTIVE, is_recurring = 1, dan memiliki recurring_series_id
 * 3. UPDATE source: ACTIVE -> SUPERSEDED secara kondisional (WHERE cycle_status = 'ACTIVE')
 * 4. Pastikan changes === 1 (proteksi concurrent mark-paid)
 * 5. INSERT new cycle:
 *    - name & scope diwariskan dari source
 *    - nominal & tanggal dari input aktual
 *    - is_recurring = 1, cycle_status = 'ACTIVE'
 *    - next_due_at dari input
 *    - recurring_series_id = source.recurring_series_id
 *    - ledger tracking = NULL (dipost setelah transaksi commit)
 * 6. Return { source, newExpenseId }
 */
const markPaidTransaction = db.transaction((sourceId, inputData) => {
    const source = db.prepare("SELECT * FROM expenses WHERE id = ?").get(sourceId);

    if (!source) {
        throw new Error("EXPENSE_NOT_FOUND");
    }
    if (source.is_recurring !== 1) {
        throw new Error("NOT_RECURRING");
    }
    if (source.cycle_status !== "ACTIVE") {
        throw new Error("NOT_ACTIVE");
    }
    if (!source.recurring_series_id) {
        throw new Error("NO_SERIES_ID");
    }

    const updateResult = db.prepare(`
        UPDATE expenses
        SET cycle_status = 'SUPERSEDED'
        WHERE id = ? AND cycle_status = 'ACTIVE'
    `).run(sourceId);

    if (updateResult.changes !== 1) {
        throw new Error("CONCURRENT_CONFLICT");
    }

    const insertResult = db.prepare(`
        INSERT INTO expenses (
            name,
            amount,
            paid_at,
            scope,
            is_recurring,
            next_due_at,
            payment_proof_url,
            notes,
            recurring_series_id,
            cycle_status,
            ledger_message_id,
            ledger_posted_at
        ) VALUES (
            @name,
            @amount,
            @paid_at,
            @scope,
            1,
            @next_due_at,
            @payment_proof_url,
            @notes,
            @recurring_series_id,
            'ACTIVE',
            NULL,
            NULL
        )
    `).run({
        name: source.name,
        amount: inputData.amount,
        paid_at: inputData.paid_at,
        scope: source.scope,
        next_due_at: inputData.next_due_at,
        payment_proof_url: inputData.payment_proof_url,
        notes: inputData.notes,
        recurring_series_id: source.recurring_series_id,
    });

    return {
        source,
        newExpenseId: insertResult.lastInsertRowid,
    };
});

// ─── Shared ledger builder ───────────────────────────────────────────────────
/**
 * Membangun EmbedBuilder dari baris expense di database.
 * @param {object} row - Baris dari tabel expenses
 * @param {string|null} posterUserId - Discord user ID atau null
 * @returns {{ embed: EmbedBuilder, isImage: boolean }}
 */
function buildLedgerEmbed(row, posterUserId) {
    const scopeLabel   = row.scope === "AI" ? "🤖 ZEINZY AI" : "💍 ZEINZY WEDDING";
    const recurringStr = row.is_recurring === 1 ? "Ya" : "Tidak";
    const nextDueLabel = row.next_due_at ? formatTanggalReadable(row.next_due_at) : "-";
    const catatanLabel = row.notes ?? "-";
    const dicatatOleh  = posterUserId ? `<@${posterUserId}>` : "-";

    const imageExts = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;
    const isImage   = imageExts.test(row.payment_proof_url);

    const embed = new EmbedBuilder()
        .setColor(SCOPE_COLOR[row.scope] ?? 0x95A5A6)
        .setTitle(`💰 Expense #${row.id} — ${row.name}`)
        .addFields(
            { name: "Nominal",       value: formatRupiah(row.amount),                inline: false },
            { name: "Scope",         value: scopeLabel,                              inline: false },
            { name: "Tanggal Bayar", value: formatTanggalReadable(row.paid_at),      inline: true  },
            { name: "Recurring",     value: recurringStr,                            inline: true  },
            { name: "Next Due",      value: nextDueLabel,                            inline: true  },
            { name: "Catatan",       value: catatanLabel,                            inline: false },
            { name: "Dicatat oleh",  value: dicatatOleh,                            inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `ZEINZY Bot • Expense ID #${row.id}` });

    if (isImage) {
        embed.setImage(row.payment_proof_url);
    }

    return { embed, isImage };
}

// ─── Shared channel poster ───────────────────────────────────────────────────
/**
 * Fetch channel dari EXPENSE_CHANNEL_ID, validasi, lalu kirim embed.
 * @param {import("discord.js").Client} client
 * @param {EmbedBuilder} embed
 * @param {boolean} isImage
 * @param {string} proofUrl
 * @param {string} context
 * @returns {Promise<{ ok: boolean, channelId: string|null, message?: import("discord.js").Message, errorMessage?: string }>}
 */
async function postLedgerToChannel(client, embed, isImage, proofUrl, context) {
    const channelId = process.env.EXPENSE_CHANNEL_ID;

    if (!channelId) {
        console.error(`❌ [${context}] EXPENSE_CHANNEL_ID belum diset di .env`);
        return {
            ok: false,
            channelId: null,
            errorMessage: "`EXPENSE_CHANNEL_ID` belum dikonfigurasi. Hubungi admin.",
        };
    }

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error(`❌ [${context}] Gagal fetch channel ${channelId}:`, err);
        return {
            ok: false,
            channelId,
            errorMessage: `Gagal menemukan channel expenses (ID: \`${channelId}\`).`,
        };
    }

    if (!channel || !channel.isTextBased()) {
        console.error(`❌ [${context}] Channel ${channelId} tidak valid atau bukan text channel`);
        return {
            ok: false,
            channelId,
            errorMessage: `Channel expenses tidak valid atau bukan text channel (ID: \`${channelId}\`).`,
        };
    }

    let sentMessage;
    try {
        const payload = { embeds: [embed] };
        if (!isImage) {
            payload.content = `📎 **Bukti pembayaran:** ${proofUrl}`;
        }
        sentMessage = await channel.send(payload);
    } catch (err) {
        console.error(`❌ [${context}] Gagal send ke channel ${channelId}:`, err);
        return {
            ok: false,
            channelId,
            errorMessage: `Gagal mengirim pesan ke <#${channelId}>.`,
        };
    }

    return { ok: true, channelId, message: sentMessage };
}

// ─── Command definition ──────────────────────────────────────────────────────
module.exports = {
    data: new SlashCommandBuilder()
        .setName("expense")
        .setDescription("Kelola expense ZEINZY")

        // ── Subcommand: add ──────────────────────────────────────────────────
        .addSubcommand(subcommand =>
            subcommand
                .setName("add")
                .setDescription("Catat expense baru")
                .addStringOption(option =>
                    option
                        .setName("nama")
                        .setDescription("Nama expense (contoh: VPS Biznet)")
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option
                        .setName("nominal")
                        .setDescription("Nominal dalam Rupiah (angka bulat, min 1)")
                        .setRequired(true)
                        .setMinValue(1)
                )
                .addStringOption(option =>
                    option
                        .setName("scope")
                        .setDescription("Expense untuk bagian mana?")
                        .setRequired(true)
                        .addChoices(
                            { name: "🤖 ZEINZY AI", value: "AI" },
                            { name: "💍 ZEINZY WEDDING", value: "WEDDING" }
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("tanggal")
                        .setDescription("Tanggal pembayaran (format: YYYY-MM-DD, contoh: 2026-10-19)")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("recurring")
                        .setDescription("Apakah ini expense berulang?")
                        .setRequired(true)
                        .addChoices(
                            { name: "Ya", value: "Ya" },
                            { name: "Tidak", value: "Tidak" }
                        )
                )
                .addAttachmentOption(option =>
                    option
                        .setName("bukti")
                        .setDescription("Bukti pembayaran (screenshot/foto)")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("next_due")
                        .setDescription("Tanggal jatuh tempo berikutnya (WAJIB jika Recurring: Ya, format: YYYY-MM-DD)")
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName("catatan")
                        .setDescription("Catatan tambahan (opsional)")
                        .setRequired(false)
                )
        )

        // ── Subcommand: repost ───────────────────────────────────────────────
        .addSubcommand(subcommand =>
            subcommand
                .setName("repost")
                .setDescription("Post ulang ledger expense yang sudah ada di database (tanpa membuat expense baru)")
                .addIntegerOption(option =>
                    option
                        .setName("id")
                        .setDescription("ID expense yang ingin dipost ulang (contoh: 4)")
                        .setRequired(true)
                        .setMinValue(1)
                )
        )

        // ── Subcommand: mark-paid ────────────────────────────────────────────
        .addSubcommand(subcommand =>
            subcommand
                .setName("mark-paid")
                .setDescription("Tandai pembayaran tagihan recurring dan mulai siklus jatuh tempo baru")
                .addIntegerOption(option =>
                    option
                        .setName("id")
                        .setDescription("ID expense dari siklus aktif yang ingin ditandai lunas (contoh: 2)")
                        .setRequired(true)
                        .setMinValue(1)
                )
                .addIntegerOption(option =>
                    option
                        .setName("nominal")
                        .setDescription("Nominal pembayaran aktual dalam Rupiah (min 1)")
                        .setRequired(true)
                        .setMinValue(1)
                )
                .addStringOption(option =>
                    option
                        .setName("tanggal")
                        .setDescription("Tanggal pembayaran aktual (format: YYYY-MM-DD, contoh: 2026-11-19)")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("next_due")
                        .setDescription("Tanggal jatuh tempo berikutnya (format: YYYY-MM-DD, harus > tanggal bayar)")
                        .setRequired(true)
                )
                .addAttachmentOption(option =>
                    option
                        .setName("bukti")
                        .setDescription("Bukti pembayaran baru (screenshot/foto)")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("catatan")
                        .setDescription("Catatan tambahan untuk siklus baru ini (opsional)")
                        .setRequired(false)
                )
        ),

    // ─── Execute ─────────────────────────────────────────────────────────────
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === "add")       return handleAdd(interaction);
        if (sub === "repost")    return handleRepost(interaction);
        if (sub === "mark-paid") return handleMarkPaid(interaction);

        return interaction.reply({
            content: "⚠️ Subcommand tidak dikenal.",
            ephemeral: true,
        });
    },
};

// ─── Handler: /expense add ───────────────────────────────────────────────────
async function handleAdd(interaction) {
    const nama      = interaction.options.getString("nama").trim();
    const nominal   = interaction.options.getInteger("nominal");
    const scope     = interaction.options.getString("scope");
    const tanggal   = interaction.options.getString("tanggal").trim();
    const recurring = interaction.options.getString("recurring");
    const bukti     = interaction.options.getAttachment("bukti");
    const nextDue   = interaction.options.getString("next_due")?.trim() ?? null;
    const catatan   = interaction.options.getString("catatan")?.trim() ?? null;

    // ── Validasi ───────────────────────────────────────────────────────────
    if (nominal <= 0) {
        return interaction.reply({
            content: "❌ **Nominal tidak valid.** Harus lebih dari 0.",
            ephemeral: true,
        });
    }

    if (!["AI", "WEDDING"].includes(scope)) {
        return interaction.reply({
            content: "❌ **Scope tidak valid.** Pilih antara `AI` atau `WEDDING`.",
            ephemeral: true,
        });
    }

    if (!isValidDate(tanggal)) {
        return interaction.reply({
            content: `❌ **Format tanggal tidak valid:** \`${tanggal}\`\nGunakan format \`YYYY-MM-DD\` dengan tanggal yang benar, contoh: \`2026-10-19\`.`,
            ephemeral: true,
        });
    }

    if (recurring === "Ya") {
        if (!nextDue) {
            return interaction.reply({
                content: "❌ **`next_due` wajib diisi** saat Recurring dipilih **Ya**.\nMasukkan tanggal jatuh tempo berikutnya dengan format `YYYY-MM-DD`.",
                ephemeral: true,
            });
        }
        if (!isValidDate(nextDue)) {
            return interaction.reply({
                content: `❌ **Format \`next_due\` tidak valid:** \`${nextDue}\`\nGunakan format \`YYYY-MM-DD\` dengan tanggal yang benar.`,
                ephemeral: true,
            });
        }
        if (nextDue <= tanggal) {
            return interaction.reply({
                content: `❌ **\`next_due\` (${nextDue}) harus lebih besar dari tanggal pembayaran (${tanggal}).**`,
                ephemeral: true,
            });
        }
    }

    // ── Siapkan data untuk INSERT ──────────────────────────────────────────
    const isRecurringInt   = recurring === "Ya" ? 1 : 0;
    const nextDueValue     = recurring === "Ya" ? nextDue : null;
    const cycleStatusValue = recurring === "Ya" ? "ACTIVE" : null;
    const proofUrl         = bukti.url;

    // ── INSERT ke SQLite via createExpenseTx ───────────────────────────────
    let newId;
    try {
        newId = createExpenseTx({
            name:                nama,
            amount:              nominal,
            paid_at:             tanggal,
            scope:               scope,
            is_recurring:        isRecurringInt,
            next_due_at:         nextDueValue,
            payment_proof_url:   proofUrl,
            notes:               catatan,
            recurring_series_id: null,
            cycle_status:        cycleStatusValue,
        });
    } catch (err) {
        console.error("❌ [expense add] Database INSERT gagal:", err);
        return interaction.reply({
            content: "❌ **Gagal menyimpan expense ke database.** Silakan coba lagi atau hubungi admin.",
            ephemeral: true,
        });
    }

    // ── INSERT sukses — bangun embed ───────────────────────────────────────
    const newRow = getExpenseById.get(newId);
    const isImageFromAttachment = bukti.contentType?.startsWith("image/") ?? false;
    const { embed, isImage: isImageFromUrl } = buildLedgerEmbed(newRow, interaction.user.id);

    const finalIsImage = isImageFromAttachment || isImageFromUrl;
    if (isImageFromAttachment && !isImageFromUrl) {
        embed.setImage(proofUrl);
    }

    // ── Post ke channel ────────────────────────────────────────────────────
    const postResult = await postLedgerToChannel(
        interaction.client,
        embed,
        finalIsImage,
        proofUrl,
        `expense add #${newId}`
    );

    // ── Jika Discord post gagal ────────────────────────────────────────────
    if (!postResult.ok) {
        const channelPart = postResult.channelId ? ` ke <#${postResult.channelId}>` : "";
        return interaction.reply({
            content: `⚠️ Expense **#${newId}** sudah tersimpan di database, tetapi gagal dipost${channelPart}: ${postResult.errorMessage}\n\n**Jangan input ulang expense ini.** Gunakan \`/expense repost id:${newId}\` untuk mencoba post ledger kembali.`,
            ephemeral: true,
        });
    }

    // ── Discord post berhasil — simpan ledger tracking ─────────────────────
    const postedAt = new Date().toISOString();
    try {
        updateLedgerTracking.run({
            expenseId: newId,
            messageId: postResult.message.id,
            postedAt,
        });
        console.log(`✅ [expense add #${newId}] Ledger tracking tersimpan: message=${postResult.message.id}`);
    } catch (err) {
        console.error(`⚠️ [expense add #${newId}] Ledger terkirim ke Discord tapi gagal simpan tracking:`, err);
    }

    return interaction.reply({
        content: `✅ Expense **#${newId}** berhasil dicatat di <#${postResult.channelId}>.`,
        ephemeral: true,
    });
}

// ─── Handler: /expense repost ────────────────────────────────────────────────
async function handleRepost(interaction) {
    const expenseId = interaction.options.getInteger("id");

    const row = getExpenseById.get(expenseId);

    if (!row) {
        return interaction.reply({
            content: `❌ Expense **#${expenseId}** tidak ditemukan.`,
            ephemeral: true,
        });
    }

    const currentLedgerMsgId = row.ledger_message_id ?? null;

    if (currentLedgerMsgId === "PENDING") {
        return interaction.reply({
            content: `⏳ Expense **#${expenseId}** sedang diproses untuk ledger. Coba lagi setelah proses selesai.`,
            ephemeral: true,
        });
    }

    if (currentLedgerMsgId !== null) {
        const channelId = process.env.EXPENSE_CHANNEL_ID;
        const guildId   = process.env.GUILD_ID;

        let ledgerLink = "";
        if (guildId && channelId && currentLedgerMsgId) {
            ledgerLink = `\n\n🔗 [Lihat ledger existing](https://discord.com/channels/${guildId}/${channelId}/${currentLedgerMsgId})`;
        }

        return interaction.reply({
            content: `⚠️ Expense **#${expenseId}** sudah memiliki ledger di <#${channelId ?? "expenses"}> dan tidak dipost ulang.${ledgerLink}`,
            ephemeral: true,
        });
    }

    const claimResult = updateLedgerTracking.run({
        expenseId,
        messageId: "PENDING",
        postedAt:  new Date().toISOString(),
    });

    if (claimResult.changes === 0) {
        const freshRow      = getExpenseById.get(expenseId);
        const freshLedgerId = freshRow?.ledger_message_id ?? null;

        if (freshLedgerId === "PENDING") {
            return interaction.reply({
                content: `⏳ Expense **#${expenseId}** sedang diproses untuk ledger. Coba lagi setelah proses selesai.`,
                ephemeral: true,
            });
        }

        if (freshLedgerId !== null) {
            const channelId = process.env.EXPENSE_CHANNEL_ID;
            const guildId   = process.env.GUILD_ID;
            let ledgerLink = "";
            if (guildId && channelId && freshLedgerId) {
                ledgerLink = `\n\n🔗 [Lihat ledger existing](https://discord.com/channels/${guildId}/${channelId}/${freshLedgerId})`;
            }
            return interaction.reply({
                content: `⚠️ Expense **#${expenseId}** sudah memiliki ledger di <#${channelId ?? "expenses"}> dan tidak dipost ulang.${ledgerLink}`,
                ephemeral: true,
            });
        }

        return interaction.reply({
            content: `⚠️ Expense **#${expenseId}** tidak dapat diproses saat ini. Coba lagi.`,
            ephemeral: true,
        });
    }

    const { embed, isImage } = buildLedgerEmbed(row, null);

    const postResult = await postLedgerToChannel(
        interaction.client,
        embed,
        isImage,
        row.payment_proof_url,
        `expense repost #${expenseId}`
    );

    if (!postResult.ok) {
        try {
            db.prepare(`
                UPDATE expenses
                SET ledger_message_id = NULL, ledger_posted_at = NULL
                WHERE id = ? AND ledger_message_id = 'PENDING'
            `).run(expenseId);
            console.warn(`⚠️ [expense repost #${expenseId}] PENDING placeholder di-rollback karena Discord post gagal.`);
        } catch (rollbackErr) {
            console.error(`❌ [expense repost #${expenseId}] Gagal rollback PENDING placeholder:`, rollbackErr);
        }

        const channelPart = postResult.channelId ? ` ke <#${postResult.channelId}>` : "";
        return interaction.reply({
            content: `⚠️ Gagal repost Expense **#${expenseId}**${channelPart}: ${postResult.errorMessage}\n\nData di database tidak berubah.`,
            ephemeral: true,
        });
    }

    const realMessageId = postResult.message.id;
    const postedAt      = new Date().toISOString();

    try {
        db.prepare(`
            UPDATE expenses
            SET ledger_message_id = ?, ledger_posted_at = ?
            WHERE id = ? AND ledger_message_id = 'PENDING'
        `).run(realMessageId, postedAt, expenseId);
        console.log(`✅ [expense repost #${expenseId}] Ledger tracking tersimpan: message=${realMessageId}`);
    } catch (err) {
        console.error(`⚠️ [expense repost #${expenseId}] Ledger terkirim ke Discord tapi gagal update tracking:`, err);
    }

    return interaction.reply({
        content: `✅ Expense **#${expenseId}** berhasil dipost ke <#${postResult.channelId}>.`,
        ephemeral: true,
    });
}

// ─── Handler: /expense mark-paid ─────────────────────────────────────────────
async function handleMarkPaid(interaction) {
    const expenseId = interaction.options.getInteger("id");
    const nominal   = interaction.options.getInteger("nominal");
    const tanggal   = interaction.options.getString("tanggal").trim();
    const nextDue   = interaction.options.getString("next_due").trim();
    const bukti     = interaction.options.getAttachment("bukti");
    const catatan   = interaction.options.getString("catatan")?.trim() ?? null;

    // ── 1. Validasi Input ──────────────────────────────────────────────────
    if (nominal <= 0) {
        return interaction.reply({
            content: "❌ **Nominal tidak valid.** Harus lebih dari 0.",
            ephemeral: true,
        });
    }

    if (!isValidDate(tanggal)) {
        return interaction.reply({
            content: `❌ **Format tanggal pembayaran tidak valid:** \`${tanggal}\`\nGunakan format \`YYYY-MM-DD\` dengan tanggal yang benar, contoh: \`2026-11-19\`.`,
            ephemeral: true,
        });
    }

    if (!isValidDate(nextDue)) {
        return interaction.reply({
            content: `❌ **Format \`next_due\` tidak valid:** \`${nextDue}\`\nGunakan format \`YYYY-MM-DD\` dengan tanggal yang benar.`,
            ephemeral: true,
        });
    }

    if (nextDue <= tanggal) {
        return interaction.reply({
            content: `❌ **\`next_due\` (${nextDue}) harus lebih besar dari tanggal pembayaran (${tanggal}).**`,
            ephemeral: true,
        });
    }

    // ── 2. Eksekusi Atomic SQLite Transaction ──────────────────────────────
    let txResult;
    try {
        txResult = markPaidTransaction(expenseId, {
            amount: nominal,
            paid_at: tanggal,
            next_due_at: nextDue,
            payment_proof_url: bukti.url,
            notes: catatan,
        });
    } catch (err) {
        console.error(`❌ [expense mark-paid #${expenseId}] Transaction error:`, err);
        if (err.message === "EXPENSE_NOT_FOUND") {
            return interaction.reply({
                content: `❌ Expense **#${expenseId}** tidak ditemukan di database.`,
                ephemeral: true,
            });
        }
        if (err.message === "NOT_RECURRING") {
            return interaction.reply({
                content: `❌ Expense **#${expenseId}** bukan pengeluaran recurring (\`is_recurring = 0\`). Subcommand ini khusus untuk perpanjangan tagihan recurring.`,
                ephemeral: true,
            });
        }
        if (err.message === "NOT_ACTIVE" || err.message === "CONCURRENT_CONFLICT") {
            return interaction.reply({
                content: `⚠️ Expense **#${expenseId}** sudah bukan siklus aktif (\`cycle_status != ACTIVE\`). Tagihan ini kemungkinan sudah ditandai lunas oleh proses lain atau Anda menggunakan ID siklus yang sudah lewat.`,
                ephemeral: true,
            });
        }
        if (err.message === "NO_SERIES_ID") {
            return interaction.reply({
                content: `❌ Expense **#${expenseId}** tidak memiliki \`recurring_series_id\` yang valid. Hubungi admin.`,
                ephemeral: true,
            });
        }
        return interaction.reply({
            content: `❌ **Gagal memproses Mark Paid:** ${err.message}`,
            ephemeral: true,
        });
    }

    const { source, newExpenseId } = txResult;

    // ── 3. Transaksi DB COMMIT sukses — Post ke #expenses ledger ───────────
    const newRow = getExpenseById.get(newExpenseId);
    const isImageFromAttachment = bukti.contentType?.startsWith("image/") ?? false;
    const { embed, isImage: isImageFromUrl } = buildLedgerEmbed(newRow, interaction.user.id);

    const finalIsImage = isImageFromAttachment || isImageFromUrl;
    if (isImageFromAttachment && !isImageFromUrl) {
        embed.setImage(bukti.url);
    }

    const postResult = await postLedgerToChannel(
        interaction.client,
        embed,
        finalIsImage,
        bukti.url,
        `expense mark-paid #${newExpenseId}`
    );

    // ── 4. Jika Discord post gagal ─────────────────────────────────────────
    // Database adalah SOURCE OF TRUTH. JANGAN rollback payment.
    // Old cycle tetap SUPERSEDED, new cycle tetap ACTIVE, ledger tracking tetap NULL.
    if (!postResult.ok) {
        const channelPart = postResult.channelId ? ` ke <#${postResult.channelId}>` : "";
        return interaction.reply({
            content: `⚠️ Pembayaran tagihan **${source.name}** berhasil dicatat di database sebagai Expense **#${newExpenseId}**, tetapi gagal diposting ke ledger${channelPart}: ${postResult.errorMessage}\n\n**Jangan input ulang.** Gunakan \`/expense repost id:${newExpenseId}\` untuk memposting ulang ledger.`,
            ephemeral: true,
        });
    }

    // ── 5. Discord post berhasil — simpan ledger tracking ──────────────────
    const postedAt = new Date().toISOString();
    try {
        updateLedgerTracking.run({
            expenseId: newExpenseId,
            messageId: postResult.message.id,
            postedAt,
        });
        console.log(`✅ [expense mark-paid #${newExpenseId}] Ledger tracking tersimpan: message=${postResult.message.id}`);
    } catch (err) {
        console.error(`⚠️ [expense mark-paid #${newExpenseId}] Ledger terkirim tapi gagal update tracking:`, err);
    }

    return interaction.reply({
        content: `✅ Tagihan **${source.name}** (Expense #${source.id}) berhasil ditandai **LUNAS**!\nSiklus baru tercatat sebagai Expense **#${newExpenseId}** di <#${postResult.channelId}> dengan jatuh tempo berikutnya pada **${formatTanggalReadable(newRow.next_due_at)}**.`,
        ephemeral: true,
    });
}