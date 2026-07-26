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

/* Network marks. Simplified single-colour silhouettes so they inherit the palette and
   need no third-party icon package. */

export function FacebookIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.25 10.44 22v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.45 2.91h-2.33V22C18.34 21.25 22 17.08 22 12.06Z" />
    </svg>
  );
}

export function WhatsAppIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.05 3.2a8.8 8.8 0 0 0-7.5 13.4L3.3 20.8l4.32-1.2a8.8 8.8 0 1 0 4.43-16.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M9.1 7.9c.2 0 .38.01.55.02.18.01.4-.07.63.47.23.55.8 1.94.87 2.08.07.14.11.31.02.5-.09.19-.14.31-.28.48-.14.16-.3.36-.42.48-.14.14-.28.3-.12.58.16.28.72 1.2 1.56 1.95.99.88 1.83 1.17 2.1 1.31.28.14.44.12.6-.07.16-.19.7-.8.88-1.08.19-.28.37-.23.63-.14.25.1 1.6.76 1.88.9.28.14.46.21.53.33.07.13.07.75-.18 1.47-.25.72-1.47 1.4-2.03 1.44-.56.05-1.09.25-3.68-.77-3.13-1.23-5.05-4.5-5.2-4.7-.14-.19-1.2-1.6-1.2-3.05s.77-2.17 1.04-2.47c.28-.3.6-.37.79-.37Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TelegramIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21.6 3.6 2.9 11c-.9.35-.86 1.63.06 1.93l4.5 1.45 1.7 5.1c.28.85 1.4 1.02 1.93.3l2.28-3.1 4.64 3.42c.72.53 1.75.14 1.94-.74l3.06-14.1c.2-.9-.68-1.66-1.4-1.66Z"
        fill="currentColor"
      />
      <path
        d="m9.36 14.6 9.1-7.6-9.1 5.9v3.9"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity="0.55"
      />
    </svg>
  );
}

export function XIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.9 2.7h3.3l-7.2 8.24L22.4 21.3h-6.63l-5.19-6.79-5.94 6.79H1.34l7.7-8.8L1.2 2.7h6.8l4.83 6.39 5.07-6.39Zm-1.16 16.5h1.83L6.35 4.7H4.39l12.35 14.5Z" />
    </svg>
  );
}

export function LinkedInIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={`${base} ${className}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.6 3.2a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM2.4 20.8h4.4V9.6H2.4v11.2Zm6.9 0h4.4v-6.1c0-1.6.3-3.1 2.28-3.1 1.9 0 1.9 1.78 1.9 3.2v6h4.42v-6.87c0-4.06-.88-6.53-4.63-6.53-1.8 0-3 .99-3.5 1.93h-.06V9.6H9.3v11.2Z" />
    </svg>
  );
}
