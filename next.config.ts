import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/run-script": [
      "./sync_retailcrm_to_supabase.py",
      "./upload_orders_to_retailcrm.py",
      "./mock_orders.json",
    ],
  },
};

export default nextConfig;
