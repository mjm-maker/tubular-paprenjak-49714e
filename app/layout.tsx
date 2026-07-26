import type { Metadata, Viewport } from 'next';
import { DM_Mono, Familjen_Grotesk, Instrument_Serif } from 'next/font/google';
import './globals.css';

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-instrument-serif',
});

const familjen = Familjen_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-familjen',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-dm-mono',
});

export const metadata: Metadata = {
  title: 'GLASKO — Turn your voice into social video',
  description:
    'Record or upload a voice message and export a vertical 1080x1920 MP4 for TikTok, Instagram Reels, Facebook Reels and YouTube Shorts. Runs entirely in your browser.',
  applicationName: 'GLASKO',
  openGraph: {
    title: 'GLASKO',
    description: 'Turn your voice into social video.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0D0F12',
  width: 'device-width',
  initialScale: 1,
  // The export screen is dense; let people zoom.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${familjen.variable} ${dmMono.variable}`}
    >
      <body>
        {children}
        <div className="grain-overlay" aria-hidden="true" />
      </body>
    </html>
  );
}
