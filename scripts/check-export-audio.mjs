/**
 * Exported-audio verification check — `npm run export:check`.
 *
 * A GLASKO export used to be able to finish, download, play, and be completely silent.
 * The check that was meant to prevent that looked for the string `mp4a` in the finished
 * file and, failing that, asked the browser to decode it — and both halves were built to
 * fail open. `mp4a` is in the sample description of a silent track just as it is in a
 * good one, and a browser that could not decode its own output reported `undecodable`
 * while still claiming the audio was verified. So the one failure the whole export
 * pipeline is written around was the one the verifier waved through.
 *
 * There is no browser here, so this drives the real `mp4-muxer` with the exact options
 * `lib/encode.ts` gives it, writes tracks whose contents are known in advance, and asserts
 * that `lib/mp4probe.ts` reads the bytes back correctly and that `judgeMp4Audio` rejects
 * every shape of file that would arrive silent:
 *
 *  - a healthy stereo AAC-LC track at 48 kHz and at 44.1 kHz;
 *  - a track of digital silence, whose frames are too small to hold signal;
 *  - a mono track, which platform transcoders turn into silence;
 *  - a track at a sample rate outside the accepted pair;
 *  - a track that stops halfway through the clip;
 *  - a header that disagrees with its own decoder configuration;
 *  - a file with no audio track at all, and one that is not an MP4.
 *
 * The last section leaves the container behind and checks the rule itself: that no proof
 * whose sound was never actually heard is ever accepted, whatever its `audible` flag says,
 * and that a WebCodecs file the browser cannot decode falls through instead of being
 * approved on its box structure.
 *
 * Add a case here rather than loosening a bound in `judgeMp4Audio`.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { audioProved, describeAudioProof, PIPELINES } from '../lib/encode.ts';
import {
  judgeMp4Audio,
  probeMp4Audio,
  SILENT_FRAME_BYTES,
  AAC_LC_OBJECT_TYPE,
} from '../lib/mp4probe.ts';
import { createPreviewWav } from '../lib/preview-audio.ts';

/** Matches `MIN_AUDIO_COVERAGE` in lib/encode.ts. Asserted, not imported. */
const MIN_AUDIO_COVERAGE = 0.9;
/** Matches `ACCEPTED_SAMPLE_RATES` in lib/mix.ts. */
const ACCEPTED_SAMPLE_RATES = [48_000, 44_100];
/** Matches `EXPORT_CHANNELS` in lib/encode.ts. */
const EXPORT_CHANNELS = 2;

const FPS = 30;
/** Samples per AAC-LC frame. */
const AAC_FRAME_SAMPLES = 1024;
/** Bytes an AAC-LC frame of real speech costs at 128 kbps stereo. */
const SPEECH_FRAME_BYTES = 340;
/** Bytes an AAC-LC frame of digital zeroes costs. */
const SILENT_AAC_FRAME_BYTES = 11;

let failures = 0;
let checks = 0;

function ok(condition, label, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

section('Preview uses a playable WAV made from the decoded voice');
{
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1]);
  const preview = createPreviewWav({
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: 48_000,
    getChannelData: () => samples,
  });
  const bytes = new Uint8Array(await preview.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));

  ok(preview.type === 'audio/wav', 'the browser is handed audio/wav');
  ok(ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE', 'the RIFF/WAVE header is valid');
  ok(view.getUint16(20, true) === 1, 'the file is uncompressed PCM');
  ok(view.getUint16(22, true) === 1, 'the phone-friendly preview is mono');
  ok(view.getUint32(24, true) === 48_000, 'the decoded sample rate is preserved');
  ok(view.getUint32(40, true) === samples.length * 2, 'every decoded sample is present');
  ok(view.getInt16(44, true) < -32_000, 'audible negative samples survive');
  ok(view.getInt16(52, true) > 32_000, 'audible positive samples survive');
}

// --- building files the muxer really wrote ---------------------------------

/**
 * The two-byte AudioSpecificConfig a browser's AAC encoder hands over for AAC-LC.
 *
 * Five bits of object type, four of sample-rate index, four of channel configuration.
 * Built rather than hardcoded so a wrong sample rate produces a genuinely wrong config
 * instead of a plausible-looking constant.
 */
function audioSpecificConfig(sampleRate, channels, objectType = AAC_LC_OBJECT_TYPE) {
  const indices = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
  ];
  const index = indices.indexOf(sampleRate);
  if (index < 0) throw new Error(`no AudioSpecificConfig index for ${sampleRate} Hz`);
  let bits = '';
  bits += objectType.toString(2).padStart(5, '0');
  bits += index.toString(2).padStart(4, '0');
  bits += channels.toString(2).padStart(4, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 8) bytes[i / 8] = parseInt(bits.slice(i, i + 8), 2);
  return bytes;
}

/** An AVCDecoderConfigurationRecord just well-formed enough for the muxer to write it. */
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);

/**
 * Mux one MP4 with the same muxer options `encodeWithWebCodecs` uses.
 *
 * `opts.frameBytes` is what decides whether the audio track reads as speech or as
 * silence; `opts.audioSeconds` is how far it reaches; `opts.asc` lets a test write a
 * decoder configuration that disagrees with the track header, and `opts.describe: false`
 * withholds the encoder's configuration altogether so the muxer has to invent one.
 */
function muxFile({
  seconds,
  sampleRate = 48_000,
  channels = EXPORT_CHANNELS,
  frameBytes = SPEECH_FRAME_BYTES,
  audioSeconds = seconds,
  asc = null,
  withAudio = true,
  describe = true,
}) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width: 1080, height: 1920, frameRate: FPS },
    ...(withAudio ? { audio: { codec: 'aac', numberOfChannels: channels, sampleRate } } : {}),
  });

  if (withAudio) {
    const meta = describe
      ? {
          decoderConfig: {
            codec: 'mp4a.40.2',
            sampleRate,
            numberOfChannels: channels,
            description: asc ?? audioSpecificConfig(sampleRate, channels),
          },
        }
      : undefined;
    const frames = Math.floor((audioSeconds * sampleRate) / AAC_FRAME_SAMPLES);
    const frameMicroseconds = (AAC_FRAME_SAMPLES / sampleRate) * 1_000_000;
    for (let i = 0; i < frames; i++) {
      // Sizes vary the way a real encoder's do, so the probe's "largest frame" reading is
      // exercised rather than handed a constant.
      const size = Math.max(1, Math.round(frameBytes * (0.8 + 0.4 * ((i % 7) / 6))));
      muxer.addAudioChunkRaw(
        new Uint8Array(size).fill(0x21),
        'key',
        Math.round(i * frameMicroseconds),
        Math.round(frameMicroseconds),
        i === 0 && describe ? meta : undefined,
      );
    }
  }


  const videoFrames = Math.round(seconds * FPS);
  for (let i = 0; i < videoFrames; i++) {
    muxer.addVideoChunkRaw(
      new Uint8Array(600).fill(0x41),
      i % (FPS * 2) === 0 ? 'key' : 'delta',
      Math.round((i / FPS) * 1_000_000),
      Math.round(1_000_000 / FPS),
      i === 0 ? { decoderConfig: { codec: 'avc1.640028', description: AVCC } } : undefined,
    );
  }

  muxer.finalize();
  return new Uint8Array(target.buffer);
}

const judge = (bytes, expectedSeconds) =>
  judgeMp4Audio(
    probeMp4Audio(bytes),
    expectedSeconds,
    MIN_AUDIO_COVERAGE,
    ACCEPTED_SAMPLE_RATES,
    EXPORT_CHANNELS,
  );

// --- the checks -----------------------------------------------------------

console.log('Exported MP4 audio verification\n===============================');

section('A healthy stereo AAC-LC export is read correctly');
for (const sampleRate of ACCEPTED_SAMPLE_RATES) {
  const bytes = muxFile({ seconds: 10, sampleRate });
  const probe = probeMp4Audio(bytes);
  const track = probe.track;
  ok(probe.parsed, `${sampleRate} Hz — the file parses as an MP4`);
  ok(probe.hasVideo, `${sampleRate} Hz — the video track is found`);
  ok(Boolean(track), `${sampleRate} Hz — the audio track is found`);
  ok(track?.format === 'mp4a', `${sampleRate} Hz — the sample format is mp4a`, track?.format);
  ok(track?.channels === 2, `${sampleRate} Hz — the header says stereo`, String(track?.channels));
  ok(
    track?.sampleRate === sampleRate,
    `${sampleRate} Hz — the header sample rate is read back exactly`,
    String(track?.sampleRate),
  );
  ok(track?.asc.present === true, `${sampleRate} Hz — an esds decoder configuration is present`);
  ok(
    track?.asc.objectType === AAC_LC_OBJECT_TYPE,
    `${sampleRate} Hz — the decoder configuration says AAC-LC`,
    String(track?.asc.objectType),
  );
  ok(
    track?.asc.sampleRate === sampleRate && track?.asc.channels === 2,
    `${sampleRate} Hz — the decoder configuration agrees with the header`,
    `${track?.asc.sampleRate} Hz / ${track?.asc.channels}ch`,
  );
  ok(
    Math.abs((track?.seconds ?? 0) - 10) < 0.1,
    `${sampleRate} Hz — the track duration is ~10s`,
    (track?.seconds ?? 0).toFixed(3),
  );
  ok(
    (track?.maxSampleBytes ?? 0) > SILENT_FRAME_BYTES,
    `${sampleRate} Hz — frames are far larger than the silence floor`,
    String(track?.maxSampleBytes),
  );
  ok(judge(bytes, 10).ok, `${sampleRate} Hz — the verdict accepts it`, judge(bytes, 10).reason ?? '');
}

section('A silent track is rejected even though the container says mp4a');
{
  const bytes = muxFile({ seconds: 10, frameBytes: SILENT_AAC_FRAME_BYTES });
  const probe = probeMp4Audio(bytes);
  // The exact false positive the old check produced: the signature is there.
  const text = Buffer.from(bytes).toString('latin1');
  ok(text.includes('mp4a'), 'the file does contain the string "mp4a"');
  ok(probe.track !== null, 'the audio track is found');
  ok(
    (probe.track?.maxSampleBytes ?? 999) <= SILENT_FRAME_BYTES,
    'every frame is at or below the silence floor',
    String(probe.track?.maxSampleBytes),
  );
  const verdict = judge(bytes, 10);
  ok(!verdict.ok, 'the verdict rejects it');
  ok(/silence/.test(verdict.reason ?? ''), 'the reason names silence', verdict.reason ?? '');
}

section('A mono track is rejected');
{
  const bytes = muxFile({ seconds: 10, channels: 1 });
  const verdict = judge(bytes, 10);
  ok(probeMp4Audio(bytes).track?.channels === 1, 'the probe reads one channel');
  ok(!verdict.ok, 'the verdict rejects it');
  ok(/stereo/.test(verdict.reason ?? ''), 'the reason names stereo', verdict.reason ?? '');
}

section('An unusual sample rate is rejected');
{
  const bytes = muxFile({ seconds: 10, sampleRate: 32_000 });
  const verdict = judge(bytes, 10);
  ok(probeMp4Audio(bytes).track?.sampleRate === 32_000, 'the probe reads 32 kHz');
  ok(!verdict.ok, 'the verdict rejects it');
  ok(/32000 Hz/.test(verdict.reason ?? ''), 'the reason names the rate', verdict.reason ?? '');
}

section('A track that stops early is rejected');
{
  // Half the clip: the "goes quiet mid-sentence" export.
  const bytes = muxFile({ seconds: 48, audioSeconds: 24 });
  const verdict = judge(bytes, 48);
  ok(!verdict.ok, 'half-length audio is rejected');
  ok(/of an expected/.test(verdict.reason ?? ''), 'the reason names the shortfall', verdict.reason ?? '');

  // Just inside the tolerance: an encoder tail is not a bug.
  const trimmed = muxFile({ seconds: 48, audioSeconds: 47.6 });
  ok(judge(trimmed, 48).ok, 'a track a fraction short is still accepted', judge(trimmed, 48).reason ?? '');
}

section('A decoder configuration that disagrees with the header is rejected');
{
  // The header says 48 kHz stereo; the esds says 44.1 kHz. Players decode this as silence.
  const bytes = muxFile({ seconds: 10, asc: audioSpecificConfig(44_100, 2) });
  const verdict = judge(bytes, 10);
  ok(!verdict.ok, 'the mismatch is rejected');
  ok(
    /decoder configuration says/.test(verdict.reason ?? ''),
    'the reason names the disagreement',
    verdict.reason ?? '',
  );

  // And an object type that is not AAC-LC.
  const hev = muxFile({ seconds: 10, asc: audioSpecificConfig(48_000, 2, 5) });
  const heVerdict = judge(hev, 10);
  ok(!heVerdict.ok, 'a non-AAC-LC object type is rejected');
  ok(/AAC-LC/.test(heVerdict.reason ?? ''), 'the reason names AAC-LC', heVerdict.reason ?? '');
}

section('Without the encoder’s description the muxer invents one');
{
  // This is what the WebCodecs route guards against by requiring a description. Given
  // none, mp4-muxer reconstructs the esds from the track config it was handed: right at
  // a rate the AAC table has, and wrong at any other — where it names object type 1 at
  // 88.2 kHz while the header says something else, which is decoded as silence.
  const guessed = muxFile({ seconds: 10, describe: false });
  const guessedTrack = probeMp4Audio(guessed).track;
  ok(guessedTrack?.asc.present === true, 'at 48 kHz a configuration is still written');
  ok(
    guessedTrack?.asc.objectType === AAC_LC_OBJECT_TYPE && guessedTrack?.asc.sampleRate === 48_000,
    'and it happens to agree with the header',
    `object type ${guessedTrack?.asc.objectType} at ${guessedTrack?.asc.sampleRate} Hz`,
  );

  const invented = muxFile({ seconds: 10, sampleRate: 47_999, describe: false });
  const inventedTrack = probeMp4Audio(invented).track;
  ok(
    inventedTrack?.asc.sampleRate !== inventedTrack?.sampleRate,
    'at an off-list rate the invented configuration disagrees with the header',
    `header ${inventedTrack?.sampleRate} Hz, esds ${inventedTrack?.asc.sampleRate} Hz object type ${inventedTrack?.asc.objectType}`,
  );
  const verdict = judge(invented, 10);
  ok(!verdict.ok, 'and the verdict rejects it', verdict.reason ?? '');
}

section('A file with no audio track at all is rejected');
{
  const bytes = muxFile({ seconds: 10, withAudio: false });
  const probe = probeMp4Audio(bytes);
  ok(probe.parsed, 'the file still parses');
  ok(probe.hasVideo, 'the video track is found');
  ok(probe.track === null, 'no audio track is found');
  const verdict = judge(bytes, 10);
  ok(!verdict.ok, 'the verdict rejects it');
  ok(/no audio track/.test(verdict.reason ?? ''), 'the reason says so', verdict.reason ?? '');
}

section('Rubbish in is a rejection, not an exception');
for (const [label, bytes] of [
  ['an empty file', new Uint8Array(0)],
  ['random bytes', new Uint8Array(4096).fill(0x5a)],
  ['a WebM file', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(512).fill(0)])],
  ['a truncated MP4', muxFile({ seconds: 10 }).slice(0, 64)],
]) {
  let verdict;
  let threw = false;
  try {
    verdict = judge(bytes, 10);
  } catch {
    threw = true;
  }
  ok(!threw, `${label} — the probe does not throw`);
  ok(verdict?.ok === false, `${label} — the verdict rejects it`);
  ok(Boolean(verdict?.reason), `${label} — a reason is given`, verdict?.reason ?? '');
}

section('The probe holds up on a long clip');
{
  // 180s is `MAX_DURATION_SECONDS`; the sample table is ~8,400 entries by then.
  const bytes = muxFile({ seconds: 180 });
  const probe = probeMp4Audio(bytes);
  const expectedFrames = Math.floor((180 * 48_000) / AAC_FRAME_SAMPLES);
  ok(
    probe.track?.sampleCount === expectedFrames,
    'every AAC frame is accounted for in stsz',
    `${probe.track?.sampleCount} of ${expectedFrames}`,
  );
  ok(
    Math.abs((probe.track?.seconds ?? 0) - 180) < 0.1,
    'the duration is right',
    (probe.track?.seconds ?? 0).toFixed(3),
  );
  ok(judge(bytes, 180).ok, 'the verdict accepts it', judge(bytes, 180).reason ?? '');
}

section('The acceptance rule never approves an unproved file');
{
  // The bug as reported: `method: 'undecodable'` arriving alongside `audible: true`. The
  // rule in `lib/encode.ts` is the last thing between that and a downloads folder, so it
  // is asserted here against every method a proof can carry — including proofs whose own
  // `audible` flag lies, which is exactly the state the old verifier produced.
  const proofOf = (method, audible) => ({
    audible,
    method,
    peak: audible ? 0.4 : 0,
    rms: audible ? 0.05 : 0,
    seconds: 10,
    reason: null,
    track: null,
  });
  const result = (method, audible, pipeline) => ({
    blob: { size: 1 },
    mimeType: 'video/mp4',
    pipeline,
    elapsedMs: 0,
    width: 1080,
    height: 1920,
    audio: proofOf(method, audible),
    diagnostics: null,
  });

  for (const method of ['undecodable', 'too-large', 'container', 'malformed']) {
    for (const pipeline of PIPELINES) {
      ok(
        audioProved(result(method, true, pipeline)) === false,
        `${pipeline}: a '${method}' proof claiming to be audible is still rejected`,
      );
    }
  }
  for (const pipeline of PIPELINES) {
    ok(audioProved(result('decoded', true, pipeline)), `${pipeline}: a decoded proof is accepted`);
    ok(
      audioProved(result('decoded', false, pipeline)) === false,
      `${pipeline}: a decoded proof measured as silence is rejected`,
    );
  }
  // The structural-only verdict is enough for the recorder paths, which do not build the
  // container themselves, and deliberately not enough for WebCodecs, which does — a file
  // it wrote that the browser cannot decode has to fall through to another pipeline.
  ok(
    audioProved(result('stream', true, 'webcodecs')) === false,
    'webcodecs: a file that could not be decoded is not accepted on its boxes alone',
  );
  ok(
    audioProved(result('stream', true, 'mediarecorder')),
    'mediarecorder: a structurally sound file is accepted where no decoder exists',
  );
  ok(
    audioProved(result('stream', true, 'ffmpeg')),
    'ffmpeg: a structurally sound file is accepted where no decoder exists',
  );

  // The wording, too: an unproved file must not be described as verified anywhere.
  for (const method of ['undecodable', 'too-large', 'container', 'malformed']) {
    ok(
      !describeAudioProof(proofOf(method, true)).includes('verified'),
      `'${method}' is never described as verified audio`,
    );
  }
}

console.log(`\n${checks - failures} of ${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} failed.`);
  process.exitCode = 1;
}
