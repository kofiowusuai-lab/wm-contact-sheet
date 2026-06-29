import './globals.css';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { buildGoogleFontsUrl } from './lib/subtitleFonts';

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata = {
  title: 'wm contact sheet',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0a0a0a',
};

const SUBTITLE_FONTS_URL = buildGoogleFontsUrl();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <head>
        {/* Preconnect + single-stylesheet load for all 100 subtitle fonts.
            display=swap means font files download lazily on first use, so
            initial paint stays fast. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={SUBTITLE_FONTS_URL} />
      </head>
      <body>{children}</body>
    </html>
  );
}
