# AGENTS.md

## Architecture

GLASKO is a single-screen Next.js 15 App Router app (TypeScript, Tailwind CSS v4) whose video pipeline runs entirely in the browser. Audio and video never leave the device: the only server code is one route handler for the visitor counter, and the only thing it stores is an anonymous id.

- `app/page.tsx` is the only screen. It owns all state (audio source, background, animation, music selection and volumes, export status, sharing) and composes the six step panels plus the preview.
- `components/` holds the presentational pieces: `SourcePanel` (record/upload), `BackgroundPanel`, `AnimationPanel`, `MusicPanel`, `ExportPanel`, `SharePanel`, `SiteFooter`, `PreviewStage`, `Icons`.
- `lib/` holds everything non-visual, and is where the real work lives (see below).
- `app/api/visitors/route.ts` is the one server endpoint (see "Visitor counter").

### The rendering contract

The whole design rests on one rule: **the preview and the exported video use the same draw call.** `drawFrame(ctx, frame, spec, frameIndex, scale)` in `lib/render.ts` always draws into a fixed 1080 × 1920 coordinate space and is scaled to fit whatever canvas it is given via `ctx.setTransform`. The preview passes a small scale; the encoder passes `1`. If you add a visual element, add it inside `drawFrame` — anything drawn elsewhere will appear in one and not the other, which is exactly the "it's only a mockup" failure this app is built to avoid.

Animation data is likewise shared. `lib/analysis.ts` precomputes, once per audio file, a per-frame amplitude level, 40 log-spaced frequency bands (via a hand-rolled radix-2 FFT — `AnalyserNode` is useless here because export runs faster than realtime), and a 240 Hz envelope for the waveform window. Both the preview loop and the encoder read frames out of that same array with `getFrameData`.

### Export pipelines

`lib/encode.ts` tries three strategies in order, selected by capability probes rather than user-agent sniffing:

1. **WebCodecs** — `VideoEncoder` (H.264, `avc1.*`) + `AudioEncoder` (AAC `mp4a.40.2`), muxed by `mp4-muxer` with `fastStart: 'in-memory'` so the `moov` atom lands first and phones can play the file without downloading all of it. This is the fast path and the only one that beats realtime.
2. **MediaRecorder → MP4** — `canvas.captureStream(30)` plus a `MediaStreamAudioDestinationNode`, recorded directly to `video/mp4` where the browser supports it (Safari). Realtime, so the tab must stay visible.
3. **MediaRecorder → WebM → ffmpeg.wasm** — last resort. `lib/transcode.ts` loads the **single-threaded** ffmpeg core on purpose: the multi-threaded one needs `SharedArrayBuffer`, which would force COOP/COEP headers on the whole site.

`canExportMp4()` reports whether any pipeline is available, and the UI shows an honest warning when none is.

Bitrate is tiered by duration (`videoBitrateFor`) because the MP4 is assembled in memory; `MAX_DURATION_SECONDS` in `lib/audio.ts` is 180 for the same reason.

### Background music

The music feature deliberately stops at the edge of the encoder. `lib/mix.ts` renders voice + music down to **one** `AudioBuffer` in an `OfflineAudioContext` *before* `encodeVideo` is called, so all three export pipelines keep receiving a single buffer exactly as they did when there was only a voice track. Do not teach `lib/encode.ts` about music — extend the mix instead.

Two behaviours fall out of the graph rather than needing sample maths: the music source has `loop = true`, and the offline context is only as long as the voice, so a short track repeats and a long one is trimmed when the render ends. The `WaveShaperNode` on the master bus is a soft limiter that is dead linear below 0.7, so ordinary levels pass through untouched and voice-at-100% plus music cannot hard-clip the file.

`musicGainAt(elapsed, duration)` is the single definition of the fade envelope. The export bakes it in as `GainNode` linear ramps; the live preview applies the same function to the music `<audio>` element's volume on a 50 ms interval driven by the *voice* element's `currentTime` (an interval, not `requestAnimationFrame`, because audio keeps playing when the tab is hidden and rAF does not fire). If you change the curve, change it there and both follow.

The animation stays driven by the **voice** analysis, not the mix. Volume sliders therefore never trigger a re-analysis, and the bars keep tracking the speech rather than the music bed.

`lib/music.ts` owns the catalogue and the upload rules (20 MB; MP3/WAV/M4A/AAC, checked by extension *and* MIME type because Safari and Android pickers disagree about m4a and aac). The catalogue itself is `public/music/library.json`, next to the audio it describes.

Every built-in track is synthesised from oscillators by `scripts/generate-music.js` (`npm run music:build`) and released CC0 — there are no third-party recordings anywhere in the repo, which is the only reason the library can be shipped at all. The script level-matches tracks to a common RMS so switching in the picker does not jump in loudness, and checks that each loop's end joins its start without a click (`seamScore`); filters and drones inside it are written loop-aware for that reason. **Do not add commercial or copyrighted music**, and if you add a properly licensed third-party track, record its provenance in `public/music/LICENSE.md` — the `license` string in the JSON is shown to the user.

### Sharing

`lib/share.ts` probes `navigator.canShare({ files: [...] })` with a dummy `File` before offering the share button, and distinguishes a user-dismissed sheet (`AbortError`) from an actual failure. It also asks the question of the *real* file: if a one-byte stand-in is accepted but the actual MP4 is refused, the file itself is the problem, and the UI says the video is too large rather than blaming the browser.

`SharePanel` shows the finished MP4 in a `<video>` element plus one button per network. Every network button tries the OS share sheet with the file attached first, and only falls back to that network's web share page — which carries a link and text, never a file — when the browser cannot pass files to other apps. Because `window.open` loses its user activation after an `await`, `canShareFile()` is checked synchronously before any awaiting happens; the fallback also avoids `noopener` in the feature string, since that would make `window.open` return `null` and a blocked popup indistinguishable from a successful one.

**Do not add copy implying GLASKO can post to a social network by itself** — that would require each platform's official upload API and OAuth, neither of which is configured. The web share endpoints cannot carry a video at all, so any message about them must tell the user to attach the downloaded file themselves.

### Visitor counter

`app/api/visitors/route.ts` (GET reads, POST records) and `lib/visitors.ts` (browser half) are the only client/server pair in the app. The browser keeps a random id in `localStorage`; the row is upserted so a returning visitor bumps their own `visits` count and can never become a second unique visitor. A "visit" is one tab session, guarded by `sessionStorage`, so hammering refresh does not inflate the total.

Totals are derived, never stored: `SUM(visits)` is total visits and `COUNT(*)` is unique visitors. Nothing identifying is written — no IP, no user agent, no headers are read.

Every failure path resolves to `null` and `SiteFooter` then omits the counter line entirely. **Keep it that way**: the counter must never surface an error, and it must never fall back to a hardcoded number.

## Conventions

- Tailwind v4 is configured CSS-first in `app/globals.css` (`@theme`, `@layer`) via `@tailwindcss/postcss`. There is no `tailwind.config.*`; add design tokens to the `@theme` block.
- Fonts come from `next/font/google` and are exposed as CSS variables. Canvas text must not be given a raw `var(...)` string — `ctx.font` fails silently and falls back to 10px. `resolveFontStack()` in `app/page.tsx` resolves the variable through a probe element first.
- Mobile-first. The layout is a single column that becomes a two-column grid with a sticky preview at `lg`.
- No emoji in the UI; icons are inline SVG in `components/Icons.tsx`. The one exception is the flag in the footer's "Product of Bulgaria 🇧🇬", which is fixed wording.
- Deployment is Netlify via `@netlify/plugin-nextjs` (`netlify.toml`, publish `.next`). The `Permissions-Policy: microphone=(self)` header there is what lets the mic work on the deployed site.

## Database files

`db/schema.ts`, `db/index.ts`, `drizzle.config.ts` and `netlify/database/migrations/` back the visitor counter, which is the only thing GLASKO stores. The `posts` table is left over from the previous app that occupied this repository and is unused; it stays because **an applied migration must never be deleted, renamed, or edited** — doing so breaks the deploy. Correct an applied migration by rolling forward with a new one.

`db/index.ts` imports `./schema` without a `.js` extension: it is bundled by Next.js now, which resolves the TypeScript source directly and cannot follow the ESM-style extension. `drizzle()` throws when the database environment variable is missing, so the route handler imports the client with a dynamic `import()` inside a `try` — a missing database has to become a 503 at request time, not a broken build.

## Known limitations

- Export is CPU- and memory-bound in the browser. On the WebCodecs path a 60-second clip takes a few seconds; on the ffmpeg fallback it can take several times the clip length.
- The MediaRecorder paths record in realtime and stall if the tab is backgrounded, since `requestAnimationFrame` stops firing. The UI says to keep the tab visible.
- Audio is capped at 3 minutes and uploads at 60 MB; background-music uploads at 20 MB.
- No captions/subtitles, no trimming, no multi-track editing — by design. Background music is a single bed under the voice: no ducking, no beat sync, no per-section volume.
- No automatic posting to any platform, and no analytics or telemetry beyond the anonymous visit count in the footer.
- The per-network share buttons cannot upload a video from a web page. On desktop they save the MP4 and open the network's share page for the GLASKO link; the user attaches the file.
- A browser with `localStorage` blocked (Safari private browsing, cookies off) cannot be recognised on a later visit, so it counts as a new unique visitor each time. The visit is still recorded rather than dropped.
- GLASKO PRO is a placeholder: the badge, description and "Notify me" acknowledgement are all there is. No payments, prices, checkout or sign-up exist.
