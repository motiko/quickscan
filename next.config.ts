import type { NextConfig } from "next";
import { SECURITY_HEADERS, buildWorkerCsp } from "./src/lib/csp";

// Documents get a per-request nonce CSP from src/proxy.ts. Worker scripts are governed by
// the CSP of their own response, so they get the static worker policy here. It must not
// reach documents: two CSP headers intersect, which would block Next's nonced scripts.
const workerCsp = [
  {
    key: "Content-Security-Policy",
    value: buildWorkerCsp({
      dev: process.env.NODE_ENV === "development",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    }),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/_next/static/:path*", headers: workerCsp },
      { source: "/tesseract/:path*", headers: workerCsp },
    ];
  },
};

export default nextConfig;
