import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The whole app is client-side (MediaRecorder / WebCodecs / Canvas), so there is
  // nothing to render on the server beyond the shell.
  poweredByHeader: false,
};

export default nextConfig;
