# AGENTS.md

## Architecture

GLASKO is a single-screen Next.js 15 App Router app (TypeScript, Tailwind CSS v4) whose video pipeline runs entirely in the browser. Video never leaves the device, and audio only does so for one opt-in feature: subtitles, where slices of the voice are sent to a server route to be transcribed. Everything else — mixing, waveform analysis, rendering, encoding — happens in the tab.

- `app/page.tsx` is the only screen of the editor. It owns all state (audio source, background, animation, picture window and its artwork, headline, music selection and volumes, subtitle settings and cues, output format, watermark, export status, sharing) and composes the nine step panels plus the preview. It does **not** read the session: an account is additive, and the editor behaves identically signed in, signed out, or with Identity not enabled at all.
- `components/` holds the presentational pieces: `SourcePanel` (record/upload), `BackgroundPanel`, `AnimationPanel`, `PicturePanel`, `HeadlinePanel`, `MusicPanel`, `SubtitlePanel`, `FormatPanel`, `ExportPanel`, `SharePanel`, `SiteFooter`, `PreviewStage`, `Icons`, plus the account trio `AuthProvider`, `AuthCard` and `AccountNav`.
- `lib/` holds everything non-visual, and is where the real work lives (see below).
- `app/signup`, `app/login`, `app/forgot-password`, `app/reset-password` and `app/account` are the only routes other than the editor.
- `app/api/visitors/route.ts`, `app/api/transcribe/route.ts` and `app/api/translate/route.ts` are the only server endpoints.

The step order is the editing flow and is deliberate: voice → background → animation → picture window → topic → music → subtitles → format and branding → export → share. Nothing later in the list invalidates anything earlier, which is why a new recording is the one action that clears the transcript.

### The rendering contract

The whole design rests on one rule: **the preview and the exported video use the same draw call.** `drawFrame(ctx, frame, spec, frameIndex, scale)` in `lib/render.ts` always draws into the coordinate space of `spec.format` — 1080 × 1920, 1080 × 1080 or 1920 × 1080, from `lib/layout.ts` — and is scaled to fit whatever canvas it is given via `ctx.setTransform`. The preview passes a small scale; the encoder passes `1`. If you add a visual element, add it inside `drawFrame` — anything drawn elsewhere will appear in one and not the other, which is exactly the "it's only a mockup" failure this app is built to avoid. Subtitles and the watermark are drawn there for that reason, not composited over the preview.

### Branding

There is one logo file, `public/glasko-logo.png`, and it is used in all three places the mark appears: the page header (an `<img>` in `app/page.tsx`), the top-left of the video frame, and therefore the exported MP4. `lib/logo.ts` is the browser-side half — `loadBrandLogo()` decodes the file once per tab into a `BrandLogo` carrying the artwork *and its intrinsic size*, which is what the renderer derives the aspect ratio from, so replacing the PNG can never stretch it.

Drawing is synchronous and loading is not, so the logo reaches the renderer as `RenderSpec.logo` and `paintChrome` keeps the original drawn wordmark — three ascending bars plus tracked text — as the fallback for a frame painted before the file arrives, a blocked request, or a non-browser context. **That fallback is why the frame is never unbranded; do not delete it.** The in-frame position and size come from `layout.margin`, `layout.wordmarkY` and `layout.wordmarkSize` rather than pixel constants, so all three formats place the mark on the row and at the type scale the wordmark had.

The artwork is bone lettering with a gold waveform, made for a dark frame, so `tintedBrandLogo()` supplies a single-colour silhouette in `theme.fg` for the light backgrounds (Bone, Sandstone) — the same adaptation the text wordmark made when it read its colour from the theme. It reuses the file's own alpha channel, so only the colour changes.

The header logo and the in-frame logo are **not** the "Made with GLASKO" watermark, which stays a separate element owned by `lib/watermark.ts` and is still mandatory. Two marks in one frame is intentional: the logo is part of the design, the watermark is attribution.

`lib/layout.ts` is the single source of the three shapes and, through `layoutFor(format)`, of the safe area each one leaves for the platform's own buttons. Read positions out of it rather than hardcoding pixels: a subtitle block or watermark that is correct at 9:16 and clipped at 16:9 is the failure this file exists to prevent.

### The frame plan

Seven things now share the frame — logo row, headline, picture window, animation, progress line, subtitles, watermark — and none of them may touch. That is not enforced by eye or by per-format pixel tables. `planFrame` in `lib/render.ts` decides the whole arrangement **before anything is drawn**, in one fixed order, and each element is handed the boxes the earlier ones took:

1. The fixed chrome: the logo row and rule (`topChromeRect`), the animation stage (`stageRect`) and the watermark (`watermarkBox`). These do not move, so they go first.
2. The picture window, into the largest empty box anchored in the corner the user picked (`planPicture`, `lib/picture.ts`), searched against everything above and bounded by a band that stops short of the logo row and the progress rail.
3. The headline, into the topmost row that is left (`planHeadline`), re-wrapping and shrinking to fit the column and dropping below a corner element rather than squeezing in beside it.
4. The subtitles, carved against the window and the headline (`planSubtitles`, `carvePlacement`).
5. The progress rail and timings, which are the one piece of chrome that yields: `chromeShift` slides them up or down out of the subtitles' way, clamped by `chromeLimits` so they can neither rise into the picture window nor descend onto the watermark.

Two rules keep this honest. **Every value is a pure function of `(spec, elapsed)`** — the export renders frame 45 without having rendered frames 0 to 44, so a layout that depended on the previous frame would work in the preview and not in the file. And **elements yield in one direction only**: the mark, the logo and the motion never move for anything, the window shrinks or changes corner, the headline reflows, the subtitles carve, the rail shifts. Adding an element means giving it a place in that order, not adding a special case.

`frameBoxes(ctx, spec, elapsed)` returns the plan as named rectangles in the positions they are actually drawn, which is what makes the no-overlap requirement testable rather than aspirational: `npm run layout:check` (`scripts/check-frame-layout.mjs`) walks 28,860 combinations of format, motion, window corner and size, headline treatment, subtitle mode / position / style and watermark corner, at two moments each, and fails if any two boxes share a pixel, if anything leaves the frame or its safe area, if the watermark is ever missing, or if the headline is dropped from a frame that had room for it. Add a case there rather than loosening a tolerance. Anything new that is drawn in `drawFrame` needs a box in `frameBoxes`, or it is outside the guarantee.

### Picture window and headline

`lib/picture.ts` and `lib/headline.ts` own the two optional in-frame elements, and both are off by default.

The window is never given a position in pixels — only a corner, a size step and a shape. `planPicture` finds the space; `cornerSpace` scores each corner so a full corner costs less than a squeezed window, and `fallbackOrder` is what lets it move when the chosen corner genuinely cannot hold it. That is why the same settings look right at 9:16, 1:1 and 16:9 without three sets of numbers, and why "does not cover the logo / subtitles / watermark" is structural: those are inputs to the search, not checks afterwards. The artwork is cover-fitted into a square box and clipped, so nothing is ever stretched and Circle is a true circular crop. `pictureSizes` in `lib/layout.ts` is per format because the clear band differs — the square steps are deliberately small, and a tight corner clamping Larger to the same window as Medium is documented behaviour, not a bug.

The headline is measured from the **whole** text even mid-typewriter, so the panel does not grow as letters arrive, and `headlineIntro` resolves all four treatments to numbers from `elapsed` alone. Slide In's `offset` is a *fraction* of whatever travel the frame can spare, multiplied by `HeadlinePlan.slide`, which is zero when the window sits against the leading edge: nothing is allowed to move across the artwork. Anything that can contain Bulgarian is set in `fonts.sans` (Inter) for the same reason the subtitles are.

### Motion

Animation data is shared the same way the draw call is. `lib/analysis.ts` precomputes, once per audio file, a per-frame amplitude level, 40 log-spaced frequency bands (via a hand-rolled radix-2 FFT — `AnalyserNode` is useless here because export runs faster than realtime), and a 240 Hz envelope for the waveform window. Both the preview loop and the encoder read frames out of that same array with `getFrameData`.

The four motion modes all read that one array. Waveform and Audio Bars are deliberately small and inset — they lost roughly half their height and no longer span the frame, which is what frees the column the picture window is placed into — and the smoothing in them runs *along* each frame, never between frames, for the determinism reason above. **Minimal Pulse** is the quiet end of the same scale: one thin line at `PULSE_SCALE` of the stage and `PULSE_OPACITY` (about 30%), which is the whole point of it, so do not "fix" the faintness. `none` stays a real choice rather than an absence. Do not remove a mode.

### Export pipelines

`lib/encode.ts` tries three strategies in order, selected by capability probes rather than user-agent sniffing:

1. **WebCodecs** — `VideoEncoder` (H.264, `avc1.*`) + `AudioEncoder` (AAC `mp4a.40.2`), muxed by `mp4-muxer` with `fastStart: 'in-memory'` so the `moov` atom lands first and phones can play the file without downloading all of it. This is the fast path and the only one that beats realtime.
2. **MediaRecorder → MP4** — `canvas.captureStream(30)` plus a `MediaStreamAudioDestinationNode`, recorded directly to `video/mp4` where the browser supports it (Safari). Realtime, so the tab must stay visible.
3. **MediaRecorder → WebM → ffmpeg.wasm** — last resort. `lib/transcode.ts` loads the **single-threaded** ffmpeg core on purpose: the multi-threaded one needs `SharedArrayBuffer`, which would force COOP/COEP headers on the whole site.

`canExportMp4()` reports whether any pipeline is available, and the UI shows an honest warning when none is.

**No pipeline may return a file it has not proved carries audible audio.** A silent export is the one failure that looks like a success — it downloads, it plays, and the voice is just gone — so every route checks its own sound before handing the blob back, and then the bytes get the last word. The WebCodecs path counts the AAC packets that reached the muxer, insists on the decoder description they need to be playable (mp4-muxer writes an empty `esds` if it is missing, which produces a file that plays silently rather than an error), and checks the track covers at least `MIN_AUDIO_COVERAGE` of the clip — a track that stops halfway means a video that goes quiet mid-sentence. The MediaRecorder paths refuse to record a stream that has no audio track in it and refuse to start against a suspended `AudioContext`, since either one captures perfect silence. On top of all of that, `verifyExportedAudio()` **decodes the finished file back to samples** and measures peak and RMS against a silence floor, falling back to scanning for the container's own audio codec signature when the file is too large or the browser cannot decode what it just wrote. The result travels with the file as `EncodeResult.audio` and is stated in the UI. A failed check falls through to the next pipeline, and if none of them can produce sound the export fails with a message saying so.

Two config values are the reason a video that plays in the browser can arrive silent on Facebook or Instagram, and both now come from one place. `lib/mix.ts` always hands the encoder a **stereo** buffer (`MIX_CHANNELS`) at a rate those platforms accept — 48 kHz, or 44.1 kHz left alone if that is what the voice already was (`PLATFORM_SAMPLE_RATE`, `ACCEPTED_SAMPLE_RATES`) — and `lib/encode.ts` fixes `EXPORT_CHANNELS` at 2 to match, duplicating a mono buffer across both channels rather than narrowing the file. Those transcoders are far less tolerant than a browser, and a mono track at an unexpected rate is where the silence comes from. Keep new work inside that rule: audio-carrying config values must come from one source of truth shared by the encoder, the samples and the muxer's track header, because a header that disagrees with its own samples is decoded as silence.

Frame size comes from `spec.format`, so the same three pipelines produce 1080 × 1920, 1080 × 1080 or 1920 × 1080 without knowing which. Bitrate is tiered by duration (`videoBitrateFor`) because the MP4 is assembled in memory; `MAX_DURATION_SECONDS` in `lib/audio.ts` is 180 for the same reason.

### Background music

The music feature deliberately stops at the edge of the encoder. `lib/mix.ts` renders voice + music down to **one** `AudioBuffer` in an `OfflineAudioContext` *before* `encodeVideo` is called, so all three export pipelines keep receiving a single buffer exactly as they did when there was only a voice track. Do not teach `lib/encode.ts` about music — extend the mix instead.

Two behaviours fall out of the graph rather than needing sample maths: the music source has `loop = true`, and the offline context is only as long as the voice, so a short track repeats and a long one is trimmed when the render ends. The `WaveShaperNode` on the master bus is a soft limiter that is dead linear below 0.7, so ordinary levels pass through untouched and voice-at-100% plus music cannot hard-clip the file.

`musicGainAt(elapsed, duration)` is the single definition of the fade envelope, and `duckGainAt(envelope, elapsed)` the single definition of the sidechain that keeps the voice on top. The export bakes both in as one `setValueCurveAtTime` automation on the music gain; the live preview multiplies the same two functions into the music `<audio>` element's volume on a 50 ms interval driven by the *voice* element's `currentTime` (an interval, not `requestAnimationFrame`, because audio keeps playing when the tab is hidden and rAF does not fire). If you change either curve, change it there and both follow.

Voice priority is not left to the sliders. `buildDuckEnvelope(voice)` measures where speech actually is and pulls the bed down under it, and `effectiveMusicLevel(musicVolume, voiceVolume)` caps the bed relative to the voice so no slider combination can bury the speaker. The page builds the envelope once and passes it to `mixAudio` as `duck`, so the preview and the file cannot drift apart.

The animation stays driven by the **voice** analysis, not the mix. Volume sliders therefore never trigger a re-analysis, and the bars keep tracking the speech rather than the music bed.

`lib/music.ts` owns the catalogue and the upload rules (20 MB; MP3/WAV/M4A/AAC, checked by extension *and* MIME type because Safari and Android pickers disagree about m4a and aac). The catalogue itself is `public/music/library.json`, next to the audio it describes.

Every built-in track is synthesised from oscillators by `scripts/generate-music.js` (`npm run music:build`) and released CC0 — there are no third-party recordings anywhere in the repo, which is the only reason the library can be shipped at all. The script level-matches tracks to a common RMS so switching in the picker does not jump in loudness, and checks that each loop's end joins its start without a click (`seamScore`); filters and drones inside it are written loop-aware for that reason. **Do not add commercial or copyrighted music**, and if you add a properly licensed third-party track, record its provenance in `public/music/LICENSE.md` — the `license` string in the JSON is shown to the user.

The picker auditions tracks through one `<audio>` element owned by the page, driven by the id the panel highlights, so the button state and what you hear cannot disagree; starting an audition stops the main preview and vice versa. "No music" is a card of its own rather than only a remove button, because voice-only should be visibly a choice.

### Subtitles

`lib/subtitles.ts` owns the cue model, the five styles and the drawing. A `SubtitleCue` always carries **both** languages (`bg` and `en`), and `SubtitleSettings.mode` (`'none' | 'bg' | 'en' | 'both'`) only decides which of them is drawn — so switching mode is free, and the only expensive transition is into a mode whose language the cues do not have yet. `modeNeedsLanguage(cues, language)` is the test for that, and the page answers it by translating rather than by drawing blanks.

`lib/transcribe.ts` is the browser half. It cuts the voice into ~40 s slices **at the quietest point** in the 240 Hz envelope `lib/analysis.ts` already computed — a boundary through the middle of a word costs a word — renders each slice to mono 16 kHz through an `OfflineAudioContext`, and uploads them one at a time, awaiting between slices so the interface keeps painting. Errors arrive as `SubtitleError` with a `code`, which is what lets the panel show the not-configured case as a calm setup message instead of a failure.

`app/api/transcribe/route.ts` and `app/api/translate/route.ts` are the server half, and they exist **only** so the key stays on the server. `lib/server/ai.ts` reads `GEMINI_API_KEY` (and optionally `GOOGLE_GEMINI_BASE_URL`) from the environment and calls Gemini directly with `x-goog-api-key`. Netlify's AI Gateway has no speech-to-text model, which is why this one provider is called by hand rather than through the gateway. **Never move a key, or a call that carries one, into the client** — no `NEXT_PUBLIC_` variable, no key in a fetch from the browser, and never a placeholder key committed to the repo. A missing key must stay a 503 with `code: 'not-configured'`, which the rest of GLASKO ignores: subtitles are the only feature that stops working.

Subtitles are drawn inside `drawFrame`, at most two lines at a time, inside the format's safe area, in a font with Cyrillic in it. That last point is not optional: all three of the original display faces are `subsets: ['latin']`, so Bulgarian would render as fallback glyphs *in the exported file*. Inter is loaded with `['latin', 'cyrillic']` and exposed as `--font-caption`, and `resolveFontStack` in `app/page.tsx` turns it into the concrete stack `ctx.font` needs.

`lib/align.ts` is why the text lands on the word. Model timings are a first guess — a model reading a clip reports a cue a beat after the words it heard — so `alignCuesToSpeech` treats the recording as the source of truth instead: it reads speech runs out of the same 240 Hz envelope the waveform animation uses, finds the one shift (and, on a long clip with enough matches, the one clock-rate correction) that best lines the cues up with them by intersection-over-union, and then snaps each cue onto the onset it belongs to. **Nothing in there is a fixed delay**, and it must stay that way: every number is measured from the recording in front of it, a clip whose cues are already in time comes back with `shift` 0 and `scale` 1, and audio with no usable dynamics is left alone rather than guessed at. It runs once, inside `transcribeVoice`, before the cues reach the page — which is what makes the preview, the exported MP4 and the `.srt` / `.vtt` sidecars agree, since all three read one aligned array and neither the renderer nor the encoder knows the step happened. Timings are also language-independent by construction: `translateCues` only fills in text, so `bg`, `en` and `both` draw at identical times. `npm run subtitles:check` proves all of that against synthetic recordings with known onsets — late cues, jittery cues, drifting clocks, unbroken speech, a noisy room, short and long clips — and is the place to add a case rather than trimming a tolerance.

### Watermark

`lib/watermark.ts` owns the "Made with GLASKO" mark: the wording, the four corners and the defaults. `watermarkFor(settings, pro = false)` is the **only** place the mark is switched off, and it is written that way on purpose — a GLASKO PRO account removing the watermark should be one argument here, not a change spread across the renderer. Nothing calls it with `true`: accounts exist, a plan to check does not. The mark is drawn in `drawFrame`, so it is in the exported MP4 and not only in the editor, and it is passed into `planFrame` as a box every other element has to avoid, so it cannot be covered either.

### Accounts

Accounts are Netlify Identity (`@netlify/identity`), and they are **additive**. `app/page.tsx` does not read the session at all: signed in, signed out, or Identity not enabled on the deployment, every step of the video pipeline behaves the same, and nothing about a video is attached to a user. No audio, image or MP4 is uploaded or stored, and there is **no database table for users** — Identity holds the credentials, hashes them, issues the JWT and sends the confirmation and recovery mail.

`lib/auth.ts` is deliberately the only code around it: field validation, one sentence of wording per failure, and the account date. Two rules there are not stylistic. A failed login never says which half was wrong, because saying so tells an attacker which addresses have accounts. And `MissingIdentityError` is not a failure — it gets the same calm setup message the subtitles panel gives a missing key, since the editor works without it. **A password must never be stored, logged, put in a URL or written to `localStorage`**: it goes from the input straight into the Identity call. If you add a field to those forms, keep that property.

`components/AuthProvider.tsx` sits in the root layout rather than on the auth routes, because confirmation, recovery and invite links come back as a URL *hash* on whatever page the link opened — normally the editor — so `handleAuthCallback()` has to run there. `status` starts as `'loading'` and `AccountNav` renders nothing for the account until it resolves, so a signed-in visitor never sees a "Log in" button flash first.

The feature is enabled on deploy by the `netlify-identity` skill's activation script, which is why `.netlify/features/netlify-identity` exists. Identity's own settings (open vs invite-only registration, email confirmation) are project configuration, not code. There is no social login, no plan, no payment code and no profile beyond name, email and creation date — keep it that way unless asked.


### Sharing

`lib/share.ts` probes `navigator.canShare({ files: [...] })` with a dummy `File` before offering the share button, and distinguishes a user-dismissed sheet (`AbortError`) from an actual failure. It also asks the question of the *real* file: if a one-byte stand-in is accepted but the actual MP4 is refused, the file itself is the problem, and the UI says the video is too large rather than blaming the browser.

`SharePanel` shows the finished MP4 in a `<video>` element and offers exactly three controls: **Share video**, which hands the real file to the OS share sheet, **Download MP4**, and **Copy GLASKO link**. There are deliberately **no per-network buttons**. A web share endpoint cannot carry a video file, so a Facebook, Instagram or TikTok button here could only ever open a page with a link in it — which looks like posting the video and is not. Where the browser cannot pass a file to another app, Share saves the MP4 and says so.

**Do not add copy implying GLASKO can post to a social network by itself** — that would require each platform's official upload API and OAuth, neither of which is configured. Any message about sharing must leave the upload with the user.

`buildFilename('mp4')` produces `glasko-video-YYYY-MM-DD.mp4` from the local date, and the same helper names the `.srt` and `.vtt` downloads.


### Visitor counter

`app/api/visitors/route.ts` (GET reads, POST records) and `lib/visitors.ts` (browser half) are the visitor counter. The browser keeps a random id in `localStorage`; the row is upserted so a returning visitor bumps their own `visits` count and can never become a second unique visitor. A "visit" is one tab session, guarded by `sessionStorage`, so hammering refresh does not inflate the total.

Totals are derived, never stored: `SUM(visits)` is total visits and `COUNT(*)` is unique visitors. Nothing identifying is written — no IP, no user agent, no headers are read.

Every failure path resolves to `null` and `SiteFooter` then omits the counter line entirely. **Keep it that way**: the counter must never surface an error, and it must never fall back to a hardcoded number.

## Conventions

- Tailwind v4 is configured CSS-first in `app/globals.css` (`@theme`, `@layer`) via `@tailwindcss/postcss`. There is no `tailwind.config.*`; add design tokens to the `@theme` block.
- Fonts come from `next/font/google` and are exposed as CSS variables. Canvas text must not be given a raw `var(...)` string — `ctx.font` fails silently and falls back to 10px. `resolveFontStack()` in `app/page.tsx` resolves the variable through a probe element first. Anything that can contain Bulgarian must use `--font-caption` (Inter, latin + cyrillic); the display faces are Latin-only.
- Server-side keys are read from `process.env` inside `lib/server/ai.ts` or a route handler, never from a component. There is no `NEXT_PUBLIC_` key in this app and there must not be one.
- Mobile-first. The layout is a single column that becomes a two-column grid with a sticky preview at `lg`.
- Long work is reported, never blocking: transcription, translation and encoding all run against an `AbortController` with a progress callback, and the panels show a named stage ("Preparing audio", "Generating subtitles", "Translating subtitles", "Rendering video", "Preparing MP4", "Ready to share") plus a cancel button.
- No emoji in the UI; icons are inline SVG in `components/Icons.tsx`. The one exception is the flag in the footer's "Product of Bulgaria 🇧🇬", which is fixed wording.
- Two checks run without a browser, through `scripts/ts-resolve.mjs`, which lets plain `node` import the app's `.ts` modules: `npm run subtitles:check` (cue timing against synthetic recordings) and `npm run layout:check` (every element's box against every other, across all three formats). Run both after touching `lib/render.ts`, `lib/layout.ts`, `lib/picture.ts`, `lib/headline.ts`, `lib/align.ts` or `lib/analysis.ts`, along with `npm run typecheck`.
- Deployment is Netlify via `@netlify/plugin-nextjs` (`netlify.toml`, publish `.next`). The `Permissions-Policy: microphone=(self)` header there is what lets the mic work on the deployed site.

## Database files

`db/schema.ts`, `db/index.ts`, `drizzle.config.ts` and `netlify/database/migrations/` back the visitor counter, which is the only thing GLASKO stores — accounts included: Identity keeps its own users, so adding sign-in added no table and no migration. The `posts` table is left over from the previous app that occupied this repository and is unused; it stays because **an applied migration must never be deleted, renamed, or edited** — doing so breaks the deploy. Correct an applied migration by rolling forward with a new one.

`db/index.ts` imports `./schema` without a `.js` extension: it is bundled by Next.js now, which resolves the TypeScript source directly and cannot follow the ESM-style extension. `drizzle()` throws when the database environment variable is missing, so the route handler imports the client with a dynamic `import()` inside a `try` — a missing database has to become a 503 at request time, not a broken build.

## Known limitations

- Export is CPU- and memory-bound in the browser. On the WebCodecs path a 60-second clip takes a few seconds; on the ffmpeg fallback it can take several times the clip length.
- The MediaRecorder paths record in realtime and stall if the tab is backgrounded, since `requestAnimationFrame` stops firing. The UI says to keep the tab visible.
- Audio is capped at 3 minutes and uploads at 60 MB; background-music uploads at 20 MB.
- No trimming and no multi-track editing — by design. Background music is a single bed under the voice: it fades and ducks under speech, but there is no beat sync and no per-section volume.
- Subtitles need `GEMINI_API_KEY` in the Netlify environment. Without it the panel shows a setup message and every other feature works unchanged. Transcription is the one thing that sends audio off the device, and it sends the voice only — never the music or the video.
- Subtitle cue timings are aligned to the speech in the recording (`lib/align.ts`), so a cue appears on the word rather than behind it. What alignment cannot fix is *which* words a cue covers: the split points are still the model's, so fast or overlapping speech can group a phrase oddly, and a passage with no pauses in it can only be corrected as a whole rather than cue by cue. The cue text is editable before rendering; the timings are not.
- No automatic posting to any platform, and no analytics or telemetry beyond the anonymous visit count in the footer.
- Sharing can only hand the MP4 to the device's own share sheet. Where that is unavailable (most desktop browsers), the file is downloaded and the user uploads it themselves.
- A browser with `localStorage` blocked (Safari private browsing, cookies off) cannot be recognised on a later visit, so it counts as a new unique visitor each time. The visit is still recorded rather than dropped.
- Accounts do nothing yet beyond existing. There is no plan, no payment, no profile photo, no email change and nothing in an account that affects a video; a new sign-up must confirm by email if the project's Identity settings say so, and registration is open until set to invite-only there. The editor is complete without an account and must stay that way.
- The picture window respects the chosen corner *whenever it can*. Where a corner is genuinely full it shrinks, and only if it still cannot fit does it move to another corner — so Size and Position are preferences the layout honours, not guarantees. In the square format the three size steps are close together, and a tight corner can clamp Larger to the same window as Medium.
- A long topic on a frame that also has a large window in a top corner is set smaller, or dropped to the row below the window. If there is no readable row left above the animation, that frame leaves the headline out rather than drawing it over something else.
- Minimal Pulse is faint on purpose (about 30% opacity). On a busy photographic background it reads as a suggestion of movement rather than a visible waveform.
- GLASKO PRO is a placeholder: the badge, description and "Notify me" acknowledgement are all there is. No payments, prices or checkout exist. The watermark is the one feature already wired for it, through `watermarkFor(settings, pro)`.
- There is no Contact or Support section, and no support email anywhere in the app. That is a deliberate hold, not an oversight — do not add one until asked.
