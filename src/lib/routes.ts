/** True in the static export that the native (Capacitor) app ships. */
export const IS_STATIC_EXPORT = process.env.NEXT_PUBLIC_BUILD_TARGET === 'export';

/** A document's URL: /doc/<id> on the web, /doc?id=<id> in the static export. */
export function docHref(id: string): string {
  return IS_STATIC_EXPORT ? `/doc?id=${encodeURIComponent(id)}` : `/doc/${id}`;
}
