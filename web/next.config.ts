import type { NextConfig } from "next";

// WebSocket connections bypass Next.js rewrites entirely (HTTP upgrade happens
// before the rewrite layer).  The ws:// URL is constructed directly in
// lib/speechmux-ws.ts from NEXT_PUBLIC_API_PORT / window.location.
const nextConfig: NextConfig = {
  output: "standalone", // Produces .next/standalone for a minimal Docker runtime image.
};

export default nextConfig;
