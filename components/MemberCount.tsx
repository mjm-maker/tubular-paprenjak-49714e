'use client';

import { useEffect, useState } from 'react';
import { readMemberCount } from '@/lib/members';

/** A quiet public count. Missing service means no line, never an error in the UI. */
export default function MemberCount({ className = '' }: { className?: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    readMemberCount().then((value) => {
      if (!cancelled) setCount(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (count === null) return null;

  return (
    <p className={`label-mono tabular-nums normal-case tracking-normal ${className}`.trim()}>
      Registered members: {count.toLocaleString()}
    </p>
  );
}
