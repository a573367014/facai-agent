import { Alert, Box, Button, Chip, IconButton, LinearProgress, Tooltip, Typography } from "@mui/material";
import { FileText, RefreshCw, RotateCw, Trash2, Upload } from "lucide-react";
import type { ChangeEvent } from "react";
import type { KnowledgeDocumentRecord } from "@/features/knowledge/api/knowledge-types";

export interface KnowledgeAdminPanelProps {
  documents: KnowledgeDocumentRecord[];
  isLoading: boolean;
  isUploading: boolean;
  error?: string | null;
  onRefresh: () => void;
  onUpload: (file: File) => void | Promise<void>;
  onDelete: (documentId: string) => void | Promise<void>;
  onReindex: (documentId: string) => void | Promise<void>;
}

const statusColor: Record<KnowledgeDocumentRecord["status"], "default" | "error" | "info" | "success" | "warning"> = {
  pending: "warning",
  indexing: "info",
  ready: "success",
  failed: "error"
};

const statusText: Record<KnowledgeDocumentRecord["status"], string> = {
  pending: "等待处理",
  indexing: "索引中",
  ready: "可使用",
  failed: "处理失败"
};

export function KnowledgeAdminPanel({
  documents,
  isLoading,
  isUploading,
  error,
  onRefresh,
  onUpload,
  onDelete,
  onReindex
}: KnowledgeAdminPanelProps) {
  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file) {
      void onUpload(file);
    }
  };

  return (
    <Box className="knowledge-admin-panel">
      <Box className="panel-heading compact">
        <Box>
          <span className="eyebrow">知识资产</span>
          <Typography component="h2" variant="h6">
            知识库
          </Typography>
          <Typography className="panel-description" component="p">
            上传资料，让 Agent 在回答中检索和引用。
          </Typography>
        </Box>
        <Box className="knowledge-actions">
          <Tooltip title="刷新">
            <span>
              <IconButton aria-label="刷新知识库" className="panel-icon-button" disabled={isLoading} size="small" onClick={onRefresh}>
                <RefreshCw size={16} />
              </IconButton>
            </span>
          </Tooltip>
          <Button className="knowledge-upload-button" component="label" disabled={isUploading} size="small" startIcon={<Upload size={15} />}>
            上传
            <input
              aria-label="上传知识库文档"
              hidden
              type="file"
              accept=".pdf,.doc,.docx,.md,.markdown,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              onChange={handleUpload}
            />
          </Button>
        </Box>
      </Box>

      {isLoading || isUploading ? <LinearProgress className="knowledge-progress" /> : null}
      {error ? (
        <Alert className="knowledge-error" severity="error">
          {error}
        </Alert>
      ) : null}

      <Box className="knowledge-document-list">
        {documents.length === 0 ? (
          <Box className="knowledge-empty">
            <span className="knowledge-empty-icon" aria-hidden="true">
              <FileText size={20} />
            </span>
            <Typography component="strong">还没有知识文档</Typography>
            <Typography component="p">上传 PDF、Word、Markdown 或 TXT 文件。</Typography>
          </Box>
        ) : (
          documents.map((document) => (
            <Box className="knowledge-document-item" key={document.id}>
              <Box className="knowledge-document-main">
                <FileText size={16} />
                <Box className="knowledge-document-copy">
                  <Typography component="strong">{document.name}</Typography>
                  <Box className="knowledge-document-meta">
                    <Chip color={statusColor[document.status]} label={statusText[document.status]} size="small" variant="outlined" />
                    <span>{document.chunkCount} 个片段</span>
                  </Box>
                  {document.errorMessage ? <span className="knowledge-document-error">{document.errorMessage}</span> : null}
                </Box>
              </Box>
              <Box className="knowledge-document-actions">
                <Tooltip title="重新索引">
                  <span>
                    <IconButton
                      aria-label={`重新索引 ${document.name}`}
                      className="panel-icon-button"
                      disabled={document.status === "indexing"}
                      size="small"
                      onClick={() => {
                        void onReindex(document.id);
                      }}
                    >
                      <RotateCw size={15} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="删除">
                  <span>
                    <IconButton
                      aria-label={`删除 ${document.name}`}
                      className="panel-icon-button danger"
                      size="small"
                      onClick={() => {
                        void onDelete(document.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
