import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "tr.rbxcdn.com" }],
  },
};

export default nextConfig;
