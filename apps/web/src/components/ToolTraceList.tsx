import { Accordion, AccordionDetails, AccordionSummary, Box, Chip } from "@mui/material";
import { ChevronDown, Wrench } from "lucide-react";
import type { AgentStreamEvent } from "../api/agent-client";
import { buildToolTraces } from "../utils/tool-traces";
import type { ToolImageActionPayload } from "./ToolResultPreview";
import { ToolTraceCard } from "./ToolTraceCard";

interface ToolTraceListProps {
  events?: AgentStreamEvent[];
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

export function ToolTraceList({ events = [], onImageAction }: ToolTraceListProps) {
  // 后端已经持续发出细粒度事件，第一版可观测 UI 不改协议。
  // 这里在前端把事件聚合成 ToolTrace，既能复用旧 run 的事件，也避免为了展示层新增后端表结构。
  const traces = buildToolTraces(events);

  if (traces.length === 0) {
    return null;
  }

  return (
    <Accordion className="tool-events" defaultExpanded>
      <AccordionSummary className="tool-events-title" expandIcon={<ChevronDown size={16} />}>
        <Box component="span" className="tool-events-label">
          <Wrench size={14} />
          工具过程
        </Box>
        <Chip className="tool-events-count" size="small" label={traces.length} />
      </AccordionSummary>
      <AccordionDetails className="tool-events-body">
        {traces.map((trace) => (
          <ToolTraceCard key={trace.id} trace={trace} onImageAction={onImageAction} />
        ))}
      </AccordionDetails>
    </Accordion>
  );
}
