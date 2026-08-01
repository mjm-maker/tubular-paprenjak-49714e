'use client';

import { ANIMATIONS, type AnimationKind } from '@/lib/theme';

interface AnimationPanelProps {
  value: AnimationKind;
  onChange: (animation: AnimationKind) => void;
}

/** Small CSS-animated glyph so each option shows its motion before selection. */
function MotionGlyph({ kind, active }: { kind: AnimationKind; active: boolean }) {
  const color = active ? 'var(--color-ember)' : 'rgba(242,236,224,0.5)';

  if (kind === 'none') {
    // Deliberately still, and the same 76px footprint as the other two so the three
    // cards line up: the glyph says "nothing moves here" by not moving.
    return (
      <span aria-hidden="true" className="flex h-8 w-[76px] items-center justify-center">
        <span className="h-[2px] w-10 rounded-full" style={{ background: color }} />
      </span>
    );
  }

  if (kind === 'bars') {
    return (
      <span aria-hidden="true" className="flex h-8 items-center gap-[3px]">
        {[0.55, 0.9, 0.35, 0.75, 0.5, 1, 0.4].map((scale, index) => (
          <span
            key={index}
            className="w-[3px] origin-center rounded-full"
            style={{
              height: `${scale * 100}%`,
              background: color,
              animation: 'bar-bounce 1.1s ease-in-out infinite',
              animationDelay: `${index * 0.09}s`,
            }}
          />
        ))}
      </span>
    );
  }

  if (kind === 'pulse') {
    // The same slide as the waveform at a fraction of the height and a third of the
    // opacity, which is exactly what the mode does in the frame.
    return (
      <span aria-hidden="true" className="relative block h-8 w-[76px] overflow-hidden">
        <svg
          viewBox="0 0 152 32"
          className="absolute left-0 top-0 h-full w-[152px]"
          style={{ animation: 'wave-slide 3.2s linear infinite', opacity: 0.45 }}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M0 16q4-4 8 0t8-2 8 4 8-5 8 3 8-1 8 3 8-4 8 2 8-1 8 3 8-4 8 3 8-1 8 2 8-3 8 2 8-1" />
        </svg>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="relative block h-8 w-[76px] overflow-hidden">
      <svg
        viewBox="0 0 152 32"
        className="absolute left-0 top-0 h-full w-[152px]"
        style={{ animation: 'wave-slide 2.4s linear infinite' }}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      >
        {/* Two identical halves so the horizontal slide loops seamlessly. */}
        <path d="M0 16q4-11 8 0t8-7 8 11 8-13 8 9 8-5 8 8 8-10 8 6 8-3 8 7 8-12 8 9 8-4 8 5 8-8 8 6 8-2" />
      </svg>
    </span>
  );
}

export default function AnimationPanel({ value, onChange }: AnimationPanelProps) {
  return (
    <section className="panel" aria-labelledby="step-motion">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">03</span>
        <h2 id="step-motion" className="font-display text-2xl leading-none">
          Motion
        </h2>
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {ANIMATIONS.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              aria-pressed={active}
              className="flex items-center gap-4 rounded-[3px] border px-4 py-3.5 text-left transition-colors active:translate-y-px"
              style={{
                borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.14)',
                background: active ? 'rgba(240,135,60,0.09)' : 'rgba(242,236,224,0.03)',
              }}
            >
              <MotionGlyph kind={option.id} active={active} />
              <span className="min-w-0">
                <span className="block text-sm text-bone">{option.label}</span>
                <span className="label-mono mt-1 block normal-case tracking-normal">
                  {option.blurb}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
