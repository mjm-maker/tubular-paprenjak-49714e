'use client';

import Link from 'next/link';
import { useState } from 'react';
import { acceptInvite, updateUser } from '@netlify/identity';
import AuthCard, { AuthField, FormNotice } from '@/components/AuthCard';
import { useAuth } from '@/components/AuthProvider';
import { MIN_PASSWORD, describeAuthError, validateNewPassword, type FieldErrors } from '@/lib/auth';

/**
 * Set a new password.
 *
 * Reached three ways, and the difference is only in which call finishes it: a recovery
 * link (the visitor is already logged in by then, so `updateUser`), an invite link (not
 * logged in, so `acceptInvite` redeems the token), or a logged-in visitor who came here
 * on purpose to change their password.
 *
 * Someone who arrives with none of those gets pointed back at the email step rather than
 * a form that cannot work — there is no way to set a password from here without either a
 * live session or a token, which is the point.
 */
export default function ResetPasswordPage() {
  const { status, reset, refresh, clearReset } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const invite = reset?.kind === 'invite' ? reset.token : undefined;
  const canSet = status === 'signed-in' || Boolean(invite);

  if (done) {
    return (
      <AuthCard title="Password changed" lede="Use the new one from now on.">
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

  if (status === 'loading') {
    return (
      <AuthCard title="One moment" lede="Checking the link you opened.">
        <p className="label-mono normal-case tracking-normal">Loading…</p>
      </AuthCard>
    );
  }

  if (!canSet) {
    return (
      <AuthCard
        title="Open your reset link"
        lede="A password can only be set from the link in the email, or while you are logged in."
        footer={
          <p className="text-sm text-ash">
            <Link
              href="/forgot-password"
              className="text-bone underline decoration-bone/30 hover:decoration-bone"
            >
              Send a new reset link
            </Link>
          </p>
        }
      >
        <FormNotice tone="error">
          This page has no reset link and no session to work with. Ask for a fresh link and open it
          on this device.
        </FormNotice>
      </AuthCard>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);

    const found = validateNewPassword(password, confirm);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      if (invite) await acceptInvite(invite, password);
      else await updateUser({ password });
      clearReset();
      await refresh();
      setDone(true);
    } catch (error) {
      setFailure(describeAuthError(error, 'reset'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={invite ? 'Set your password' : 'Choose a new password'}
      lede={
        invite
          ? 'Pick a password and your account is ready to use.'
          : 'Enter it twice and you are back in.'
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {failure && <FormNotice tone="error">{failure}</FormNotice>}

        <AuthField
          id="password"
          label="New password"
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
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
          autoComplete="new-password"
          disabled={busy}
        />

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </AuthCard>
  );
}
