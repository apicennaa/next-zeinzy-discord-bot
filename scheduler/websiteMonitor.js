const { EmbedBuilder } = require("discord.js");
const { performHttpHealthCheck, DEFAULT_TIMEOUT_MS } = require("../services/healthCheck");
const { formatJakartaDateTime, formatDuration } = require("../utils/formatters");

const DEFAULT_TARGET_URL = process.env.WEBSITE_MONITOR_URL || "https://invite.zeinzy.id";
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 menit
const DEFAULT_DOWN_THRESHOLD = 3; // 3 kali gagal berturut-turut

/**
 * Membangun Discord embed untuk alert DOWN.
 * @param {string} targetUrl
 * @param {number} consecutiveFailures
 * @param {Date} detectedAt
 * @returns {EmbedBuilder}
 */
function buildDownEmbed(targetUrl, consecutiveFailures, detectedAt) {
    let hostname = targetUrl;
    try {
        hostname = new URL(targetUrl).hostname;
    } catch {
        // fallback jika url parsing gagal
    }

    return new EmbedBuilder()
        .setColor(0xED4245) // Danger Red
        .setTitle("🔴 ZEINZY WEDDING DOWN")
        .setDescription("Website mengalami gangguan dan tidak dapat diakses.")
        .addFields(
            { name: "Website",              value: `[${hostname}](${targetUrl})`,              inline: true },
            { name: "Status",               value: "⚠️ **Tidak dapat diakses**",                inline: true },
            { name: "Gagal berturut-turut", value: `**${consecutiveFailures}x**`,               inline: true },
            { name: "Mulai terdeteksi",     value: formatJakartaDateTime(detectedAt),          inline: false },
        )
        .setFooter({ text: "ZEINZY Bot • Website Monitor • Bot akan terus melakukan pengecekan otomatis." })
        .setTimestamp(detectedAt);
}

/**
 * Membangun Discord embed untuk alert RECOVERED.
 * @param {string} targetUrl
 * @param {Date} recoveredAt
 * @param {number|null} downtimeMs
 * @returns {EmbedBuilder}
 */
function buildRecoveredEmbed(targetUrl, recoveredAt, downtimeMs) {
    let hostname = targetUrl;
    try {
        hostname = new URL(targetUrl).hostname;
    } catch {
        // fallback
    }

    const downtimeText = downtimeMs !== null ? formatDuration(downtimeMs) : "-";

    return new EmbedBuilder()
        .setColor(0x57F287) // Success Green
        .setTitle("🟢 ZEINZY WEDDING RECOVERED")
        .setDescription("Website telah pulih dan kembali dapat diakses secara normal.")
        .addFields(
            { name: "Website",       value: `[${hostname}](${targetUrl})`,             inline: true },
            { name: "Status",        value: "✅ **Kembali dapat diakses**",             inline: true },
            { name: "Downtime",      value: `⏱️ **${downtimeText}**`,                 inline: true },
            { name: "Recovered at",  value: formatJakartaDateTime(recoveredAt),         inline: false },
        )
        .setFooter({ text: "ZEINZY Bot • Website Monitor • Monitoring kembali normal." })
        .setTimestamp(recoveredAt);
}

/**
 * Class WebsiteMonitor
 * Mengelola state monitoring, eksekusi health check, dan pengiriman alert ke Discord.
 */
class WebsiteMonitor {
    /**
     * @param {object} [options]
     * @param {string} [options.targetUrl]
     * @param {number} [options.checkIntervalMs]
     * @param {number} [options.downThreshold]
     * @param {number} [options.timeoutMs]
     * @param {Function} [options.healthChecker] - function(url, timeoutMs) => Promise<{ ok, statusCode, error }>
     * @param {Function} [options.alertSender]   - function(type, payload) => Promise<boolean>
     */
    constructor(options = {}) {
        this.targetUrl         = options.targetUrl || DEFAULT_TARGET_URL;
        this.checkIntervalMs   = options.checkIntervalMs || DEFAULT_INTERVAL_MS;
        this.downThreshold     = options.downThreshold || DEFAULT_DOWN_THRESHOLD;
        this.timeoutMs         = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.healthChecker     = options.healthChecker || performHttpHealthCheck;
        this.alertSender       = options.alertSender || null;

        // State monitoring
        this.status              = "UP";  // "UP" | "DOWN"
        this.consecutiveFailures = 0;
        this.firstFailureTime    = null;  // Date saat failure pertama terdeteksi
        this.downDetectedTime    = null;  // Date saat status resmi berubah jadi DOWN (failure ke-3)
        this.isChecking          = false; // Proteksi overlapping check
        this.intervalHandle      = null;
    }

    /**
     * Mengambil snapshot state terkini (read-only untuk inspeksi/testing).
     */
    getState() {
        return {
            targetUrl:           this.targetUrl,
            status:              this.status,
            consecutiveFailures: this.consecutiveFailures,
            firstFailureTime:    this.firstFailureTime,
            downDetectedTime:    this.downDetectedTime,
            isChecking:          this.isChecking,
        };
    }

    /**
     * Menjalankan satu kali siklus health check dengan proteksi concurrency/overlap.
     * @returns {Promise<{ executed: boolean, result?: object, skipped?: boolean, reason?: string }>}
     */
    async check() {
        // Proteksi overlap: jangan jalankan jika check sebelumnya belum selesai
        if (this.isChecking) {
            console.warn("⚠️ [Website Monitor] Pengecekan sebelumnya masih berjalan, check saat ini dilewati (overlap protection).");
            return { executed: false, skipped: true, reason: "overlapping" };
        }

        this.isChecking = true;
        try {
            const result = await this.healthChecker(this.targetUrl, this.timeoutMs);
            await this.handleCheckResult(result);
            return { executed: true, result };
        } catch (err) {
            // Safety guard: tangani unexpected exception agar check() tidak pernah unhandled reject
            console.error("❌ [Website Monitor] Unexpected error pada check():", err);
            await this.handleCheckResult({ ok: false, error: err.message || "Unexpected exception" });
            return { executed: true, result: { ok: false, error: err.message } };
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Memproses hasil check dan memperbarui state serta mengirim alert jika diperlukan.
     * @param {{ ok: boolean, statusCode?: number, error?: string }} result
     */
    async handleCheckResult(result) {
        if (!result.ok) {
            this.consecutiveFailures += 1;

            if (this.consecutiveFailures === 1) {
                this.firstFailureTime = new Date();
            }

            console.warn(
                `⚠️ [Website Monitor] Health check gagal (${this.consecutiveFailures}/${this.downThreshold}): ${result.error || "Unknown error"}`
            );

            // Transisi ke DOWN hanya jika threshold tercapai DAN status sebelumnya bukan DOWN
            if (this.consecutiveFailures >= this.downThreshold && this.status !== "DOWN") {
                this.status = "DOWN";
                this.downDetectedTime = new Date();

                console.error(
                    `🚨 [Website Monitor] Website ${this.targetUrl} dinyatakan DOWN (gagal ${this.consecutiveFailures}x berturut-turut). Mengirim alert...`
                );

                await this.sendAlert("DOWN", {
                    targetUrl:           this.targetUrl,
                    consecutiveFailures: this.consecutiveFailures,
                    detectedAt:          this.downDetectedTime,
                });
            }
            // Jika status SUDAH DOWN, alert kedua/ketiga TIDAK dikirim (deduplikasi alert)
        } else {
            // Health check SUCCESS
            if (this.status === "DOWN") {
                // RECOVERY terdeteksi!
                const recoveredAt = new Date();
                const downtimeMs = this.downDetectedTime
                    ? (recoveredAt.getTime() - this.downDetectedTime.getTime())
                    : null;

                console.log(`🟢 [Website Monitor] Website ${this.targetUrl} RECOVERED setelah downtime.`);

                this.status = "UP";
                const previousDownTime = this.downDetectedTime;

                // Reset state failure
                this.consecutiveFailures = 0;
                this.firstFailureTime    = null;
                this.downDetectedTime    = null;

                await this.sendAlert("RECOVERED", {
                    targetUrl:        this.targetUrl,
                    recoveredAt,
                    downtimeMs,
                    downDetectedTime: previousDownTime,
                });
            } else {
                // Sebelumnya UP
                if (this.consecutiveFailures > 0) {
                    console.log(
                        `ℹ️ [Website Monitor] Health check kembali sukses. Reset consecutive failure (${this.consecutiveFailures} -> 0).`
                    );
                }
                this.consecutiveFailures = 0;
                this.firstFailureTime    = null;
            }
        }
    }

    /**
     * Mengirim alert via alertSender jika tersedia.
     * @param {"DOWN"|"RECOVERED"} type
     * @param {object} payload
     */
    async sendAlert(type, payload) {
        if (typeof this.alertSender !== "function") {
            return;
        }

        try {
            await this.alertSender(type, payload);
        } catch (sendErr) {
            // Safety guard: kegagalan Discord alert tidak boleh membuat bot crash
            console.error(`❌ [Website Monitor] Gagal mengirim alert ${type}:`, sendErr);
        }
    }

    /**
     * Menghentikan interval timer (berguna untuk testing atau graceful shutdown).
     */
    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }
}

// ─── Discord Alert Dispatcher ────────────────────────────────────────────────

/**
 * Membuat fungsi pengirim alert yang mengirim Discord Embed ke channel SYSTEM_ALERT_CHANNEL_ID.
 * @param {import("discord.js").Client} client
 * @param {string} channelId
 * @returns {Function}
 */
function createDiscordAlertSender(client, channelId) {
    return async (type, payload) => {
        let channel;
        try {
            channel = await client.channels.fetch(channelId);
        } catch (fetchErr) {
            console.error(`❌ [Website Monitor] Gagal fetch alert channel ${channelId}:`, fetchErr);
            return false;
        }

        if (!channel || !channel.isTextBased()) {
            console.error(`❌ [Website Monitor] Channel ${channelId} tidak valid atau bukan text channel.`);
            return false;
        }

        let embed;
        if (type === "DOWN") {
            embed = buildDownEmbed(payload.targetUrl, payload.consecutiveFailures, payload.detectedAt);
        } else if (type === "RECOVERED") {
            embed = buildRecoveredEmbed(payload.targetUrl, payload.recoveredAt, payload.downtimeMs);
        } else {
            return false;
        }

        try {
            await channel.send({ embeds: [embed] });
            console.log(`✅ [Website Monitor] Alert ${type} berhasil dikirim ke <#${channelId}>.`);
            return true;
        } catch (sendErr) {
            console.error(`❌ [Website Monitor] Gagal mengirim embed ${type} ke channel ${channelId}:`, sendErr);
            return false;
        }
    };
}

// ─── Lifecycle / Startup Entrypoint ──────────────────────────────────────────

/**
 * Memulai Website Monitor scheduler.
 * Dipanggil dari index.js saat clientReady.
 *
 * @param {import("discord.js").Client} client
 * @param {object} [options] - Opsi override (misal untuk testing)
 * @returns {WebsiteMonitor|null} instance monitor atau null jika env tidak diset
 */
function startWebsiteMonitor(client, options = {}) {
    const channelId = options.channelId || process.env.SYSTEM_ALERT_CHANNEL_ID;

    if (!channelId) {
        console.warn("⚠️ [Website Monitor] SYSTEM_ALERT_CHANNEL_ID belum dikonfigurasi di .env. Website monitor dilewati.");
        return null;
    }

    const alertSender = options.alertSender || createDiscordAlertSender(client, channelId);

    const monitor = new WebsiteMonitor({
        targetUrl:         options.targetUrl,
        checkIntervalMs:   options.checkIntervalMs,
        downThreshold:     options.downThreshold,
        timeoutMs:         options.timeoutMs,
        healthChecker:     options.healthChecker,
        alertSender,
    });

    console.log(`🌐 [Website Monitor] Monitoring ${monitor.targetUrl} setiap 2 menit.`);

    // Initial check saat startup (asynchronous tanpa memblokir startup bot)
    monitor.check().catch(err => {
        console.error("❌ [Website Monitor] Error pada initial check:", err);
    });

    // Pengecekan periodik setiap 2 menit
    monitor.intervalHandle = setInterval(() => {
        monitor.check().catch(err => {
            console.error("❌ [Website Monitor] Error pada periodic check:", err);
        });
    }, monitor.checkIntervalMs);

    return monitor;
}

module.exports = {
    WebsiteMonitor,
    buildDownEmbed,
    buildRecoveredEmbed,
    createDiscordAlertSender,
    startWebsiteMonitor,
    DEFAULT_TARGET_URL,
    DEFAULT_INTERVAL_MS,
    DEFAULT_DOWN_THRESHOLD,
};
