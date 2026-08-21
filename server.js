const express = require("express");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const TIKWM_API = "https://www.tikwm.com/api/";

const downloadTokens = new Map();
const TOKEN_LIFETIME = 10 * 60 * 1000;


// Remove expired download tokens automatically
setInterval(() => {
    const now = Date.now();

    for (const [token, item] of downloadTokens.entries()) {
        if (item.expiresAt < now) {
            downloadTokens.delete(token);
        }
    }
}, 5 * 60 * 1000);


// Check whether the supplied URL is a TikTok URL
function isTikTokUrl(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();

        return (
            host === "tiktok.com" ||
            host.endsWith(".tiktok.com")
        );

    } catch {
        return false;
    }
}


// Convert URLs such as //tikwm.com/... to https://tikwm.com/...
function formatUrl(rawUrl) {
    if (!rawUrl) {
        return "";
    }

    if (rawUrl.startsWith("//")) {
        return "https:" + rawUrl;
    }

    return rawUrl;
}


// Create a temporary download token
function createDownloadToken(fileUrl, filename) {
    const token = crypto.randomBytes(24).toString("hex");

    downloadTokens.set(token, {
        fileUrl,
        filename,
        expiresAt: Date.now() + TOKEN_LIFETIME
    });

    return token;
}


// Test server
app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "TikDrop server is working!"
    });
});


// Process TikTok URL
app.post("/api/download", async (req, res) => {
    try { 
        console.log("DOWNLOAD API WAS CALLED");

        const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

        if (!url || !isTikTokUrl(url)) {
            return res.status(400).json({
                success: false,
                error: "Please enter a valid TikTok URL."
            });
        }

        console.log("Processing TikTok URL:", url);


        let response;

        try {
            response = await fetch(TIKWM_API, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                },
                body: new URLSearchParams({ url, hd: "1" }),
                signal: AbortSignal.timeout(15000)
            });
        } catch (error) {
            const upstreamError = new Error(`Video service is unavailable: ${error.message}`);
            upstreamError.statusCode = 502;
            throw upstreamError;
        }


        if (!response.ok) {
            const upstreamError = new Error(`Video service returned HTTP ${response.status}`);
            upstreamError.statusCode = 502;
            throw upstreamError;
        }


        let result;

        try {
            result = await response.json();
        } catch {
            const upstreamError = new Error("Video service returned an invalid response.");
            upstreamError.statusCode = 502;
            throw upstreamError;
        }


        if (
            !result ||
            result.code !== 0 ||
            !result.data ||
            !result.data.play
        ) {
            throw new Error(
                result?.msg ||
                "Unable to process this TikTok video."
            );
        }


        const video = result.data;


        // No-watermark video
        const normalVideo =
            formatUrl(video.play);


        // HD video
        const hdVideo =
            formatUrl(
                video.hdplay ||
                video.play
            );


        if (!normalVideo || !/^https?:\/\//i.test(normalVideo)) {
            throw new Error(
                "No downloadable video URL was returned."
            );
        }


        // Create temporary download links
        const normalToken =
            createDownloadToken(
                normalVideo,
                "TikDrop_Video.mp4"
            );


        const hdToken =
            createDownloadToken(
                hdVideo,
                "TikDrop_Video_HD.mp4"
            );


        res.json({
            success: true,

            title:
                video.title ||
                "TikTok Video",

            thumbnail_url:
                formatUrl(
                    video.cover ||
                    video.origin_cover ||
                    ""
                ),

            download_url:
                `/api/file/${normalToken}`,

            download_url_hd:
                `/api/file/${hdToken}`
        });


    } catch (error) {

        console.error(
            "TikDrop API error:",
            error
        );

        res.status(error.statusCode || 500).json({
            success: false,

            error:
                error.message ||
                "Something went wrong."
        });
    }
});


// Download the actual video
app.get("/api/file/:token", async (req, res) => {

    try {

        const item =
            downloadTokens.get(
                req.params.token
            );


        if (
            !item ||
            item.expiresAt < Date.now()
        ) {

            if (item) {
                downloadTokens.delete(
                    req.params.token
                );
            }

            return res.status(404).send(
                "Download link has expired."
            );
        }


        console.log(
            "Downloading from:",
            item.fileUrl
        );


        const response =
            await fetch(
                item.fileUrl,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",

                        "Accept":
                            "video/mp4,video/*,*/*"
                    }
                }
            );


        const contentType =
            response.headers.get(
                "content-type"
            ) || "";


        const contentLength =
            response.headers.get(
                "content-length"
            );


        console.log(
            "Video response:",
            {
                status: response.status,
                contentType: contentType,
                contentLength: contentLength
            }
        );


        if (
            !response.ok ||
            !response.body
        ) {

            return res.status(502).send(
                "The video server did not return a valid video."
            );
        }


        // Prevent HTML/JSON error pages
        // from being saved as MP4 files
        if (
            !contentType.includes("video") &&
            !contentType.includes("octet-stream")
        ) {

            const text =
                await response.text();

            console.error(
                "Unexpected response:",
                text.substring(0, 500)
            );

            return res.status(502).send(
                "The video service returned an invalid file."
            );
        }


        res.setHeader(
            "Content-Type",
            contentType
        );


        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${item.filename}"`
        );


        if (contentLength) {
            res.setHeader(
                "Content-Length",
                contentLength
            );
        }


        const nodeStream =
            Readable.fromWeb(
                response.body
            );


        await pipeline(
            nodeStream,
            res
        );


    } catch (error) {

        if (
            error.code !==
            "ERR_STREAM_PREMATURE_CLOSE"
        ) {

            console.error(
                "Download error:",
                error
            );


            if (!res.headersSent) {

                res.status(502).send(
                    "Unable to download the video."
                );
            }
        }
    }
});


// Start server
app.listen(
    PORT,
    () => {

        console.log(
            `TikDrop is running at http://localhost:${PORT}`
        );

    }
);