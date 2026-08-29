'use client';

import Link from 'next/link';
import { AlertIcon, CheckIcon } from './Icons';

/**
 * The frame every account page sits in, and the two form parts they all share.
 *
 * Kept together because consistency is the point: one column, one measure, the same
 * label / input / error stack on all four pages, so a validation message appears in the
 * same place whether you are signing up or resetting a password. The layout is a single
 * narrow column at every width — these pages are the most likely to be opened on a
 * phone, from a link in an email.
 */

interface AuthCardProps {
  title: string;
  lede?: string;
  children: React.ReactNode;
  /** Rendered under the rule at the bottom: the cross-links between the flows. */
  footer?: React.ReactNode;
}

export default function AuthCard({ title, lede, children, footer }: AuthCardProps) {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-20 pt-9 sm:px-8 lg:pt-14">
      <Link href="/" className="inline-block">
        <img
          src="/glasko-logo.png"
          alt="GLASKO"
          width={787}
          height={140}
          decoding="async"
          className="block h-auto w-full max-w-[176px]"
        />
      </Link>

      <h1 className="mt-8 font-display text-[2.1rem] leading-[1.08] tracking-[-0.015em]">
        {title}
      </h1>
      {lede && <p className="mt-3 text-[0.95rem] leading-relaxed text-ash">{lede}</p>}

      <div className="mt-8">{children}</div>

      <div className="mt-8 border-t border-bone/10 pt-5">
        {footer}
        <p className="label-mono mt-4 normal-case tracking-normal leading-relaxed">
          A GLASKO account is required to open the editor. Your recordings and videos still stay
          on your device.
        </p>
      </div>
    </main>
  );
}

interface AuthFieldProps {
  id: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'tel';
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoComplete?: string;
  hint?: string;
  disabled?: boolean;
}

export function AuthField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  error,
  autoComplete,
  hint,
  disabled,
}: AuthFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="label-mono mb-2.5 block">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className="w-full border bg-bone/[0.03] px-3.5 py-3 text-[0.95rem] text-bone outline-none transition-colors placeholder:text-ash/70 disabled:opacity-60"
        style={{ borderColor: error ? 'var(--color-clay)' : 'rgba(242,236,224,0.14)' }}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-2 text-[0.8125rem] text-clay">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="label-mono mt-2 normal-case tracking-normal">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** A whole-form outcome: the one thing that went wrong, or the one that went right. */
export function FormNotice({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  const error = tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-live="polite"
      className="flex items-start gap-3 border px-4 py-3.5 text-sm"
      style={{
        borderColor: error ? 'rgba(180,80,44,0.6)' : 'rgba(242,236,224,0.14)',
        background: error ? 'rgba(180,80,44,0.12)' : 'rgba(242,236,224,0.04)',
      }}
    >
      {error ? (
        <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-clay" />
      ) : (
        <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-ember" />
      )}
      <p className="text-bone">{children}</p>
    </div>
  );
}
