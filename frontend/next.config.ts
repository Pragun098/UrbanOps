import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root also has a package-lock.json (the Express backend), so pin the
  // frontend as Turbopack's root instead of letting it guess.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
