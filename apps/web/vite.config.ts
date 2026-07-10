/// <reference types="vitest/config" />

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(webRoot, "../..");

type WebViteConfig = UserConfig & {
  test: {
    environment: "jsdom";
    fileParallelism: false;
    setupFiles: string[];
  };
};

const config = {
  envDir: workspaceRoot,
  plugins: [react()],
  server: {
    port: 4000
  },
  test: {
    environment: "jsdom",
    fileParallelism: false,
    setupFiles: ["src/test/setup.ts"]
  }
} satisfies WebViteConfig;

export default config;
