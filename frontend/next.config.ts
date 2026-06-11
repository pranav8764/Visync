import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone", // Removed because it breaks Vercel deployments (causes 404)
  allowedDevOrigins: ['10.191.177.243'],
};

export default nextConfig;
