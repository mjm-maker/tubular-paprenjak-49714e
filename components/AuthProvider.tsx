'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  AUTH_EVENTS,
  getUser,
  handleAuthCallback,
  logout,
  onAuthChange,
  type User,
} from '@netlify/identity';
import { describeAuthError } from '@/lib/auth';

/**
 * Session state for the whole site.
 *
 * Mounted in the root layout for one reason: confirmation, recovery and invite links
 * all come back as a URL *hash* on whatever page the link opened — normally the editor
 * — and `handleAuthCallback()` has to run there rather than on a route the link never
 * reaches. Having it in the layout also means the header can show who is logged in on
 * every page without each page asking.
 *
 * `status` starts as `'loading'` and the header renders nothing for the account until it
 * resolves, so a signed-in visitor never sees a "Log in" button flash first.
 *
 * `AccountGate` reads this state and mounts the editor only for a signed-in user. The
 * editor itself remains independent of Identity once it is mounted.
 */

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out';

/** A password that still has to be set: after a recovery link, or to accept an invite. */
export interface ResetTicket {
  kind: 'recovery' | 'invite';
  /** Invites are redeemed with their token; recovery logs the user in first. */
  token?: string;
}

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  /** A one-off message from a link that was just opened, shown once and cleared. */
  notice: string | null;
  reset: ResetTicket | null;
  clearNotice: () => void;
  clearReset: () => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [reset, setReset] = useState<ResetTicket | null>(null);

  useEffect(() => {
    let cancelled = false;

    const settle = (next: User | null) => {
      if (cancelled) return;
      setUser(next);
      setStatus(next ? 'signed-in' : 'signed-out');
    };

    const start = async () => {
      try {
        const result = await handleAuthCallback();
        if (cancelled) return;

        if (result) {
          switch (result.type) {
            case 'recovery':
              // Logged in, but the old password is what got them here: send them
              // straight to the form that replaces it.
              settle(result.user);
              setReset({ kind: 'recovery' });
              router.replace('/reset-password');
              return;
            case 'invite':
              setReset({ kind: 'invite', token: result.token });
              settle(null);
              router.replace('/reset-password');
              return;
            case 'confirmation':
              settle(result.user);
              setNotice('Email confirmed — you are logged in.');
              router.replace('/');
              return;
            case 'email_change':
              settle(result.user);
              setNotice('Email address updated.');
              router.replace('/account');
              return;
            default:
              settle(result.user);
              router.replace('/');
              return;
          }
        }
      } catch (error) {
        // A stale or reused link is worth saying out loud, but it must not stop the
        // page loading — the editor behind it is unaffected.
        if (!cancelled) setNotice(describeAuthError(error, 'callback'));
      }

      settle(await getUser());
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Login, logout, token refresh and cross-tab changes all arrive here, so signing
  // out in one tab does not leave another tab showing an account.
  useEffect(() => {
    return onAuthChange((event, next) => {
      if (event === AUTH_EVENTS.LOGOUT) {
        setUser(null);
        setStatus('signed-out');
        return;
      }
      setUser(next ?? null);
      setStatus(next ? 'signed-in' : 'signed-out');
    });
  }, []);

  const refresh = useCallback(async () => {
    const next = await getUser();
    setUser(next);
    setStatus(next ? 'signed-in' : 'signed-out');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      // Even a failed logout call clears the session in this tab: the visible state
      // must never claim someone is still logged in when the token is gone.
      setUser(null);
      setStatus('signed-out');
      setReset(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      notice,
      reset,
      clearNotice: () => setNotice(null),
      clearReset: () => setReset(null),
      refresh,
      signOut,
    }),
    [notice, refresh, reset, signOut, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
