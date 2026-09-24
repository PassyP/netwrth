import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "web-push", "node-cron"],
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
};

export default nextConfig;
