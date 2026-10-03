import { existsSync } from "node:fs";
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

// scripts/build-export.mjs parks the proxy (the document CSP) in .export-stash/ while it
// builds. If that run was killed, refuse a web build or dev server without the CSP.
if (process.env.NEXT_PUBLIC_BUILD_TARGET !== "export" && existsSync(".export-stash")) {
  throw new Error("Server files are parked in .export-stash/ — run `npm run build:export` once to restore them.");
}

// Inlined at build time in both builds, so the runtime environment can't switch targets.
const env = { NEXT_PUBLIC_BUILD_TARGET: process.env.NEXT_PUBLIC_BUILD_TARGET ?? "web" };

const webConfig: NextConfig = {
  poweredByHeader: false,
  env,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/_next/static/:path*", headers: workerCsp },
      { source: "/tesseract/:path*", headers: workerCsp },
    ];
  },
};

// Static export for the native (Capacitor) app: no server, so no proxy, route handlers or
// response headers. scripts/build-export.mjs sets this and moves the server-only files aside.
const exportConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  env,
  images: { unoptimized: true },
  // Tests still import the parked server files; types are checked by the web build and CI.
  typescript: { ignoreBuildErrors: true },
};

export default process.env.NEXT_PUBLIC_BUILD_TARGET === "export" ? exportConfig : webConfig;
