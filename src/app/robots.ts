import type { MetadataRoute } from 'next';

// Static content; also required by the static export (scripts/build-export.mjs).
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: 'https://scantab.vercel.app/sitemap.xml',
  };
}
