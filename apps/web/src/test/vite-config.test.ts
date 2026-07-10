// @vitest-environment node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(webRoot, "../../../..");

describe("vite config", () => {
  it("loads Vite environment variables from the workspace root", () => {
    expect(viteConfig).toMatchObject({
      envDir: workspaceRoot
    });
  });
});
