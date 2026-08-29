/**
 * Account rules and error wording.
 *
 * GLASKO accounts are handled by Netlify Identity, and this file is deliberately the
 * only thing around it: the field checks, the message the user reads when something
 * goes wrong, and the date on the account page. There is no session store, no user
 * table and no credential handling of our own.
 *
 * Nothing here ever holds a password beyond checking its shape. The value goes from the
 * input straight into `signup()` / `login()` / `updateUser()`, which send it to Identity
 * over TLS to be hashed there. It is never written to `localStorage`, never put in a
 * query string, never logged, and never stored by this application in any form —
 * hashed or otherwise. If you add a field to these forms, keep that property.
 *
 * `AccountGate` requires a settled signed-in session before it mounts the editor. The
 * account still carries no video data: recording and rendering remain browser-only.
 */

import { AuthError, MissingIdentityError } from '@netlify/identity';

/** Identity's own floor is lower; this is ours, and the forms say so up front. */
export const MIN_PASSWORD = 8;
export const MAX_NAME = 60;

/** Which flow a failure came out of, so the wording can be specific. */
export type AuthAction = 'login' | 'signup' | 'recovery' | 'reset' | 'callback';

export interface SignupFields {
  name: string;
  email: string;
  phone: string;
  password: string;
  confirm: string;
}

export type FieldErrors = Partial<Record<keyof SignupFields, string>>;

/**
 * Deliberately loose: a local part, an @, a dot in the domain.
 *
 * Anything stricter rejects addresses that genuinely exist, and Identity does the
 * authoritative check anyway. This exists to catch the typo before the round trip.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter your name.';
  if (trimmed.length < 2) return 'That name is too short.';
  if (trimmed.length > MAX_NAME) return `Keep your name under ${MAX_NAME} characters.`;
  return null;
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Enter your email address.';
  if (!EMAIL.test(trimmed)) return 'That does not look like an email address.';
  return null;
}

/** Optional, international-friendly phone check. Identity stores the value as profile metadata. */
export function validatePhone(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (!/^[+\d\s().-]+$/.test(trimmed)) return 'Use a valid phone number, or leave it blank.';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return 'Use 7 to 15 digits, including the country code.';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Choose a password.';
  if (password.length < MIN_PASSWORD) {
    return `Use at least ${MIN_PASSWORD} characters.`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Mix letters and numbers.';
  }
  return null;
}

/** The whole sign-up form at once, so every problem is shown in one pass. */
export function validateSignup(fields: SignupFields): FieldErrors {
  const errors: FieldErrors = {};
  const name = validateName(fields.name);
  if (name) errors.name = name;
  const email = validateEmail(fields.email);
  if (email) errors.email = email;
  const phone = validatePhone(fields.phone);
  if (phone) errors.phone = phone;
  const password = validatePassword(fields.password);
  if (password) errors.password = password;
  else if (fields.password !== fields.confirm) errors.confirm = 'The two passwords do not match.';
  return errors;
}

/** The new-password half of a reset, which has no name or email to check. */
export function validateNewPassword(password: string, confirm: string): FieldErrors {
  const errors: FieldErrors = {};
  const problem = validatePassword(password);
  if (problem) errors.password = problem;
  else if (password !== confirm) errors.confirm = 'The two passwords do not match.';
  return errors;
}

const FALLBACK: Record<AuthAction, string> = {
  login: 'Logging in failed. Please try again.',
  signup: 'The account could not be created. Please try again.',
  recovery: 'The reset email could not be sent. Please try again.',
  reset: 'The password could not be changed. Please try again.',
  callback: 'That link could not be opened. Ask for a new one.',
};

/**
 * Turn a thrown Identity error into one sentence a person can act on.
 *
 * Two rules hold everywhere. A failed login never says which half was wrong, because
 * saying so tells an attacker which addresses have accounts. And Identity being absent
 * gets calm temporary-unavailability wording rather than exposing infrastructure detail.
 */
export function describeAuthError(error: unknown, action: AuthAction): string {
  if (error instanceof MissingIdentityError) {
    return 'Account access is temporarily unavailable. Please try again shortly.';
  }

  if (error instanceof AuthError) {
    const detail = (error.message ?? '').toLowerCase();
    if (detail.includes('already registered') || detail.includes('already been registered')) {
      return 'That email address already has a GLASKO account. Log in instead.';
    }
    if (detail.includes('not confirmed')) {
      return 'This account is not confirmed yet. Open the link in the email we sent you.';
    }
    if (detail.includes('password')) return error.message;

    switch (error.status) {
      case 400:
      case 401:
        return action === 'login'
          ? 'That email and password do not match an account.'
          : 'That link has expired. Ask for a new one.';
      case 403:
        return 'New accounts are closed on this site at the moment.';
      case 404:
        return action === 'recovery'
          ? 'No account uses that email address.'
          : 'That account could not be found.';
      case 422:
        return error.message || 'Check the details and try again.';
      case 429:
        return 'Too many attempts. Wait a minute, then try again.';
      default:
        return error.message || FALLBACK[action];
    }
  }

  return (error as Error)?.message ?? FALLBACK[action];
}

/** The account creation date, in the reader's own locale. Absent rather than guessed. */
export function memberSince(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** What to call someone in the interface: their name, else the local part of the email. */
export function displayName(user: { name?: string; email?: string } | null): string {
  if (!user) return '';
  if (user.name?.trim()) return user.name.trim();
  return user.email?.split('@')[0] ?? 'Your account';
}
