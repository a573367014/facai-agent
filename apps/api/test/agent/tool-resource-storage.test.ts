import { describe, expect, it } from "vitest";
import { S3ToolResourceStorage } from "../../src/agent/tool-resource-storage.js";

describe("S3ToolResourceStorage", () => {
  it("下载工具生成的图片资源，按内容 hash 转储到 S3 兼容对象存储", async () => {
    const imageBuffer = Buffer.from("generated image bytes");
    const sentCommands: unknown[] = [];
    const storage = new S3ToolResourceStorage({
      bucket: "agent-uploads",
      objectUrlFactory: (key) => `http://127.0.0.1:9000/agent-uploads/${key}`,
      s3Client: {
        send: async (command) => {
          sentCommands.push(command);
          return {};
        }
      },
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
      url: "http://127.0.0.1:9000/agent-uploads/resources/images/e08d1afaf234cf634e39ede1a7f1f651.png",
      mime: "image/png",
      name: "e08d1afaf234cf634e39ede1a7f1f651.png",
      size: imageBuffer.length,
      relativePath: "resources/images/e08d1afaf234cf634e39ede1a7f1f651.png"
    });
    expect(sentCommands).toHaveLength(1);
  });

  it("把工具生成的文档字节转储到 document 资源目录，并保留用户可读文件名", async () => {
    const documentBuffer = Buffer.from("# 年度复盘\n\n- 收入增长 20%", "utf8");
    const sentCommands: unknown[] = [];
    const storage = new S3ToolResourceStorage({
      bucket: "agent-uploads",
      objectUrlFactory: (key) => `http://127.0.0.1:9000/agent-uploads/${key}`,
      s3Client: {
        send: async (command) => {
          sentCommands.push(command);
          return {};
        }
      }
    });

    const stored = await storage.storeGeneratedResource({
      bytes: documentBuffer,
      type: "document",
      mime: "text/markdown",
      fileName: "年度复盘.md"
    });

    expect(stored).toEqual({
      url: "http://127.0.0.1:9000/agent-uploads/resources/documents/05365cc8412ae37ccf331315d57bb32f.md",
      mime: "text/markdown",
      name: "年度复盘.md",
      size: documentBuffer.length,
      relativePath: "resources/documents/05365cc8412ae37ccf331315d57bb32f.md"
    });
    expect(sentCommands).toHaveLength(1);
  });
});
