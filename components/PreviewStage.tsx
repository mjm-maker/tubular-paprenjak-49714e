'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getFrameData, type AudioAnalysis } from '@/lib/analysis';
import { drawFrame, type RenderSpec } from '@/lib/render';
import { VIDEO_WIDTH } from '@/lib/theme';

interface PreviewStageProps {
  analysis: AudioAnalysis;
  spec: RenderSpec;
  /** Current playback position in seconds. Read every frame while animating. */
  getTime: () => number;
  animating: boolean;
  children?: ReactNode;
}

/**
 * Live 9:16 preview. Draws through the exact same renderer as the export, scaled
 * down, so what is on screen is what lands in the MP4.
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

  // Match the backing store to the element size, capped at the real video width.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const cssWidth = container.clientWidth;
      if (cssWidth <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      setPixelWidth(Math.min(VIDEO_WIDTH, Math.round(cssWidth * dpr)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pixelWidth <= 0) return;

    const scale = pixelWidth / VIDEO_WIDTH;
    canvas.width = pixelWidth;
    canvas.height = Math.round(pixelWidth * (16 / 9));

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
  }, [analysis, spec, animating, pixelWidth]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="relative aspect-[9/16] w-full overflow-hidden rounded-[10px] border border-bone/12 bg-ink-raised shadow-[0_30px_80px_-40px_rgba(0,0,0,0.95)]"
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          aria-label="Preview of the vertical video"
        />
        {children}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="label-mono">1080 × 1920 · 9:16 · 30 fps</span>
        <span className="label-mono">MP4 · H.264 · AAC</span>
      </div>
    </div>
  );
}
