import { Box, IconButton, Paper, Stack, TextField, Tooltip } from "@mui/material";
import { Send, Square } from "lucide-react";
import type { FormEvent } from "react";
import { PartComposer } from "./PartComposer";
import type { RuntimePart } from "../prosemirror/part-serialization";

interface AgentComposerProps {
  parts: RuntimePart[];
  maxIterations: number;
  isStreaming: boolean;
  focusToken?: number;
  onPartsChange: (parts: RuntimePart[]) => void;
  onMaxIterationsChange: (value: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function AgentComposer(props: AgentComposerProps) {
  const canSubmit = hasSubmittableParts(props.parts);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    props.onSubmit();
  }

  function handleComposerSubmit() {
    if (!canSubmit) {
      return;
    }

    props.onSubmit();
  }

  const submitButtonLabel = props.isStreaming ? "停止" : "发送";

  return (
    <Paper component="form" className="chat-composer" elevation={0} onSubmit={handleSubmit}>
      <PartComposer
        parts={props.parts}
        focusToken={props.focusToken}
        onChange={props.onPartsChange}
        onSubmit={handleComposerSubmit}
        onCancel={props.onCancel}
      />

      <Stack className="composer-toolbar" direction="row" spacing={1}>
        <TextField
          className="iteration-field"
          label="迭代"
          id="max-iterations"
          type="number"
          value={props.maxIterations}
          onChange={(event) => props.onMaxIterationsChange(Number(event.target.value))}
          slotProps={{
            htmlInput: {
              min: 1,
              max: 8
            }
          }}
        />

        <Box className="composer-spacer" />
        <Tooltip title={submitButtonLabel}>
          <span>
            <IconButton
              className={`primary-button composer-submit-button ${props.isStreaming ? "stop" : "send"}`}
              type={props.isStreaming ? "button" : "submit"}
              size="small"
              aria-label={submitButtonLabel}
              disabled={!props.isStreaming && !canSubmit}
              onClick={props.isStreaming ? props.onCancel : undefined}
            >
              {props.isStreaming ? <Square size={18} /> : <Send size={18} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Paper>
  );
}

function hasSubmittableParts(parts: RuntimePart[]) {
  return parts.some((part) => part.type === "media" || (part.type === "text" && part.value.trim().length > 0));
}
