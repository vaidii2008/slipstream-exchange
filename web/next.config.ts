import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server.js with only the dependencies it uses, for the Docker image.
  output: "standalone",
  // The repo root has the API's lockfile; without these Next guesses the root from it.
  outputFileTracingRoot: path.join(__dirname),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
