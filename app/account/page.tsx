'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import AuthCard, { FormNotice } from '@/components/AuthCard';
import { useAuth } from '@/components/AuthProvider';
import { ExitIcon } from '@/components/Icons';
import { memberSince } from '@/lib/auth';

/**
 * The account page: name, email, when the account was created, and a way out.
 *
 * Everything shown here is read back from Identity's user record — there is no second
 * copy of it in this app, and nothing else is kept. In particular no audio, image or
 * exported video is ever attached to an account: those stay in the browser tab that made
 * them, which is why this page has nothing that looks like a library.
 */
export default function AccountPage() {
  const router = useRouter();
  const { status, user, notice, clearNotice, signOut } = useAuth();
  const [leaving, setLeaving] = useState(false);

  if (status === 'loading') {
    return (
      <AuthCard title="Your account">
        <p className="label-mono normal-case tracking-normal">Loading…</p>
      </AuthCard>
    );
  }

  if (status === 'signed-out' || !user) {
    return (
      <AuthCard
        title="You are not logged in"
        lede="Log in to see your account and open the editor."
      >
        <div className="space-y-3">
          <Link href="/login" className="btn-primary">
            Log in
          </Link>
          <Link href="/signup" className="btn-ghost">
            Create an account
          </Link>
        </div>
      </AuthCard>
    );
  }

  const created = memberSince(user.createdAt);
  const phone =
    typeof user.userMetadata?.phone === 'string' ? user.userMetadata.phone.trim() : '';

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Name', value: user.name?.trim() || 'Not set' },
    { label: 'Email', value: user.email ?? 'Not available' },
    ...(phone ? [{ label: 'Phone', value: phone }] : []),
    // Omitted rather than faked if Identity did not report a timestamp.
    ...(created ? [{ label: 'Account created', value: created }] : []),
  ];

  const handleSignOut = async () => {
    setLeaving(true);
    await signOut();
    router.push('/');
  };

  return (
    <AuthCard
      title="Your account"
      footer={
        <p className="text-sm text-ash">
          <Link
            href="/reset-password"
            className="text-bone underline decoration-bone/30 hover:decoration-bone"
          >
            Change your password
          </Link>
        </p>
      }
    >
      <div className="space-y-6">
        {notice && (
          <button type="button" onClick={clearNotice} className="block w-full text-left">
            <FormNotice tone="success">{notice}</FormNotice>
          </button>
        )}

        <dl className="divide-y divide-bone/10 border-y border-bone/10">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-4">
              <dt className="label-mono">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-[0.95rem] text-bone">{row.value}</dd>
            </div>
          ))}
        </dl>

        <p className="label-mono normal-case tracking-normal leading-relaxed">
          Your recordings, images and exported videos are not uploaded here. They stay in the
          browser tab that made them. The account holds your name, email and optional phone only.
        </p>

        <div className="space-y-3">
          <Link href="/" className="btn-primary">
            Back to the editor
          </Link>
          <button type="button" onClick={handleSignOut} disabled={leaving} className="btn-ghost">
            <ExitIcon className="h-4 w-4" />
            {leaving ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </div>
    </AuthCard>
  );
}
