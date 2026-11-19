import type { MetadataRoute } from 'next';

// Static content; also required by the static export (scripts/build-export.mjs).
export const dynamic = 'force-static';

// Only the public pages. /scan, /settings and /doc show the visitor's own local documents.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: 'https://scantab.vercel.app/' }, { url: 'https://scantab.vercel.app/privacy' }];
}
