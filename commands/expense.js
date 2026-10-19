const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const db = require("../database/db");

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validasi format dan keabsahan tanggal YYYY-MM-DD.
 * Menggunakan Date() untuk memastikan tanggal benar-benar valid
 * (mis. 2026-02-30 akan ditolak).
 * @param {string} str
 * @returns {boolean}
 */
function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const d = new Date(str);
    if (isNaN(d.getTime())) return false;
    // Pastikan tidak ada overflow (misal Feb 30 → Mar 2)
    return d.toISOString().startsWith(str);
}

/**
 * Format integer Rupiah menjadi "Rp1.000.000"
 * @param {number} amount
 * @returns {string}
 */
function formatRupiah(amount) {
    return "Rp" + amount.toLocaleString("id-ID");
}

/**
 * Format tanggal ISO "YYYY-MM-DD" menjadi "19 Oktober 2026" (Bahasa Indonesia).
 * @param {string} isoDate
 * @returns {string}
 */
function formatTanggalReadable(isoDate) {
    // new Date("YYYY-MM-DD") diparse sebagai UTC — tambah T00:00:00 agar konsisten
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

// ─── Warna embed per scope ───────────────────────────────────────────────────
const SCOPE_COLOR = {
    AI:      0x5865F2, // Discord Blurple — untuk ZEINZY AI
    WEDDING: 0xF47FFF, // Soft Pink/Lavender — untuk ZEINZY WEDDING
};

// ─── Prepared statements ─────────────────────────────────────────────────────
const insertExpense = db.prepare(`
    INSERT INTO expenses
        (name, amount, paid_at, scope, is_recurring, next_due_at, payment_proof_url, notes)
    VALUES
        (@name, @amount, @paid_at, @scope, @is_recurring, @next_due_at, @payment_proof_url, @notes)
`);

const getExpenseById = db.prepare(`
    SELECT * FROM expenses WHERE id = ?
`);

// ─── Shared ledger builder ───────────────────────────────────────────────────
/**
 * Membangun EmbedBuilder dari baris expense di database.
 *
 * Parameter `posterUserId` adalah Discord user ID yang akan di-mention di field
 * "Dicatat oleh". Boleh null jika tidak diketahui (mis. repost tanpa context user asli).
 *
 * @param {object} row         - Baris dari tabel expenses
 * @param {string|null} posterUserId - Discord user ID (string snowflake) atau null
 * @returns {{ embed: EmbedBuilder, isImage: boolean }}
 */
function buildLedgerEmbed(row, posterUserId) {
    const scopeLabel   = row.scope === "AI" ? "🤖 ZEINZY AI" : "💍 ZEINZY WEDDING";
    const recurringStr = row.is_recurring === 1 ? "Ya" : "Tidak";
    const nextDueLabel = row.next_due_at ? formatTanggalReadable(row.next_due_at) : "-";
    const catatanLabel = row.notes ?? "-";
    const dicatatOleh  = posterUserId ? `<@${posterUserId}>` : "-";

    // Cek apakah URL bukti mengarah ke image (heuristik dari ekstensi URL)
    // Karena data dari DB tidak punya contentType, kita cek ekstensi URL.
    // Untuk data baru dari /add, contentType dari attachment digunakan langsung.
    // Untuk repost dari DB, kita andalkan ekstensi.
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
 * Return { ok: true, channelId } jika sukses.
 * Return { ok: false, channelId, message } jika gagal — caller yang tentukan response ke user.
 *
 * @param {import("discord.js").Client} client
 * @param {EmbedBuilder} embed
 * @param {boolean} isImage        - Apakah bukti sudah ditampilkan sebagai image di embed
 * @param {string} proofUrl        - URL bukti pembayaran
 * @param {string} context         - Label untuk console.error (mis. "expense add #1")
 * @returns {Promise<{ ok: boolean, channelId: string|null, message?: string }>}
 */
async function postLedgerToChannel(client, embed, isImage, proofUrl, context) {
    const channelId = process.env.EXPENSE_CHANNEL_ID;

    if (!channelId) {
        console.error(`❌ [${context}] EXPENSE_CHANNEL_ID belum diset di .env`);
        return {
            ok: false,
            channelId: null,
            message: "`EXPENSE_CHANNEL_ID` belum dikonfigurasi. Hubungi admin.",
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
            message: `Gagal menemukan channel expenses (ID: \`${channelId}\`).`,
        };
    }

    if (!channel || !channel.isTextBased()) {
        console.error(`❌ [${context}] Channel ${channelId} tidak valid atau bukan text channel`);
        return {
            ok: false,
            channelId,
            message: `Channel expenses tidak valid atau bukan text channel (ID: \`${channelId}\`).`,
        };
    }

    try {
        const payload = { embeds: [embed] };
        // Jika bukti bukan image yang sudah di-embed, sertakan URL sebagai teks
        if (!isImage) {
            payload.content = `📎 **Bukti pembayaran:** ${proofUrl}`;
        }
        await channel.send(payload);
    } catch (err) {
        console.error(`❌ [${context}] Gagal send ke channel ${channelId}:`, err);
        return {
            ok: false,
            channelId,
            message: `Gagal mengirim pesan ke <#${channelId}>.`,
        };
    }

    return { ok: true, channelId };
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
                // 1. nama
                .addStringOption(option =>
                    option
                        .setName("nama")
                        .setDescription("Nama expense (contoh: VPS Biznet)")
                        .setRequired(true)
                )
                // 2. nominal
                .addIntegerOption(option =>
                    option
                        .setName("nominal")
                        .setDescription("Nominal dalam Rupiah (angka bulat, min 1)")
                        .setRequired(true)
                        .setMinValue(1)
                )
                // 3. scope
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
                // 4. tanggal
                .addStringOption(option =>
                    option
                        .setName("tanggal")
                        .setDescription("Tanggal pembayaran (format: YYYY-MM-DD, contoh: 2026-10-19)")
                        .setRequired(true)
                )
                // 5. recurring
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
                // 6. bukti
                .addAttachmentOption(option =>
                    option
                        .setName("bukti")
                        .setDescription("Bukti pembayaran (screenshot/foto)")
                        .setRequired(true)
                )
                // 7. next_due (optional Discord, wajib jika recurring=Ya)
                .addStringOption(option =>
                    option
                        .setName("next_due")
                        .setDescription("Tanggal jatuh tempo berikutnya (WAJIB jika Recurring: Ya, format: YYYY-MM-DD)")
                        .setRequired(false)
                )
                // 8. catatan (optional)
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
        ),

    // ─── Execute ─────────────────────────────────────────────────────────────
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === "add")    return handleAdd(interaction);
        if (sub === "repost") return handleRepost(interaction);

        return interaction.reply({
            content: "⚠️ Subcommand tidak dikenal.",
            ephemeral: true,
        });
    },
};

// ─── Handler: /expense add ───────────────────────────────────────────────────
async function handleAdd(interaction) {
    // ── Ambil semua input ──────────────────────────────────────────────────
    const nama      = interaction.options.getString("nama").trim();
    const nominal   = interaction.options.getInteger("nominal");
    const scope     = interaction.options.getString("scope");
    const tanggal   = interaction.options.getString("tanggal").trim();
    const recurring = interaction.options.getString("recurring");
    const bukti     = interaction.options.getAttachment("bukti");
    const nextDue   = interaction.options.getString("next_due")?.trim() ?? null;
    const catatan   = interaction.options.getString("catatan")?.trim() ?? null;

    // ── Validasi ───────────────────────────────────────────────────────────

    // 1. nominal
    if (nominal <= 0) {
        return interaction.reply({
            content: "❌ **Nominal tidak valid.** Harus lebih dari 0.",
            ephemeral: true,
        });
    }

    // 2. scope
    if (!["AI", "WEDDING"].includes(scope)) {
        return interaction.reply({
            content: "❌ **Scope tidak valid.** Pilih antara `AI` atau `WEDDING`.",
            ephemeral: true,
        });
    }

    // 3. format & validitas tanggal
    if (!isValidDate(tanggal)) {
        return interaction.reply({
            content: `❌ **Format tanggal tidak valid:** \`${tanggal}\`\nGunakan format \`YYYY-MM-DD\` dengan tanggal yang benar, contoh: \`2026-10-19\`.`,
            ephemeral: true,
        });
    }

    // 4. next_due: wajib jika recurring = Ya
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
    }

    // ── Siapkan data untuk INSERT ──────────────────────────────────────────
    const isRecurringInt = recurring === "Ya" ? 1 : 0;
    const nextDueValue   = recurring === "Ya" ? nextDue : null;
    const proofUrl       = bukti.url;

    // ── INSERT ke SQLite ───────────────────────────────────────────────────
    let newId;
    try {
        const result = insertExpense.run({
            name:               nama,
            amount:             nominal,
            paid_at:            tanggal,
            scope:              scope,
            is_recurring:       isRecurringInt,
            next_due_at:        nextDueValue,
            payment_proof_url:  proofUrl,
            notes:              catatan,
        });
        newId = result.lastInsertRowid;
    } catch (err) {
        console.error("❌ [expense add] Database INSERT gagal:", err);
        return interaction.reply({
            content: "❌ **Gagal menyimpan expense ke database.** Silakan coba lagi atau hubungi admin.",
            ephemeral: true,
        });
    }

    // ── INSERT sukses — bangun embed ───────────────────────────────────────
    // Ambil row yang baru diinsert untuk dipakai buildLedgerEmbed
    const newRow = getExpenseById.get(newId);

    // Untuk data baru, kita punya contentType dari attachment — lebih akurat dari heuristik URL
    const isImageFromAttachment = bukti.contentType?.startsWith("image/") ?? false;

    const { embed, isImage: isImageFromUrl } = buildLedgerEmbed(newRow, interaction.user.id);

    // Gunakan contentType attachment (lebih akurat) untuk menentukan apakah image di embed
    // Jika contentType bilang image tapi heuristik URL tidak, tetap tampilkan image
    const finalIsImage = isImageFromAttachment || isImageFromUrl;
    if (isImageFromAttachment && !isImageFromUrl) {
        // buildLedgerEmbed tidak set image (karena ekstensi URL tidak dikenali),
        // tapi attachment memang image — set manual
        embed.setImage(proofUrl);
    }

    // ── Post ke channel ────────────────────────────────────────────────────
    const result = await postLedgerToChannel(
        interaction.client,
        embed,
        finalIsImage,
        proofUrl,
        `expense add #${newId}`
    );

    if (!result.ok) {
        const channelPart = result.channelId ? ` ke <#${result.channelId}>` : "";
        return interaction.reply({
            content: `⚠️ Expense **#${newId}** sudah tersimpan di database, tetapi gagal dipost${channelPart}: ${result.message}\n\n**Jangan input ulang expense ini.**`,
            ephemeral: true,
        });
    }

    return interaction.reply({
        content: `✅ Expense **#${newId}** berhasil dicatat di <#${result.channelId}>.`,
        ephemeral: true,
    });
}

// ─── Handler: /expense repost ────────────────────────────────────────────────
async function handleRepost(interaction) {
    const expenseId = interaction.options.getInteger("id");

    // ── Cari expense di DB (read-only) ─────────────────────────────────────
    const row = getExpenseById.get(expenseId);

    if (!row) {
        return interaction.reply({
            content: `❌ Expense **#${expenseId}** tidak ditemukan.`,
            ephemeral: true,
        });
    }

    // ── Bangun embed dari data DB ──────────────────────────────────────────
    // posterUserId = null karena kita tidak tahu user Discord original dari DB
    const { embed, isImage } = buildLedgerEmbed(row, null);

    // ── Post ke channel ────────────────────────────────────────────────────
    const result = await postLedgerToChannel(
        interaction.client,
        embed,
        isImage,
        row.payment_proof_url,
        `expense repost #${expenseId}`
    );

    if (!result.ok) {
        const channelPart = result.channelId ? ` ke <#${result.channelId}>` : "";
        return interaction.reply({
            content: `⚠️ Gagal repost Expense **#${expenseId}**${channelPart}: ${result.message}\n\nData di database tidak berubah.`,
            ephemeral: true,
        });
    }

    return interaction.reply({
        content: `✅ Expense **#${expenseId}** berhasil dipost ke <#${result.channelId}>.`,
        ephemeral: true,
    });
}