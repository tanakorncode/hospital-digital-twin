import type { NextConfig } from 'next';
import path from 'node:path';

// Opened through a tunnel (ngrok) or from another device, the browser reaches the API through this same origin
// (app/sio/route.ts relays socket.io), so one public URL serves both the pages and the live queue.
const nextConfig: NextConfig = {
  // `pnpm share` builds into its own folder so it can run next to `next dev` without touching .next.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Docker image: a self-contained server (apps/web/Dockerfile sets NEXT_OUTPUT=standalone).
  ...(process.env.NEXT_OUTPUT==='standalone' ? {output:'standalone' as const, outputFileTracingRoot:path.join(__dirname,'../..')} : {}),
  // Dev server: allow pages to be opened through these tunnel hosts.
  allowedDevOrigins: ['*.ngrok-free.dev', '*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io'],
  // socket.io asks for "/sio/?…": keep the trailing slash instead of redirecting it away.
  skipTrailingSlashRedirect: true,
  // Security headers for every page. The camera stays available to this site only (QR scanning at the console).
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=()' },
    ] }];
  },
};
export default nextConfig;
