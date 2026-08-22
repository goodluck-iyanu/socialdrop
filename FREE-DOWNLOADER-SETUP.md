# Free downloader setup

SocialDrop can run without an API key by using `yt-dlp` locally.

## Windows

Install Python 3, then run:

```powershell
npm run setup:downloader
```

Restart SocialDrop after installation. The server automatically detects `yt-dlp` and handles YouTube, Instagram, Facebook, X, and Threads. TikTok continues to use its existing resolver.

FFmpeg is optional for single-file downloads, but install it if you need merged video and audio formats.

## Hosting

GitHub stores the source code but does not run the downloader. Vercel is not a dependable host for `yt-dlp` and FFmpeg because serverless functions have execution and binary restrictions. Use a host that supports a persistent Node/Python process and system packages for the free local mode.

Only download media you own or have permission to save, and follow each platform's terms.