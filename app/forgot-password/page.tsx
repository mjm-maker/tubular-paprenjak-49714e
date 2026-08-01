'use client';

import Link from 'next/link';
import { useState } from 'react';
import { requestPasswordRecovery } from '@netlify/identity';
import AuthCard, { AuthField, FormNotice } from '@/components/AuthCard';
import { describeAuthError, validateEmail } from '@/lib/auth';

/**
 * Ask for a password reset link.
 *
 * The link Identity emails comes back to GLASKO as a URL hash, which `AuthProvider`
 * picks up on load and turns into the reset form — see `components/AuthProvider.tsx`.
 * Nothing is reset here.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);

    const problem = validateEmail(email);
    setError(problem);
    if (problem) return;

    setBusy(true);
    try {
      await requestPasswordRecovery(email.trim());
      setSent(true);
    } catch (error) {
      setFailure(describeAuthError(error, 'recovery'));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthCard
        title="Reset link sent"
        lede="Open the link in that email and GLASKO will ask you for a new password."
        footer={
          <Link href="/login" className="text-sm text-bone underline decoration-bone/30">
            Back to log in
          </Link>
        }
      >
        <FormNotice tone="success">
          The link works once and expires. If it does not arrive, check the spam folder and try
          again.
        </FormNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Forgot your password?"
      lede="Enter the email address on the account and we will send a reset link."
      footer={
        <p className="text-sm text-ash">
          Remembered it?{' '}
          <Link
            href="/login"
            className="text-bone underline decoration-bone/30 hover:decoration-bone"
          >
            Log in
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {failure && <FormNotice tone="error">{failure}</FormNotice>}

        <AuthField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          error={error ?? undefined}
          autoComplete="email"
          disabled={busy}
        />

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthCard>
  );
}
