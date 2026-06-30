import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalToolResourceStorage } from "../../src/agent/tool-resource-storage.js";

let tempDirs: string[] = [];

function createTempUploadDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "agent-tool-resource-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("LocalToolResourceStorage", () => {
  it("下载工具生成的图片资源，按内容 hash 转储到本地 uploads 目录", async () => {
    const uploadDirectory = createTempUploadDirectory();
    const imageBuffer = Buffer.from("generated image bytes");
    const storage = new LocalToolResourceStorage({
      uploadDirectory,
      publicBaseUrl: "http://127.0.0.1:4001",
      fetchImpl: async () =>
        new Response(imageBuffer, {
          status: 200,
          headers: {
            "content-type": "image/png"
          }
        })
    });

    const stored = await storage.storeRemoteResource({
      url: "https://provider.example.com/tmp/generated",
      type: "image",
      mime: "image/png"
    });

    expect(stored).toEqual({
      url: "http://127.0.0.1:4001/uploads/resources/images/e08d1afaf234cf634e39ede1a7f1f651.png",
      mime: "image/png",
      name: "e08d1afaf234cf634e39ede1a7f1f651.png",
      size: imageBuffer.length,
      relativePath: "resources/images/e08d1afaf234cf634e39ede1a7f1f651.png"
    });
    const storedPath = join(uploadDirectory, "resources", "images", "e08d1afaf234cf634e39ede1a7f1f651.png");
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath)).toEqual(imageBuffer);
  });
});
