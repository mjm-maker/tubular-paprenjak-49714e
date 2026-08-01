'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signup } from '@netlify/identity';
import AuthCard, { AuthField, FormNotice } from '@/components/AuthCard';
import { useAuth } from '@/components/AuthProvider';
import { MIN_PASSWORD, describeAuthError, validateSignup, type FieldErrors } from '@/lib/auth';

/**
 * Create an account.
 *
 * The name is passed as `full_name` in the signup metadata, which is where Identity's
 * `user.name` comes from — the account page reads it back from there rather than keeping
 * a copy. The password goes into `signup()` and nowhere else; there is no local record
 * of it, hashed or plain.
 *
 * Whether the new account is logged in immediately depends on the project's autoconfirm
 * setting, so this asks the returned user instead of assuming: a confirmed account goes
 * to the account page, an unconfirmed one is told to open its email.
 */
export default function SignupPage() {
  const router = useRouter();
  const { status, refresh } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === 'signed-in') {
    return (
      <AuthCard title="You already have an account" lede="You are logged in on this device.">
        <div className="space-y-3">
          <Link href="/account" className="btn-primary">
            Go to your account
          </Link>
          <Link href="/" className="btn-ghost">
            Back to the editor
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        lede="We sent a confirmation link. Open it and your account is ready."
        footer={
          <Link href="/login" className="text-sm text-bone underline decoration-bone/30">
            Back to log in
          </Link>
        }
      >
        <FormNotice tone="success">
          The link opens GLASKO and finishes the sign-up. Nothing you have already made in the
          editor is affected.
        </FormNotice>
      </AuthCard>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);

    const found = validateSignup({ name, email, password, confirm });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const user = await signup(email.trim(), password, { full_name: name.trim() });
      if (user.confirmedAt) {
        // Autoconfirm is on: the account exists and the session is live.
        await refresh();
        router.replace('/account');
        return;
      }
      setSent(true);
    } catch (error) {
      setFailure(describeAuthError(error, 'signup'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Create your GLASKO account"
      lede="So you can come back to your settings on another device. The editor works without one."
      footer={
        <p className="text-sm text-ash">
          Already have an account?{' '}
          <Link href="/login" className="text-bone underline decoration-bone/30 hover:decoration-bone">
            Log in
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {failure && <FormNotice tone="error">{failure}</FormNotice>}

        <AuthField
          id="name"
          label="Name"
          value={name}
          onChange={setName}
          error={errors.name}
          autoComplete="name"
          disabled={busy}
        />
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
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters, with letters and numbers`}
          disabled={busy}
        />
        <AuthField
          id="confirm"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
          autoComplete="new-password"
          disabled={busy}
        />

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>

        <p className="label-mono normal-case tracking-normal leading-relaxed">
          Your password is sent to Netlify Identity to be hashed there. GLASKO never stores it, and
          your recordings, images and exported videos stay on your device — an account holds
          nothing but your name and email.
        </p>
      </form>
    </AuthCard>
  );
}
