import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentRecord } from "@/features/knowledge/api/knowledge-types";
import { KnowledgeAdminPanel } from "./KnowledgeAdminPanel";

const document: KnowledgeDocumentRecord = {
  id: "knowledge_doc_1",
  name: "员工手册.txt",
  mimeType: "text/plain",
  status: "ready",
  contentHash: "hash",
  chunkCount: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  indexedAt: "2026-07-01T00:00:01.000Z"
};

function renderPanel(overrides: Partial<Parameters<typeof KnowledgeAdminPanel>[0]> = {}) {
  const props = {
    documents: [document],
    isLoading: false,
    isUploading: false,
    error: null,
    onRefresh: vi.fn(),
    onUpload: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onReindex: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };

  render(<KnowledgeAdminPanel {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("KnowledgeAdminPanel", () => {
  it("展示文档状态、片段数量和操作按钮", async () => {
    const props = renderPanel();

    expect(screen.getByText("员工手册.txt")).toBeInTheDocument();
    expect(screen.getByText("可使用")).toBeInTheDocument();
    expect(screen.getByText("2 个片段")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新知识库" }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("选择文件后触发上传回调", async () => {
    const props = renderPanel();
    const file = new File(["请假需要主管审批"], "员工手册.txt", { type: "text/plain" });

    await userEvent.upload(screen.getByLabelText("上传知识库文档"), file);

    await waitFor(() => {
      expect(props.onUpload).toHaveBeenCalledWith(file);
    });
  });

  it("触发重新索引和删除操作", async () => {
    const props = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "重新索引 员工手册.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "删除 员工手册.txt" }));

    expect(props.onReindex).toHaveBeenCalledWith("knowledge_doc_1");
    expect(props.onDelete).toHaveBeenCalledWith("knowledge_doc_1");
  });
});
