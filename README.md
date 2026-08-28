# GLASKO

GLASKO turns a voice message into a vertical video you can post. Record from the microphone, read from the built-in autocue or upload an audio file, choose a background and an animation style, optionally lay a music bed under your voice, and GLASKO renders a real 1080 × 1920 MP4 — H.264 video, AAC audio — that you can download or hand straight to your phone's share sheet.

The Facebook LIVE camera test is a local rehearsal mode: it opens a vertical camera canvas with a private scrolling autocue and front/back camera switching. It does not send video to Facebook; a continuous streaming relay is still required before the control can become a real Go Live button.

Tagline: **"Turn your voice into social video."**

The output is sized and encoded for TikTok, Instagram Reels, Facebook Reels and YouTube Shorts.

## Key technologies

- Next.js 15 (App Router) + TypeScript + Tailwind CSS v4
- `getUserMedia` + `MediaRecorder` for microphone capture
- Web Audio `decodeAudioData` and a hand-written FFT (`lib/analysis.ts`) to precompute per-frame animation data
- A single canvas renderer (`lib/render.ts`) shared by the live preview and the export, so what you see is what gets encoded
- An `OfflineAudioContext` mixdown (`lib/mix.ts`) that folds voice and background music into one buffer before encoding
- WebCodecs `VideoEncoder`/`AudioEncoder` + [`mp4-muxer`](https://www.npmjs.com/package/mp4-muxer) for faster-than-realtime MP4 output, with a `MediaRecorder` realtime path and an `ffmpeg.wasm` transcode as fallbacks (`lib/encode.ts`)
- Web Share API with a download fallback (`lib/share.ts`)

Everything runs in the browser. There is no login, no database, no upload of your audio to a server.

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`. Microphone access needs a secure context — `localhost` counts, as does the deployed HTTPS URL.

## How it works

1. **Audio** — record from the mic (auto-stops at 3 minutes), use Autocue to read a locally saved scrolling script while recording, or upload an existing file. The recording is decoded to raw samples at 48 kHz.
2. **Background** — pick one of nine solid or gradient presets, or upload your own image. Uploaded images get a dark scrim so the text stays readable.
3. **Animation** — choose an animated waveform or animated bars. The preview plays the real audio against the real renderer.
4. **Background music** — pick from the built-in library (twelve tracks across Inspirational, Calm, Cinematic, Energetic, Business and Ambient) or upload your own MP3, WAV, M4A or AAC up to 20 MB. Preview any track before choosing it, set the voice and music volumes independently (voice 100%, music 15% by default), and remove or replace the selection at any time. A short track loops to cover the voice, a long one is trimmed to it, and both ends get a 1.2 s fade. Optional — the export works with no music at all.
5. **Export** — GLASKO mixes the audio down to one buffer, analyses it once, then draws all 30 frames per second into the encoder. Progress is reported per stage; long clips can be cancelled mid-export.
6. **Share** — "Download Video" saves the MP4. "Share Video" opens the native share sheet where the browser supports sharing files; where it does not, the UI says so and points you at the download instead.

## The music library

The twelve built-in tracks live in `public/music/`, with `public/music/library.json` as their catalogue (title, category, path, duration, artist, license). They are not licensed samples: `scripts/generate-music.js` synthesises every one of them from oscillators, so the whole library ships as CC0 public domain and there is nothing to clear before posting. Regenerate them with:

```bash
npm run music:build
```

`public/music/LICENSE.md` records the provenance and what to check before adding a third-party track. Uploaded music is decoded in the browser and never leaves the device.

Automatic posting to social networks is deliberately not claimed anywhere in the app — that would require each platform's official upload API and an authenticated account. See `AGENTS.md` for architecture notes and known limitations.
