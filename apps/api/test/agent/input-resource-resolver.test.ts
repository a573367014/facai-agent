import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentMessageCoordinator, type AgentRunner } from "../../src/modules/agent/agent-message-coordinator.js";
import { LocalUploadInputResourceResolver } from "../../src/modules/agent/input-resource-resolver.js";
import { PostgresAgentStore } from "../../src/platform/postgres/postgres-agent-store.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

describe("LocalUploadInputResourceResolver", () => {
  it("expands uploaded markdown resource parts into LLM-readable document text", async () => {
    const uploadDirectory = await mkdtemp(join(tmpdir(), "agent-input-resource-"));
    const documentDirectory = join(uploadDirectory, "agent-documents");
    const documentPath = join(documentDirectory, "annual-review.md");

    await mkdir(documentDirectory, { recursive: true });
    await writeFile(documentPath, "# 年度复盘\n\n收入增长 20%", "utf8");

    try {
      const resolver = new LocalUploadInputResourceResolver({ uploadDirectory });
      const text = await resolver.resolvePartsToLlmText([
        { type: "text", value: "请总结这个文档" },
        {
          type: "resource",
          mime: "text/markdown",
          url: "http://127.0.0.1:4001/uploads/agent-documents/annual-review.md",
          name: "年度复盘.md"
        }
      ]);

      expect(text).toContain("请总结这个文档");
      expect(text).toContain("用户上传文档：年度复盘.md");
      expect(text).toContain("# 年度复盘");
      expect(text).toContain("收入增长 20%");
    } finally {
      await rm(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("passes expanded document text to the agent runner for the current user input", async () => {
    const uploadDirectory = await mkdtemp(join(tmpdir(), "agent-input-resource-"));
    const documentDirectory = join(uploadDirectory, "agent-documents");
    const documentPath = join(documentDirectory, "annual-review.md");
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    let capturedInput = "";
    const runner: AgentRunner = {
      async run(input) {
        capturedInput = input.input;
        return { answer: "ok" };
      }
    };

    await mkdir(documentDirectory, { recursive: true });
    await writeFile(documentPath, "# 年度复盘\n\n收入增长 20%", "utf8");
    await store.reset();

    const coordinator = new AgentMessageCoordinator(
      runner,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        inputResourceResolver: new LocalUploadInputResourceResolver({ uploadDirectory })
      }
    );

    try {
      const started = await coordinator.startRun({
        input: "",
        parts: [
          { type: "text", value: "请总结这个文档" },
          {
            type: "resource",
            mime: "text/markdown",
            url: "http://127.0.0.1:4001/uploads/agent-documents/annual-review.md",
            name: "年度复盘.md"
          }
        ]
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { run } = await coordinator.getRun(started.run.id);

        if (run.status !== "running") {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(capturedInput).toContain("请总结这个文档");
      expect(capturedInput).toContain("用户上传文档：年度复盘.md");
      expect(capturedInput).toContain("收入增长 20%");
    } finally {
      await coordinator.shutdown();
      await store.close();
      await rm(uploadDirectory, { recursive: true, force: true });
    }
  });
});
