import { Box, Chip, Paper, Stack } from "@mui/material";
import { CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import { ToolResultPreview, type ToolImageActionPayload } from "./ToolResultPreview";
import type { ToolTrace, ToolTraceStatus } from "../utils/tool-traces";

interface ToolTraceCardProps {
  trace: ToolTrace;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

const statusText: Record<ToolTraceStatus, string> = {
  pending: "准备中",
  running: "执行中",
  success: "成功",
  failed: "失败"
};

function StatusIcon({ status }: { status: ToolTraceStatus }) {
  switch (status) {
    case "pending":
      return <Clock3 size={14} />;
    case "running":
      return <Loader2 size={14} className="spin" />;
    case "success":
      return <CheckCircle2 size={14} />;
    case "failed":
      return <XCircle size={14} />;
  }
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) {
    return null;
  }

  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

function getPrimaryArgument(trace: ToolTrace) {
  const args = trace.arguments ?? {};
  // 卡片头部只拿最能识别本次调用的字段，详细参数仍放在结果预览/JSON 里。
  // 这样搜索、图片、计算这几类常见工具都能一扫就知道“它拿什么去调用”。
  const value = args.query ?? args.prompt ?? args.expression;

  if (value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

export function ToolTraceCard({ trace, onImageAction }: ToolTraceCardProps) {
  const duration = formatDuration(trace.durationMs);
  const primaryArgument = getPrimaryArgument(trace);

  return (
    <Paper component="article" className={`tool-trace-card tool-trace-${trace.status}`} elevation={0}>
      <Box component="header" className="tool-trace-header">
        <Box>
          <div className="tool-trace-name">{trace.toolName}</div>
          {primaryArgument ? <p>{primaryArgument}</p> : null}
        </Box>
        <Stack className="tool-trace-meta" direction="row" spacing={0.75}>
          <Chip className={`tool-status-pill ${trace.status}`} size="small" icon={<StatusIcon status={trace.status} />} label={statusText[trace.status]} />
          {duration ? <Chip className="tool-duration" size="small" label={duration} /> : null}
        </Stack>
      </Box>
      <ToolResultPreview trace={trace} onImageAction={onImageAction} />
    </Paper>
  );
}
