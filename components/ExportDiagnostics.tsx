'use client';

import {
  availablePipelines,
  describePipeline,
  type ExportDiagnostics,
  type Pipeline,
} from '@/lib/encode';

/**
 * The dev-only export readout, and the switch that forces one pipeline.
 *
 * This exists because the bug it was built for could not be seen from the outside: the
 * export finished, the MP4 downloaded, it played, and the voice was simply gone. Every
 * number here is one link in the chain between the microphone and the file, so a silent
 * export can be attributed to a stage rather than guessed at — and the pipeline selector
 * is what makes each of the three routes testable on its own, instead of only whichever
 * one this browser happens to reach for first.
 *
 * It is never part of the normal product UI. `app/page.tsx` renders it only in a dev
 * build or when `?diagnostics=1` is in the URL, which is what makes it usable on a Deploy
 * Preview without appearing for anyone using the app.
 */
interface ExportDiagnosticsProps {
  /** Forced by the selector, or null to try all three in order. */
  forced: Pipeline | null;
  onForce: (pipeline: Pipeline | null) => void;
  /** The last export's measurements, or null before one has run. */
  data: ExportDiagnostics | null;
  /** Set when the export failed, so the readout can say so. */
  failure?: string | null;
  disabled?: boolean;
}

function level(reading: { peak: number; rms: number }): string {
  return `peak ${reading.peak.toFixed(4)} · rms ${reading.rms.toFixed(4)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="shrink-0 text-ash">{label}</span>
      <span className="text-right text-bone tabular-nums">{value}</span>
    </div>
  );
}

export default function ExportDiagnosticsPanel({
  forced,
  onForce,
  data,
  failure = null,
  disabled = false,
}: ExportDiagnosticsProps) {
  const available = availablePipelines();
  const choices: Array<{ value: Pipeline | null; label: string }> = [
    { value: null, label: 'Automatic' },
    ...(['webcodecs', 'mediarecorder', 'ffmpeg'] as Pipeline[]).map((pipeline) => ({
      value: pipeline,
      label: describePipeline(pipeline),
    })),
  ];

  return (
    <div className="mt-7 space-y-4 border-t border-bone/10 pt-6">
      <p className="label-mono">Diagnostics — development only</p>

      <div className="space-y-2">
        <p className="text-sm text-ash">
          Force one export pipeline so it can be tested on its own. Unavailable routes are
          disabled; forcing one that fails reports why below rather than falling through.
        </p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => {
            const unavailable = choice.value !== null && !available.includes(choice.value);
            const active = forced === choice.value;
            return (
              <button
                key={choice.label}
                type="button"
                disabled={disabled || unavailable}
                onClick={() => onForce(choice.value)}
                aria-pressed={active}
                className={`label-mono border px-3 py-1.5 normal-case tracking-normal transition-colors disabled:opacity-40 ${
                  active
                    ? 'border-ember/60 bg-ember/[0.12] text-bone'
                    : 'border-bone/15 text-ash hover:text-bone'
                }`}
              >
                {choice.label}
                {unavailable ? ' — unavailable' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {data ? (
        <div className="label-mono space-y-0 border border-bone/10 px-4 py-3 normal-case tracking-normal">
          <Row label="browser" value={data.browser} />
          <Row label="pipelines available" value={data.available.join(', ') || 'none'} />
          <Row label="pipeline requested" value={data.requested ?? 'automatic'} />
          <Row label="pipeline accepted" value={data.pipeline ?? 'none — the export failed'} />
          <Row
            label="voice in"
            value={`${data.source.sampleRate} Hz · ${data.source.channels}ch · ${data.source.seconds.toFixed(2)}s · ${level(data.source)}`}
          />
          <Row
            label="mixed buffer"
            value={`${data.mixed.sampleRate} Hz · ${data.mixed.channels}ch · ${data.mixed.seconds.toFixed(2)}s · ${level(data.mixed)}`}
          />
          {/* Per channel, because a mono voice duplicated into one channel and not the
              other is a file that is half silent and measures as sound overall. */}
          {data.mixed.channelLevels.map((reading, index) => (
            <Row key={index} label={`mixed channel ${index}`} value={level(reading)} />
          ))}
          <Row
            label="aac encoder"
            value={
              data.encoder
                ? `${data.encoder.codec} · ${data.encoder.sampleRate} Hz · ${data.encoder.channels}ch · ${Math.round(data.encoder.bitrate / 1000)} kbps · isConfigSupported ${data.encoder.configSupported ? 'yes' : 'no'}`
                : 'not configured'
            }
          />
          <Row
            label="audio packets"
            value={`${data.audioChunks} encoded · ${data.audioChunksMuxed} muxed`}
          />
          <Row
            label="decoderConfig.description"
            value={
              data.decoderDescriptionBytes > 0
                ? `${data.decoderDescriptionBytes} bytes`
                : 'absent — the container would have to guess the configuration'
            }
          />
          <Row label="audio flush" value={data.audioFlushed ? 'completed' : 'did not complete'} />
          <Row
            label="duration"
            value={`expected ${data.expectedSeconds.toFixed(2)}s · encoded ${data.encodedAudioSeconds.toFixed(2)}s · decoded ${data.decodedSeconds.toFixed(2)}s`}
          />
          <Row label="exported audio" value={level(data.exported)} />
          <Row
            label="exported track"
            value={
              data.exportedTrack
                ? `${data.exportedTrack.format} · object type ${data.exportedTrack.asc.objectType} · asc ${data.exportedTrack.asc.sampleRate} Hz ${data.exportedTrack.asc.channels}ch · header ${data.exportedTrack.sampleRate} Hz ${data.exportedTrack.channels}ch · ${data.exportedTrack.sampleCount} frames · largest ${data.exportedTrack.maxSampleBytes} bytes`
                : 'not read'
            }
          />
          <div className="mt-2 border-t border-bone/10 pt-2">
            {data.attempts.length === 0 ? (
              <Row label="attempts" value="none" />
            ) : (
              data.attempts.map((attempt, index) => (
                <Row
                  key={index}
                  label={attempt.pipeline}
                  value={`${attempt.accepted ? 'accepted' : 'rejected'} · ${(attempt.elapsedMs / 1000).toFixed(1)}s · ${attempt.bytes} bytes · ${attempt.method ?? 'unchecked'}${attempt.reason ? ` · ${attempt.reason}` : ''}`}
                />
              ))
            )}
          </div>
          {failure && <p className="mt-2 text-clay">{failure}</p>}
        </div>
      ) : (
        <p className="text-sm text-ash">Generate a video to see the audio chain measured.</p>
      )}
    </div>
  );
}
