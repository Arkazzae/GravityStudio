import type { NextConfig } from "next";
import { randomUUID } from 'node:crypto';

// Next reloads this config in compiler workers. Share the parent's revision so
// every compiler and the emitted service worker use the same build identity.
const buildRevision = process.env.GRAVITY_PWA_BUILD_ID ||= randomUUID();
const config: NextConfig = {
  output: "standalone", poweredByHeader: false, experimental: { useTypeScriptCli: false },
  generateBuildId: async () => buildRevision,
  env: { GRAVITY_PWA_BUILD_ID: buildRevision },
  async headers() {
    return [{ source: '/sw.js', headers: [
      { key: 'Cache-Control', value: 'no-store, max-age=0' },
      { key: 'Service-Worker-Allowed', value: '/' },
    ] }];
  },
};
export default config;
