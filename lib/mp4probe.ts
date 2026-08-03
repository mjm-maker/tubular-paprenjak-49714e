/**
 * Reads an exported MP4's audio track out of the file's own boxes.
 *
 * This exists because "the container mentions `mp4a` somewhere" is not evidence that a
 * video has sound. That string appears in the sample description whether the track holds
 * speech, digital silence, or AAC frames no decoder will accept — so an export that had
 * lost its audio still passed the check that was supposed to catch exactly that.
 *
 * What is actually needed is a measurement of the finished bytes that does not depend on
 * a decoder, because the browsers most likely to write a broken audio track are also the
 * ones least able to read it back. So this walks the box tree to the audio track's sample
 * table and reports what is really there:
 *
 *  - the codec in the sample description, and the channel count and sample rate the
 *    track header claims;
 *  - the AudioSpecificConfig inside `esds` — the four bytes that tell a player how to
 *    set its AAC decoder up. A track without one, or with one describing a different
 *    shape than the header does, decodes as silence rather than as an error;
 *  - every sample's size out of `stsz`, and the track duration out of `mdhd`.
 *
 * The frame sizes are the decoder-free half of the silence question. An AAC-LC encoder
 * asked for 128 kbps spends roughly 340 bytes on each 1024-sample frame of real audio and
 * a couple of dozen on a frame of pure zeroes, so a track whose *largest* frame is tiny
 * holds no signal at all. That catches digital silence, which is the failure mode here;
 * it cannot tell loud speech from quiet speech, which is what decoding is for. Both
 * checks run, and `lib/encode.ts` treats the decode as the stronger of the two.
 *
 * Pure byte manipulation on purpose: no browser API is touched, so `npm run export:check`
 * can drive it in plain node against files the real muxer produced.
 */

/** MPEG-4 Audio object type for AAC-LC, the only one worth exporting. */
export const AAC_LC_OBJECT_TYPE = 2;

/** Sampling frequencies an AudioSpecificConfig can name by index. */
const ASC_SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
];

/**
 * Largest AAC frame, in bytes, that a track can be made of and still be silence.
 *
 * A frame of digital zeroes costs an AAC-LC encoder well under this; a frame carrying any
 * signal at all at an ordinary bitrate costs several times it. Compared against the
 * biggest frame in the track rather than the average, so a clip that opens with a pause
 * is not mistaken for a clip with nothing in it.
 */
export const SILENT_FRAME_BYTES = 32;

export interface Mp4AudioTrack {
  /** Four-character sample format from `stsd` — `mp4a` for AAC. */
  format: string;
  /** Channel count in the sample description. */
  channels: number;
  /** Sample rate in the sample description. */
  sampleRate: number;
  /** Track duration in seconds, from `mdhd`. */
  seconds: number;
  /** Number of audio samples (AAC frames) in `stsz`. */
  sampleCount: number;
  /** Total bytes of audio payload. */
  totalBytes: number;
  /** Largest single frame. The silence signal. */
  maxSampleBytes: number;
  meanSampleBytes: number;
  /** Object type, sample rate and channels as stated by the `esds` AudioSpecificConfig. */
  asc: {
    present: boolean;
    objectType: number;
    sampleRate: number;
    channels: number;
  };
}

export interface Mp4AudioProbe {
  /** False when the file could not be parsed at all — truncated, or not an MP4. */
  parsed: boolean;
  /** The audio track, or null when the file has none. */
  track: Mp4AudioTrack | null;
  /** Whether a video track was found, for the diagnostics readout. */
  hasVideo: boolean;
}

// --- box walking ----------------------------------------------------------

interface Box {
  type: string;
  /** Offset of the box's payload, past the header. */
  start: number;
  /** Offset one past the box's last byte. */
  end: number;
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * The boxes directly inside `[from, to)`.
 *
 * Stops rather than throws on anything malformed: a truncated file should come back as
 * "no audio track found", which is a rejection the caller can act on, not an exception
 * that has to be caught somewhere else.
 */
function children(view: DataView, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = ascii(view, offset + 4, 4);
    let start = offset + 8;
    if (size === 1) {
      // 64-bit size. Only the low half can matter for a file held in memory.
      if (start + 8 > to) break;
      const high = view.getUint32(start);
      const low = view.getUint32(start + 4);
      if (high > 0) break;
      size = low;
      start += 8;
    } else if (size === 0) {
      // "To the end of the enclosing box."
      size = to - offset;
    }
    const end = offset + size;
    if (size < 8 || end > to) break;
    boxes.push({ type, start, end });
    offset = end;
  }
  return boxes;
}

function find(boxes: Box[], type: string): Box | null {
  return boxes.find((box) => box.type === type) ?? null;
}

/** Walk a chain of single-child container boxes, e.g. `mdia > minf > stbl`. */
function descend(view: DataView, box: Box, path: string[]): Box | null {
  let current: Box | null = box;
  for (const type of path) {
    if (!current) return null;
    current = find(children(view, current.start, current.end), type);
  }
  return current;
}

// --- descriptors ----------------------------------------------------------

/**
 * The AudioSpecificConfig bytes out of an `esds` box.
 *
 * `esds` holds an MPEG-4 descriptor tree rather than more boxes: each node is a one-byte
 * tag, then a length written seven bits at a time, then its payload. Only the path down
 * to tag 5 — the decoder-specific info, which for AAC *is* the AudioSpecificConfig —
 * matters here.
 */
function readAudioSpecificConfig(view: DataView, box: Box): Uint8Array | null {
  // fullBox: one version byte and three flag bytes before the descriptors.
  let offset = box.start + 4;
  const end = box.end;

  const readLength = (): number => {
    let value = 0;
    for (let i = 0; i < 4 && offset < end; i++) {
      const byte = view.getUint8(offset++);
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };

  while (offset < end) {
    const tag = view.getUint8(offset++);
    const length = readLength();
    if (length < 0 || offset + length > end) return null;
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID (2) and a flags byte, then nested descriptors. The three
      // optional fields the flags can add are not used by any encoder we mux from, but
      // they are skipped properly rather than assumed away.
      if (offset + 3 > end) return null;
      let inner = offset + 2;
      const flags = view.getUint8(inner++);
      if (flags & 0x80) inner += 2; // dependsOn_ES_ID
      if (flags & 0x40) inner += 1 + view.getUint8(inner); // URL
      if (flags & 0x20) inner += 2; // OCR_ES_Id
      offset = inner;
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: objectType(1) streamType(1) bufferSize(3) max(4) avg(4).
      offset += 13;
      continue;
    }
    if (tag === 0x05) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = view.getUint8(offset + i);
      return bytes;
    }
    offset += length;
  }
  return null;
}

/** Object type, sample rate and channel count out of an AudioSpecificConfig. */
function decodeAudioSpecificConfig(bytes: Uint8Array): {
  objectType: number;
  sampleRate: number;
  channels: number;
} {
  // A tiny MSB-first bit reader; the fields are not byte-aligned.
  let bit = 0;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = bytes[bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
  const objectType = read(5);
  const index = read(4);
  const sampleRate = index === 15 ? read(24) : (ASC_SAMPLE_RATES[index] ?? 0);
  const channels = read(4);
  return { objectType, sampleRate, channels };
}

// --- the probe ------------------------------------------------------------

function readAudioTrack(view: DataView, trak: Box): Mp4AudioTrack | null {
  const mdia = descend(view, trak, ['mdia']);
  if (!mdia) return null;
  const mdiaChildren = children(view, mdia.start, mdia.end);

  // Only the sound track. `hdlr` names the handler four bytes into its payload, past the
  // version, flags and a reserved word.
  const hdlr = find(mdiaChildren, 'hdlr');
  if (!hdlr || hdlr.start + 12 > hdlr.end) return null;
  if (ascii(view, hdlr.start + 8, 4) !== 'soun') return null;

  const mdhd = find(mdiaChildren, 'mdhd');
  let seconds = 0;
  if (mdhd) {
    const version = view.getUint8(mdhd.start);
    // creation and modification times are 32 or 64 bits depending on the version.
    const base = mdhd.start + 4 + (version === 1 ? 16 : 8);
    const timescale = view.getUint32(base);
    const duration =
      version === 1
        ? view.getUint32(base + 4) * 2 ** 32 + view.getUint32(base + 8)
        : view.getUint32(base + 4);
    if (timescale > 0) seconds = duration / timescale;
  }

  const stbl = descend(view, mdia, ['minf', 'stbl']);
  if (!stbl) return null;
  const stblChildren = children(view, stbl.start, stbl.end);

  const stsd = find(stblChildren, 'stsd');
  if (!stsd) return null;
  // fullBox(4) then an entry count, then the sample entries themselves.
  const entries = children(view, stsd.start + 8, stsd.end);
  const entry = entries[0];
  if (!entry) return null;
  // AudioSampleEntry: reserved(6) dataRef(2) version(2) revision(2) vendor(4)
  // channels(2) sampleSize(2) compressionId(2) packetSize(2) sampleRate(4, 16.16).
  if (entry.start + 28 > entry.end) return null;
  const channels = view.getUint16(entry.start + 16);
  const sampleRate = view.getUint32(entry.start + 24) / 65_536;

  const esds = find(children(view, entry.start + 28, entry.end), 'esds');
  const ascBytes = esds ? readAudioSpecificConfig(view, esds) : null;
  const asc = ascBytes
    ? { present: true, ...decodeAudioSpecificConfig(ascBytes) }
    : { present: false, objectType: 0, sampleRate: 0, channels: 0 };

  // stsz: fullBox(4) uniformSize(4) count(4) then the sizes, unless they are uniform.
  const stsz = find(stblChildren, 'stsz');
  let sampleCount = 0;
  let totalBytes = 0;
  let maxSampleBytes = 0;
  if (stsz && stsz.start + 12 <= stsz.end) {
    const uniform = view.getUint32(stsz.start + 4);
    sampleCount = view.getUint32(stsz.start + 8);
    if (uniform > 0) {
      totalBytes = uniform * sampleCount;
      maxSampleBytes = uniform;
    } else {
      const available = Math.min(sampleCount, Math.floor((stsz.end - stsz.start - 12) / 4));
      for (let i = 0; i < available; i++) {
        const size = view.getUint32(stsz.start + 12 + i * 4);
        totalBytes += size;
        if (size > maxSampleBytes) maxSampleBytes = size;
      }
      sampleCount = available;
    }
  }

  return {
    format: entry.type,
    channels,
    sampleRate,
    seconds,
    sampleCount,
    totalBytes,
    maxSampleBytes,
    meanSampleBytes: sampleCount > 0 ? totalBytes / sampleCount : 0,
    asc,
  };
}

/** Parse an in-memory MP4 and report its audio track. Never throws. */
export function probeMp4Audio(data: ArrayBuffer | Uint8Array): Mp4AudioProbe {
  const empty: Mp4AudioProbe = { parsed: false, track: null, hasVideo: false };
  try {
    const view =
      data instanceof Uint8Array
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data);
    if (view.byteLength < 16) return empty;

    const top = children(view, 0, view.byteLength);
    // `ftyp` first is what makes this an MP4 rather than some other box-shaped file.
    if (!find(top, 'ftyp')) return empty;
    const moov = find(top, 'moov');
    if (!moov) return empty;

    let track: Mp4AudioTrack | null = null;
    let hasVideo = false;
    for (const box of children(view, moov.start, moov.end)) {
      if (box.type !== 'trak') continue;
      const audio = readAudioTrack(view, box);
      if (audio) {
        // First sound track wins; GLASKO only ever writes one.
        track ??= audio;
        continue;
      }
      const hdlr = descend(view, box, ['mdia', 'hdlr']);
      if (hdlr && hdlr.start + 12 <= hdlr.end && ascii(view, hdlr.start + 8, 4) === 'vide') {
        hasVideo = true;
      }
    }
    return { parsed: true, track, hasVideo };
  } catch {
    return empty;
  }
}

/** What a probe says about an audio track, and whether it is good enough to ship. */
export interface Mp4AudioVerdict {
  /** True when the track is well-formed, full-length AAC-LC that is not digital silence. */
  ok: boolean;
  /** Why not, when not. One sentence, aimed at the diagnostics readout. */
  reason: string | null;
  track: Mp4AudioTrack | null;
}

/**
 * Judge a probed MP4 against what a social platform will accept.
 *
 * Deliberately strict about the things that produce a *silent* upload rather than a
 * failed one: a missing or mismatched AudioSpecificConfig, a mono track, an unusual
 * sample rate, a track that stops early, or frames too small to hold any signal. Each of
 * those has been the difference between a video that plays and a video that plays
 * without sound.
 */
export function judgeMp4Audio(
  probe: Mp4AudioProbe,
  expectedSeconds: number,
  minCoverage: number,
  acceptedSampleRates: readonly number[],
  expectedChannels: number,
): Mp4AudioVerdict {
  if (!probe.parsed) {
    return { ok: false, reason: 'the exported file could not be parsed as an MP4', track: null };
  }
  const track = probe.track;
  if (!track) {
    return { ok: false, reason: 'the exported MP4 has no audio track', track: null };
  }
  const fail = (reason: string): Mp4AudioVerdict => ({ ok: false, reason, track });

  if (track.format !== 'mp4a') {
    return fail(`the audio track is "${track.format}" rather than AAC`);
  }
  if (!track.asc.present) {
    return fail('the audio track carries no decoder configuration, so it would play silently');
  }
  if (track.asc.objectType !== AAC_LC_OBJECT_TYPE) {
    return fail(`the audio track is AAC object type ${track.asc.objectType}, not AAC-LC`);
  }
  if (track.sampleCount === 0) {
    return fail('the audio track contains no samples');
  }
  // A header that disagrees with its own decoder configuration is decoded as silence,
  // which is precisely the failure that looks like a success.
  if (track.asc.channels !== track.channels) {
    return fail(
      `the audio track header says ${track.channels} channels and its decoder configuration says ${track.asc.channels}`,
    );
  }
  if (track.asc.sampleRate !== track.sampleRate) {
    return fail(
      `the audio track header says ${track.sampleRate} Hz and its decoder configuration says ${track.asc.sampleRate} Hz`,
    );
  }
  if (track.channels !== expectedChannels) {
    return fail(`the audio track is ${track.channels}-channel rather than stereo`);
  }
  if (!acceptedSampleRates.includes(track.sampleRate)) {
    return fail(`the audio track is at ${track.sampleRate} Hz, which platforms re-encode badly`);
  }
  if (track.maxSampleBytes <= SILENT_FRAME_BYTES) {
    return fail(
      `every audio frame is ${track.maxSampleBytes} bytes or smaller, so the track is silence`,
    );
  }
  if (expectedSeconds > 0 && track.seconds < expectedSeconds * minCoverage) {
    return fail(
      `the audio track is ${track.seconds.toFixed(1)}s of an expected ${expectedSeconds.toFixed(1)}s`,
    );
  }
  return { ok: true, reason: null, track };
}
