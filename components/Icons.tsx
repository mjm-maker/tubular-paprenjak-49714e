/** Inline SVG primitives — no icon dependency, no emoji. */

type IconProps = { className?: string };

const base = 'shrink-0';

export function MicIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

export function StopIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function UploadIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4" />
      <path d="M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </svg>
  );
}

export function ImageIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="m4 17 4.8-4.8a2 2 0 0 1 2.8 0L20 20" />
    </svg>
  );
}

export function PlayIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.2v13.6a.8.8 0 0 0 1.22.68l10.5-6.8a.8.8 0 0 0 0-1.36L9.22 4.52A.8.8 0 0 0 8 5.2Z" />
    </svg>
  );
}

export function PauseIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
    </svg>
  );
}

export function DownloadIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 19h15" />
    </svg>
  );
}

export function ShareIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5v11" />
      <path d="M8 7.5 12 3.5l4 4" />
      <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </svg>
  );
}

export function CheckIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

export function AlertIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5" />
      <path d="M12 16.1h.01" />
    </svg>
  );
}

export function SpinnerIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className} animate-spin`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" opacity="0.9" />
    </svg>
  );
}

export function TrashIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    </svg>
  );
}

export function MusicIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 18V6.4l10-1.9V16" />
      <circle cx="6.6" cy="18" r="2.6" />
      <circle cx="16.6" cy="16" r="2.6" />
    </svg>
  );
}

/** No background music. A speaker with the waves struck through. */
export function MuteIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5.5 6.8 9H4.2a.7.7 0 0 0-.7.7v4.6a.7.7 0 0 0 .7.7h2.6L11 18.5Z" />
      <path d="m16 9.6 4.4 4.8M20.4 9.6 16 14.4" />
    </svg>
  );
}

/** Subtitles. A frame with two text lines in it. */
export function CaptionIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.2" />
      <path d="M7 11.4h6M7 15h10" />
    </svg>
  );
}

/** Output format. Two nested frames. */
export function FrameIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.8" y="6.6" width="18.4" height="10.8" rx="1.8" />
      <rect x="8.4" y="3.4" width="7.2" height="17.2" rx="1.8" />
    </svg>
  );
}

/** The watermark step: the brand bars inside a rounded badge. */
export function StampIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3" y="5.4" width="18" height="13.2" rx="3" />
      <path d="M8.6 10.4v3.2M12 8.6v6.8M15.4 11v2" />
    </svg>
  );
}

/** The picture window: a frame with an inset in its corner. */
export function WindowIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.2" />
      <rect x="13.4" y="7.2" width="5.4" height="5.4" rx="1.4" />
    </svg>
  );
}

/** The topic line: a heavy rule over a lighter one. */
export function HeadlineIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7.5h16" strokeWidth="2.6" />
      <path d="M4 12.5h11" strokeWidth="1.5" />
      <path d="M4 16.8h7" strokeWidth="1.5" />
    </svg>
  );
}

/** An account. A head and shoulders, drawn as thin as the rest of the set. */
export function UserIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8.4" r="3.9" />
      <path d="M4.6 20.2a7.4 7.4 0 0 1 14.8 0" />
    </svg>
  );
}

/** Leaving. An arrow out of an open door. */
export function ExitIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.5 4.5h-8A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h8" />
      <path d="M13 12h7" />
      <path d="m17 8.5 3.5 3.5L17 15.5" />
    </svg>
  );
}

/** The GLASKO mark: three ascending bars. */
export function BrandMark({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="12" width="4" height="9" rx="2" />
      <rect x="10" y="4" width="4" height="17" rx="2" />
      <rect x="17" y="9" width="4" height="12" rx="2" />
    </svg>
  );
}

export function LinkIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg
      className={`${base} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.6 13.4a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66L12.02 6.3" />
      <path d="M13.4 10.6a4 4 0 0 0-5.66 0L4.91 13.43a4 4 0 0 0 5.66 5.66l1.41-1.41" />
    </svg>
  );
}

export function SparkIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.9 5.1a3 3 0 0 0 1.8 1.8l5.1 1.9-5.1 1.9a3 3 0 0 0-1.8 1.8L12 20.1l-1.9-5.1a3 3 0 0 0-1.8-1.8L3.2 11.3l5.1-1.9a3 3 0 0 0 1.8-1.8L12 2.5Z" />
    </svg>
  );
}
