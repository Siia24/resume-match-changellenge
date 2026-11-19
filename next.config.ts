import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The CA file is read at runtime from process.cwd(); tracing would otherwise miss it.
  outputFileTracingIncludes: {
    "/api/analyze": ["./certs/russian_trusted_root_ca.crt"],
  },
};

export default nextConfig;
