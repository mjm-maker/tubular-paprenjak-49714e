'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { recordVisit } from '@/lib/visitors';
import AuthCard from './AuthCard';
import { useAuth } from './AuthProvider';
import MemberCount from './MemberCount';
import { UserIcon } from './Icons';

const PUBLIC_ACCOUNT_ROUTES = new Set([
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
]);

/**
 * Keep the editor behind a real Identity session while leaving the four account
 * flows reachable. The video editor itself is untouched: it is mounted only after
 * the session settles as signed in, and all recording/rendering remains local.
 */
export default function AccountGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status } = useAuth();

  // The old editor footer recorded every visit to `/`. Keep that counter's meaning
  // unchanged now that a signed-out visitor sees the gate instead of the footer.
  useEffect(() => {
    if (pathname === '/') void recordVisit();
  }, [pathname]);

  if (PUBLIC_ACCOUNT_ROUTES.has(pathname)) return children;

  if (status === 'loading') {
    return (
      <AuthCard title="Opening GLASKO" lede="Checking your secure session…">
        <div
          className="h-1 w-full overflow-hidden bg-bone/10"
          role="progressbar"
          aria-label="Checking account"
        >
          <div className="h-full w-1/2 animate-pulse bg-ember" />
        </div>
      </AuthCard>
    );
  }

  if (status === 'signed-out') {
    return (
      <AuthCard
        title="Your GLASKO access"
        lede="Create a small free account or log in to open the video editor."
      >
        <div className="space-y-3">
          <Link href="/signup" className="btn-primary">
            <UserIcon className="h-4 w-4" />
            Create account
          </Link>
          <Link href="/login" className="btn-ghost">
            Log in
          </Link>
        </div>

        <div className="mt-6 border-t border-bone/10 pt-5">
          <MemberCount />
          <p className="label-mono mt-3 normal-case tracking-normal leading-relaxed">
            One account per email. Your voice, images and finished videos remain on this device.
          </p>
        </div>
      </AuthCard>
    );
  }

  return children;
}
