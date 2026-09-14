import { base } from '$app/paths';

// Generated at build time so start_url, scope and icon paths follow the deployment's
// base path (a project Pages URL is served under /<repo>/, a custom domain under /).
export const prerender = true;

const THEME = '#121316'; // --surface of the dark theme the app ships with

export function GET() {
  const manifest = {
    id: `${base}/`,
    name: 'JNote',
    short_name: 'JNote',
    description: 'A private, encrypted notes app.',
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    orientation: 'any',
    background_color: THEME,
    theme_color: THEME,
    icons: [
      { src: `${base}/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${base}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${base}/icons/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'Content-Type': 'application/manifest+json' }
  });
}
