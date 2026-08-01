'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FPS, getFrameData, type AudioAnalysis } from '@/lib/analysis';
import { DEFAULT_FORMAT, describeFormat } from '@/lib/layout';
import { drawFrame, type RenderSpec } from '@/lib/render';

interface PreviewStageProps {
  analysis: AudioAnalysis;
  spec: RenderSpec;
  /** Current playback position in seconds. Read every frame while animating. */
  getTime: () => number;
  animating: boolean;
  children?: ReactNode;
}

/**
 * Live preview. Draws through the exact same renderer as the export, scaled down, so
 * what is on screen is what lands in the MP4 — including the subtitles and the
 * watermark, which are drawn inside `drawFrame` for precisely that reason.
 *
 * The frame shape comes from `spec.format`, so switching to square or landscape
 * changes the preview and the export together.
 */
export default function PreviewStage({
  analysis,
  spec,
  getTime,
  animating,
  children,
}: PreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const getTimeRef = useRef(getTime);
  const [pixelWidth, setPixelWidth] = useState(0);

  getTimeRef.current = getTime;

  const format = spec.format ?? DEFAULT_FORMAT;

  // Match the backing store to the element size, capped at the real video width.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const cssWidth = container.clientWidth;
      if (cssWidth <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      setPixelWidth(Math.min(format.width, Math.round(cssWidth * dpr)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [format.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pixelWidth <= 0) return;

    const scale = pixelWidth / format.width;
    canvas.width = pixelWidth;
    canvas.height = Math.round(pixelWidth * (format.height / format.width));

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let handle = 0;
    const paint = () => {
      const seconds = getTimeRef.current();
      const index = Math.round(seconds * analysis.fps);
      drawFrame(ctx, getFrameData(analysis, index), spec, index, scale);
      if (animating) handle = requestAnimationFrame(paint);
    };
    paint();

    return () => cancelAnimationFrame(handle);
  }, [analysis, spec, animating, pixelWidth, format.height, format.width]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className={`relative ${format.aspectClass} w-full overflow-hidden rounded-[10px] border border-bone/12 bg-ink-raised shadow-[0_30px_80px_-40px_rgba(0,0,0,0.95)]`}
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          aria-label={`Preview of the ${format.label} video`}
        />
        {children}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="label-mono">
          {describeFormat(format)} · {FPS} fps
        </span>
        <span className="label-mono">MP4 · H.264 · AAC</span>
      </div>
    </div>
  );
}
