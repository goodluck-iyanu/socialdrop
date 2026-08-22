const express = require("express");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
let ytDlp;

try {
    ytDlp = require("yt-dlp-exec");
} catch {
    ytDlp = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const TIKWM_API = "https://www.tikwm.com/api/";
const COBALT_API_URL = process.env.COBALT_API_URL || "";
const COBALT_API_KEY = process.env.COBALT_API_KEY || "";
const execFileAsync = promisify(execFile);

const SOCIAL_HOSTS = {
    tiktok: ["tiktok.com"],
    instagram: ["instagram.com"],
    facebook: ["facebook.com", "fb.watch"]
};

const downloadTokens = new Map();
const TOKEN_LIFETIME = 10 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [token, item] of downloadTokens.entries()) {
        if (item.expiresAt < now) {
            downloadTokens.delete(token);
        }
    }
}, 5 * 60 * 1000);

function getPlatform(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return Object.entries(SOCIAL_HOSTS).find(([, domains]) =>
            domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
        )?.[0] || "";
    } catch {
        return "";
    }
}

function isTikTokUrl(value) {
    return getPlatform(value) === "tiktok";
}

function isSupportedSocialUrl(value) {
    return Boolean(getPlatform(value));
}

function formatUrl(rawUrl) {
    if (!rawUrl) {
        return "";
    }
    return rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
}

function createDownloadToken(fileUrl, filename) {
    const token = crypto.randomBytes(24).toString("hex");
    downloadTokens.set(token, {
        fileUrl,
        filename,
        expiresAt: Date.now() + TOKEN_LIFETIME
    });
    return token;
}

async function resolveWithCobalt(url, platform) {
    let response;
    try {
        response = await fetch(COBALT_API_URL, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...(COBALT_API_KEY ? { Authorization: `Api-Key ${COBALT_API_KEY}` } : {})
            },
            body: JSON.stringify({ url, downloadMode: "auto", videoQuality: "1080" }),
            signal: AbortSignal.timeout(20000)
        });
    } catch {
        const error = new Error(`The ${platform} download service is unavailable.`);
        error.statusCode = 502;
        throw error;
    }

    let result;
    try {
        result = await response.json();
    } catch {
        const error = new Error("The download service returned an invalid response.");
        error.statusCode = 502;
        throw error;
    }

    if (!response.ok || result.status === "error") {
        const error = new Error(result?.error?.code || `Unable to download from ${platform}.`);
        error.statusCode = response.status === 429 ? 429 : 502;
        throw error;
    }

    const media = result.status === "picker"
        ? result.picker.filter((item) => item.type === "video" || item.type === "gif")
        : result.url
            ? [{ url: result.url, type: "video" }]
            : Array.isArray(result.tunnel)
                ? result.tunnel.map((url) => ({ url, type: "video" }))
                : [];
    const video = media.find((item) => /^https?:\/\//i.test(item.url));

    if (!video) {
        throw new Error(`No downloadable video was found on ${platform}.`);
    }

    return {
        title: result.filename || `${platform[0].toUpperCase()}${platform.slice(1)} video`,
        thumbnail_url: media.find((item) => item.thumb)?.thumb || "",
        download_url: video.url,
        download_url_hd: video.url
    };
}

async function resolveWithYtDlp(url, platform) {
    try {
        const args = ["--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download"];
        const { stdout } = ytDlp
            ? await ytDlp(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, skipDownload: true }, { timeout: 30000 })
            : await execFileAsync(process.env.YTDLP_PATH || "yt-dlp", [...args, url], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        const result = JSON.parse(stdout);
        const mediaUrl = result.url || result.requested_downloads?.[0]?.url || result.requested_formats?.find((format) => format.url)?.url || result.formats?.find((format) => format.url)?.url;

        if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            throw new Error("No downloadable video was found.");
        }

        return {
            title: result.title || `${platform[0].toUpperCase()}${platform.slice(1)} video`,
            thumbnail_url: result.thumbnail || "",
            download_url: mediaUrl,
            download_url_hd: mediaUrl
        };
    } catch (error) {
        const message = error.code === "ENOENT"
            ? "The free downloader engine is not installed on this server."
            : error.stderr?.split("\n").filter(Boolean).pop() || `Unable to download this ${platform} video.`;
        const resolverError = new Error(message);
        resolverError.statusCode = 502;
        throw resolverError;
    }
}

app.get("/api/test", (req, res) => {
    res.json({ success: true, message: "SocialDrop server is working!" });
});

app.post("/api/download", async (req, res) => {
    try {
        const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
        if (!url || !isSupportedSocialUrl(url)) {
            return res.status(400).json({ success: false, error: "Please enter a TikTok, Instagram, or Facebook video URL." });
        }

        const platform = getPlatform(url);
        let media;
        if (isTikTokUrl(url)) {
            const response = await fetch(TIKWM_API, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0" },
                body: new URLSearchParams({ url, hd: "1" }),
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                throw new Error(`Video service returned HTTP ${response.status}`);
            }
            const result = await response.json();
            if (!result?.data?.play) {
                throw new Error(result?.msg || "Unable to process this TikTok video.");
            }
            media = {
                title: result.data.title || "TikTok Video",
                thumbnail_url: formatUrl(result.data.cover || result.data.origin_cover || ""),
                download_url: formatUrl(result.data.play),
                download_url_hd: formatUrl(result.data.hdplay || result.data.play)
            };
        } else {
            try {
                media = await resolveWithYtDlp(url, platform);
            } catch (error) {
                if (!COBALT_API_URL) {
                    throw error;
                }
                media = await resolveWithCobalt(url, platform);
            }
        }

        const normalToken = createDownloadToken(media.download_url, "SocialDrop_Video.mp4");
        const hdToken = createDownloadToken(media.download_url_hd, "SocialDrop_Video_HD.mp4");
        res.json({ success: true, platform, title: media.title, thumbnail_url: media.thumbnail_url, download_url: `/api/file/${normalToken}`, download_url_hd: `/api/file/${hdToken}` });
    } catch (error) {
        console.error("SocialDrop API error:", error);
        res.status(error.statusCode || 500).json({ success: false, error: error.message || "Something went wrong." });
    }
});

app.get("/api/file/:token", async (req, res) => {
    try {
        const item = downloadTokens.get(req.params.token);
        if (!item || item.expiresAt < Date.now()) {
            if (item) downloadTokens.delete(req.params.token);
            return res.status(404).send("Download link has expired.");
        }

        const response = await fetch(item.fileUrl, { headers: { "User-Agent": "Mozilla/5.0", Accept: "video/mp4,video/*,*/*" } });
        const contentType = response.headers.get("content-type") || "";
        const contentLength = response.headers.get("content-length");
        if (!response.ok || !response.body || (!contentType.includes("video") && !contentType.includes("octet-stream"))) {
            return res.status(502).send("The video service did not return a valid video.");
        }

        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${item.filename}"`);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
        if (!res.headersSent) res.status(502).send("Unable to download the video.");
    }
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`SocialDrop is running at http://localhost:${PORT}`));
}

module.exports = app;
