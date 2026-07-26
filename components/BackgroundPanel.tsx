'use client';

import { useRef } from 'react';
import {
  GRADIENT_BACKGROUNDS,
  SOLID_BACKGROUNDS,
  type BackgroundChoice,
} from '@/lib/theme';
import { CheckIcon, ImageIcon } from './Icons';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

interface BackgroundPanelProps {
  value: BackgroundChoice;
  imageName: string | null;
  onChange: (background: BackgroundChoice) => void;
  onImage: (file: File) => void;
  onError: (message: string) => void;
}

function swatchStyle(background: BackgroundChoice): React.CSSProperties {
  if (background.kind === 'solid') return { background: background.color };
  if (background.kind === 'gradient') {
    return {
      background: `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`,
    };
  }
  return { background: `center / cover no-repeat url(${background.src})` };
}

export default function BackgroundPanel({
  value,
  imageName,
  onChange,
  onImage,
  onError,
}: BackgroundPanelProps) {
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

  const options = [...SOLID_BACKGROUNDS, ...GRADIENT_BACKGROUNDS];

  return (
    <section className="panel" aria-labelledby="step-background">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">02</span>
        <h2 id="step-background" className="font-display text-2xl leading-none">
          Backdrop
        </h2>
      </header>

      <div className="flex flex-wrap gap-2.5">
        {options.map((option) => {
          const active = value.kind !== 'image' && value.id === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={active}
              title={option.label}
              className="group relative h-12 w-12 overflow-hidden rounded-[3px] border transition-transform active:translate-y-px"
              style={{
                borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.18)',
                boxShadow: active ? '0 0 0 2px rgba(240,135,60,0.28)' : 'none',
              }}
            >
              <span aria-hidden="true" className="absolute inset-0" style={swatchStyle(option)} />
              {active && (
                <span className="absolute inset-0 grid place-items-center bg-ink/45 text-bone">
                  <CheckIcon className="h-4 w-4" />
                </span>
              )}
              <span className="sr-only">{option.label}</span>
            </button>
          );
        })}

        {/* Uploaded image */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-pressed={value.kind === 'image'}
          title="Upload a background image"
          className="relative grid h-12 w-12 place-items-center overflow-hidden rounded-[3px] border text-ash transition-colors hover:text-bone"
          style={{
            borderColor: value.kind === 'image' ? 'var(--color-ember)' : 'rgba(242,236,224,0.18)',
            borderStyle: value.kind === 'image' ? 'solid' : 'dashed',
            boxShadow: value.kind === 'image' ? '0 0 0 2px rgba(240,135,60,0.28)' : 'none',
          }}
        >
          {value.kind === 'image' && (
            <span aria-hidden="true" className="absolute inset-0" style={swatchStyle(value)} />
          )}
          <span className="relative grid h-full w-full place-items-center bg-ink/45">
            <ImageIcon className="h-4 w-4" />
          </span>
          <span className="sr-only">Upload a background image</span>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={handleFile}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      <p className="label-mono mt-4 truncate">
        {value.kind === 'image'
          ? `Image · ${imageName ?? 'uploaded'} · darkened for legibility`
          : value.label}
      </p>
    </section>
  );
}
