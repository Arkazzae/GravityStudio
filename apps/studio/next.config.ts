import type { NextConfig } from "next";
const config: NextConfig = { output: "standalone", poweredByHeader: false, experimental: { useTypeScriptCli: false } };
export default config;
