import type { Metadata, Viewport } from 'next';
import { DM_Mono, Familjen_Grotesk, Instrument_Serif, Inter } from 'next/font/google';
import AuthProvider from '@/components/AuthProvider';
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

/**
 * The only face in the app that carries Cyrillic.
 *
 * Subtitles and the watermark are drawn onto the canvas, and a font without
 * Cyrillic coverage would render Bulgarian as fallback glyphs — different metrics,
 * different weight, and in the exported MP4 rather than only on screen. Inter covers
 * both alphabets in one variable font, so a bilingual subtitle stays visually
 * consistent line to line.
 */
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
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
      className={`${instrumentSerif.variable} ${familjen.variable} ${dmMono.variable} ${inter.variable}`}
    >
      <body>
        {/* Session state only. The editor does not read it: signed in, signed out or
            Identity not enabled at all, every step of the video pipeline is the same. */}
        <AuthProvider>{children}</AuthProvider>
        <div className="grain-overlay" aria-hidden="true" />
      </body>
    </html>
  );
}
