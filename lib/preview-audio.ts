/** The decoded sample shape needed to build the Preview player's audio source. */
interface DecodedSamples {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Build the Preview player's source from the samples we successfully decoded.
 *
 * iPhone Safari can decode a MediaRecorder blob through Web Audio while its HTML
 * audio element still refuses to play that same container. A mono PCM WAV is the
 * common denominator across those two paths, and using the decoded samples also
 * guarantees that Preview plays the exact voice the waveform and subtitles heard.
 * Mono keeps the extra in-memory file small on long phone recordings; voice input
 * is normally mono already, while multi-channel uploads are safely downmixed.
 */
export function createPreviewWav(buffer: DecodedSamples): Blob {
  const channelCount = Math.max(1, buffer.numberOfChannels);
  const frameCount = buffer.length;
  const bytesPerSample = 2;
  const dataBytes = frameCount * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  const channelScale = 1 / channelCount;
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    let sample = 0;
    for (const channel of channels) sample += channel[frame] * channelScale;
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([wav], { type: 'audio/wav' });
}
