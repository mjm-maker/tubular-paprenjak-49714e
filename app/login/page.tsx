'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login } from '@netlify/identity';
import AuthCard, { AuthField, FormNotice } from '@/components/AuthCard';
import { useAuth } from '@/components/AuthProvider';
import { describeAuthError, validateEmail, type FieldErrors } from '@/lib/auth';

/**
 * Log in.
 *
 * A failed attempt says only that the pair does not match an account — never which half
 * was wrong, since that would confirm to anyone asking which email addresses are
 * registered here.
 */
export default function LoginPage() {
  const router = useRouter();
  const { status, refresh } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signed-in') {
    return (
      <AuthCard title="You are logged in" lede="This device already has a session.">
        <div className="space-y-3">
          <Link href="/" className="btn-primary">
            Open GLASKO
          </Link>
          <Link href="/account" className="btn-ghost">
            Your account
          </Link>
        </div>
      </AuthCard>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);

    const found: FieldErrors = {};
    const emailProblem = validateEmail(email);
    if (emailProblem) found.email = emailProblem;
    if (!password) found.password = 'Enter your password.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await login(email.trim(), password);
      await refresh();
      router.replace('/');
    } catch (error) {
      setFailure(describeAuthError(error, 'login'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Log in to GLASKO"
      footer={
        <p className="text-sm text-ash">
          No account yet?{' '}
          <Link
            href="/signup"
            className="text-bone underline decoration-bone/30 hover:decoration-bone"
          >
            Create one
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
          error={errors.email}
          autoComplete="email"
          disabled={busy}
        />
        <AuthField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete="current-password"
          disabled={busy}
        />

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>

        <Link
          href="/forgot-password"
          className="label-mono block normal-case tracking-normal underline decoration-ash/40 hover:text-bone"
        >
          Forgot your password?
        </Link>
      </form>
    </AuthCard>
  );
}
