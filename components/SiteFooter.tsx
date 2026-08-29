'use client';

import { useEffect, useState } from 'react';
import { recordVisit, type VisitorCounts } from '@/lib/visitors';
import MemberCount from './MemberCount';
import { SparkIcon } from './Icons';

/**
 * Site footer: origin, the real visitor counter, and the GLASKO PRO teaser.
 *
 * The counter starts as `null` and stays that way if the database cannot be reached,
 * so a failed request simply leaves the line out instead of showing an error.
 */
export default function SiteFooter() {
  const [counts, setCounts] = useState<VisitorCounts | null>(null);
  const [proNotice, setProNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    recordVisit()
      .then((result) => {
        if (!cancelled) setCounts(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer className="mt-16 border-t border-bone/10 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-sm text-bone">Product of Bulgaria 🇧🇬</p>
        <div className="text-right">
          <MemberCount />
          {counts && (
            <p className="label-mono mt-1 tabular-nums normal-case tracking-normal text-ash/70">
              Visitors: {counts.totalVisits.toLocaleString()} ·{' '}
              {counts.uniqueVisitors.toLocaleString()} unique
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 border-t border-bone/10 pt-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-2 border border-ember/40 bg-ember/[0.08] px-2.5 py-1 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-ember">
            <SparkIcon className="h-3 w-3" />
            GLASKO PRO — Coming Soon
          </span>
          <button
            type="button"
            onClick={() => setProNotice('GLASKO PRO is coming soon.')}
            className="chip"
          >
            Notify me
          </button>
        </div>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-ash">
          More music, longer videos, premium visual styles and advanced subtitle tools are coming
          soon.
        </p>
        {proNotice && (
          <p className="mt-2 text-sm text-bone" role="status" aria-live="polite">
            {proNotice}
          </p>
        )}
      </div>

      <p className="label-mono mt-5">
        Glasko · account access · browser-only voice video · your video never leaves this device
      </p>
    </footer>
  );
}
