import type { NextConfig } from "next";
import { validateAtBoot } from "./src/lib/config/env";

// The environment is validated before anything else loads: this file is read first by
// `next dev`, `next start` and `next build`, so a missing or malformed var stops all three
// - a Vercel deploy without its env fails at build, not on the first request. The resolved
// config is logged once per server by src/instrumentation.ts.
validateAtBoot("next", { log: false });

const nextConfig: NextConfig = {
  // APP_ENV, inlined so client and edge code read the same environment as the server
  // (env.ts appEnv()). Not a secret.
  env: { APP_ENV: process.env.APP_ENV },
};

export default nextConfig;
