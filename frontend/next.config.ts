import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Export a fully static site for Tauri production builds
  output: "export",
  // Ensure trailing slashes for file:// compatibility if needed
  trailingSlash: true,
};

export default nextConfig;
