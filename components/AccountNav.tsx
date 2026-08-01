'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { displayName } from '@/lib/auth';
import { useAuth } from './AuthProvider';
import { ExitIcon, UserIcon } from './Icons';

/**
 * The account controls in the site header.
 *
 * Signed out this is an invitation, not a gate: the editor below it is complete without
 * an account, so the wording offers somewhere to come back to rather than asking anyone
 * to sign up before they can work.
 *
 * While the session is still resolving nothing is rendered in the slot — a "Log in"
 * button that flips to a name a moment later reads as though you had been logged out.
 */
export default function AccountNav() {
  const { status, user, signOut } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  if (status === 'loading') {
    // Holds the row's height so the header does not shift when the session lands.
    return <div className="h-9" aria-hidden="true" />;
  }

  if (status === 'signed-out') {
    return (
      <nav className="flex items-center gap-2" aria-label="Account">
        <Link
          href="/login"
          className="px-3 py-2 text-sm text-ash transition-colors hover:text-bone"
        >
          Log in
        </Link>
        <Link
          href="/signup"
          className="flex items-center gap-2 border border-bone/18 px-3 py-2 text-sm text-bone transition-colors hover:border-bone/45"
        >
          <UserIcon className="h-4 w-4" />
          Create account
        </Link>
      </nav>
    );
  }

  const handleSignOut = async () => {
    setLeaving(true);
    await signOut();
    setLeaving(false);
    router.push('/');
  };

  return (
    <nav className="flex items-center gap-2" aria-label="Account">
      <Link
        href="/account"
        className="flex max-w-[9.5rem] items-center gap-2 border border-bone/18 px-3 py-2 text-sm text-bone transition-colors hover:border-bone/45"
      >
        <UserIcon className="h-4 w-4" />
        <span className="truncate">{displayName(user)}</span>
      </Link>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={leaving}
        className="flex items-center gap-2 px-3 py-2 text-sm text-ash transition-colors hover:text-bone disabled:opacity-50"
      >
        <ExitIcon className="h-4 w-4" />
        <span className="sr-only sm:not-sr-only">Log out</span>
      </button>
    </nav>
  );
}
