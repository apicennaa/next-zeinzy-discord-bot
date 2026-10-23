/**
 * Service untuk melakukan HTTP health check terhadap endpoint website.
 * Terisolasi dari logic state dan Discord notification agar mudah diuji.
 */

const DEFAULT_TIMEOUT_MS = 10000; // 10 detik

/**
 * Melakukan HTTP health check ke URL target.
 *
 * Aturan:
 * - Mengikuti redirect (redirect: 'follow').
 * - Dianggap SUCCESS jika HTTP status >= 200 dan < 400.
 * - HTTP status >= 400 (client/server error) dianggap FAILED.
 * - Network error, DNS failure, atau timeout dianggap FAILED.
 * - Fungsi ini selalu me-resolve objek hasil dan TIDAK PERNAH melempar unhandled rejection.
 *
 * @param {string} url
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{ ok: boolean, statusCode?: number, error?: string }>}
 */
async function performHttpHealthCheck(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
        const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal,
            headers: {
                "User-Agent": "ZEINZY-Uptime-Monitor/1.0 (+https://zeinzy.id)",
                "Accept": "*/*",
            },
        });

        // 2xx dan 3xx (setelah redirect normal) dianggap sukses
        if (response.status >= 200 && response.status < 400) {
            return {
                ok: true,
                statusCode: response.status,
            };
        }

        return {
            ok: false,
            statusCode: response.status,
            error: `HTTP ${response.status} ${response.statusText || ""}`.trim(),
        };
    } catch (err) {
        const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
        const errorMessage = isTimeout
            ? `Connection timed out after ${timeoutMs}ms`
            : (err.message || "Network / Connection error");

        return {
            ok: false,
            error: errorMessage,
        };
    }
}

module.exports = {
    performHttpHealthCheck,
    DEFAULT_TIMEOUT_MS,
};
