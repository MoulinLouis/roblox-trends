import type { NextConfig } from "next";

// radar-web may write only .next/cache: when phase 4 adds ISR, set experimental.isrFlushToDisk: false or a cacheHandler.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "tr.rbxcdn.com" }],
  },
};

export default nextConfig;
