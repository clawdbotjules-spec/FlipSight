import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  // Monorepo: trace files from the repo root so hoisted deps are included.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Marketplace images come from arbitrary hosts; serve them as-is instead of
  // proxying through the optimizer (cards render small fixed-size thumbs).
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
};

export default nextConfig;
