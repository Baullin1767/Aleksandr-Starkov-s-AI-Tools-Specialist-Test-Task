import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/run-script": ["./mock_orders.json"],
  },
};

export default nextConfig;
