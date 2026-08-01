'use client';

import { useRef } from 'react';
import {
  PICTURE_POSITIONS,
  PICTURE_SHAPES,
  PICTURE_SIZES,
  canStepPicture,
  stepPictureSize,
  type PictureSettings,
  type PictureShape,
} from '@/lib/picture';
import { CheckIcon, ImageIcon, TrashIcon, UploadIcon, WindowIcon } from './Icons';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

interface PicturePanelProps {
  settings: PictureSettings;
  /** Name of the window's own upload, if there is one. */
  imageName: string | null;
  /** Name of the backdrop image, when one is loaded and can be reused. */
  backdropName: string | null;
  onSettings: (settings: PictureSettings) => void;
  onImage: (file: File) => void;
  onRemove: () => void;
  onError: (message: string) => void;
}

/** The three crops, drawn rather than described. */
function ShapeGlyph({ shape, active }: { shape: PictureShape; active: boolean }) {
  const radius = shape === 'circle' ? '9999px' : shape === 'rounded' ? '5px' : '1px';
  return (
    <span
      aria-hidden="true"
      className="block h-5 w-5 border"
      style={{
        borderRadius: radius,
        borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.4)',
        background: active ? 'rgba(240,135,60,0.18)' : 'rgba(242,236,224,0.06)',
      }}
    />
  );
}

/** Shared look for the small choice buttons in this panel. */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
    background: active ? 'rgba(240,135,60,0.07)' : 'transparent',
    color: active ? 'var(--color-ember)' : 'var(--color-ash)',
  };
}

export default function PicturePanel({
  settings,
  imageName,
  backdropName,
  onSettings,
  onImage,
  onRemove,
  onError,
}: PicturePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      onError('Pick an image file — JPEG, PNG, WebP or AVIF.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      onError('That image is over 12 MB. Try a smaller one.');
      return;
    }
    onImage(file);
  };

  const usingBackdrop = settings.source === 'background';
  // What the frame will actually draw: the backdrop is only usable while one is loaded.
  const hasArtwork = usingBackdrop ? Boolean(backdropName) : Boolean(imageName);

  return (
    <section className="panel" aria-labelledby="step-picture">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">04</span>
        <h2 id="step-picture" className="font-display text-2xl leading-none">
          Picture window
        </h2>
      </header>

      <p className="label-mono mb-5 normal-case tracking-normal leading-relaxed">
        A photo inset in the corner, the way a podcast clip shows the guest. Off by default.
      </p>

      <div className="flex gap-2.5" role="group" aria-label="Picture window">
        {[
          { on: false, label: 'Off' },
          { on: true, label: 'On' },
        ].map(({ on, label }) => (
          <button
            key={label}
            type="button"
            onClick={() => onSettings({ ...settings, enabled: on })}
            aria-pressed={settings.enabled === on}
            className="flex flex-1 items-center justify-center gap-2 border px-3.5 py-2.5 text-sm transition-colors"
            style={chipStyle(settings.enabled === on)}
          >
            {on && <WindowIcon className="h-4 w-4" />}
            {label}
          </button>
        ))}
      </div>

      {settings.enabled && (
        <div className="mt-6 space-y-6">
          {/* Artwork */}
          <div>
            <span className="label-mono mb-3 block">Image</span>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-2 border px-3.5 py-2.5 text-sm transition-colors"
                style={chipStyle(!usingBackdrop && Boolean(imageName))}
              >
                <UploadIcon className="h-4 w-4" />
                {imageName && !usingBackdrop ? 'Change image' : 'Upload image'}
              </button>

              {/* Only offered when there is a backdrop image to reuse — the option is
                  meaningless against a colour or a gradient. */}
              {backdropName && (
                <button
                  type="button"
                  onClick={() =>
                    onSettings({ ...settings, source: usingBackdrop ? 'upload' : 'background' })
                  }
                  aria-pressed={usingBackdrop}
                  className="flex items-center gap-2 border px-3.5 py-2.5 text-sm transition-colors"
                  style={chipStyle(usingBackdrop)}
                >
                  <ImageIcon className="h-4 w-4" />
                  Use backdrop image
                </button>
              )}

              {imageName && (
                <button
                  type="button"
                  onClick={onRemove}
                  className="flex items-center gap-2 border border-bone/12 px-3.5 py-2.5 text-sm text-ash transition-colors hover:text-bone"
                >
                  <TrashIcon className="h-4 w-4" />
                  Remove
                </button>
              )}

              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={handleFile}
                aria-hidden="true"
                tabIndex={-1}
                className="hidden"
              />
            </div>

            <p className="label-mono mt-3 truncate normal-case tracking-normal">
              {usingBackdrop
                ? `Backdrop · ${backdropName ?? 'no image loaded yet'}`
                : imageName
                  ? `Upload · ${imageName}`
                  : 'No image yet — the window stays out of the frame until you add one.'}
            </p>
          </div>

          {/* Shape */}
          <div>
            <span className="label-mono mb-3 block">Shape</span>
            <div className="grid gap-2.5 sm:grid-cols-3" role="group" aria-label="Picture shape">
              {PICTURE_SHAPES.map(({ id, label }) => {
                const active = settings.shape === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSettings({ ...settings, shape: id })}
                    aria-pressed={active}
                    className="flex items-center gap-2.5 border px-3.5 py-2.5 text-sm transition-colors"
                    style={chipStyle(active)}
                  >
                    <ShapeGlyph shape={id} active={active} />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Size */}
          <div>
            <span className="label-mono mb-3 block">Size</span>
            <div className="grid gap-2.5 sm:grid-cols-3" role="group" aria-label="Picture size">
              {PICTURE_SIZES.map(({ id, label }) => {
                const active = settings.size === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSettings({ ...settings, size: id })}
                    aria-pressed={active}
                    className="flex items-center justify-between gap-2 border px-3.5 py-2.5 text-sm transition-colors"
                    style={chipStyle(active)}
                  >
                    {label}
                    {active && <CheckIcon className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>

            {/* The step buttons walk the same three sizes and stop at each end, which is
                what being disabled says — there is no fourth size to reach. */}
            <div className="mt-2.5 flex gap-2.5">
              {([-1, 1] as const).map((direction) => {
                const can = canStepPicture(settings.size, direction);
                return (
                  <button
                    key={direction}
                    type="button"
                    disabled={!can}
                    onClick={() =>
                      onSettings({ ...settings, size: stepPictureSize(settings.size, direction) })
                    }
                    className="flex-1 border border-bone/12 px-3.5 py-2.5 text-sm text-ash transition-colors hover:text-bone disabled:opacity-35 disabled:hover:text-ash"
                  >
                    {direction === -1 ? 'Smaller' : 'Larger'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Position */}
          <div>
            <span className="label-mono mb-3 block">Position</span>
            <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Picture position">
              {PICTURE_POSITIONS.map(({ id, label }) => {
                const active = settings.position === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSettings({ ...settings, position: id })}
                    aria-pressed={active}
                    className="flex items-center justify-between gap-2 border px-3.5 py-2.5 text-sm transition-colors"
                    style={chipStyle(active)}
                  >
                    {label}
                    {active && <CheckIcon className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="label-mono normal-case tracking-normal leading-relaxed">
            The window is cropped to its shape and never stretched. It keeps the corner you pick
            wherever the frame allows, and takes the nearest clear space when it would otherwise
            cover the logo, the topic line, the waveform, the progress line, the subtitles or the
            watermark — in all three video sizes.
          </p>

          {!hasArtwork && (
            <p className="label-mono normal-case tracking-normal text-ember">
              Add an image and the window appears in the preview and in the exported MP4.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
