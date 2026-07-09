import { Box, IconButton, Paper, Stack, Tooltip } from "@mui/material";
import { ImagePlus, Send, Square } from "lucide-react";
import { useRef, type FormEvent } from "react";
import { PartComposer, type PartComposerHandle } from "./PartComposer";
import type { RuntimePart } from "../prosemirror/part-serialization";

interface AgentComposerProps {
  parts: RuntimePart[];
  isStreaming: boolean;
  focusToken?: number;
  onPartsChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onUploadImage?: (file: File) => Promise<RuntimePart>;
}

export function AgentComposer(props: AgentComposerProps) {
  const composerRef = useRef<PartComposerHandle | null>(null);
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
        ref={composerRef}
        parts={props.parts}
        focusToken={props.focusToken}
        onChange={props.onPartsChange}
        onSubmit={handleComposerSubmit}
        onCancel={props.onCancel}
        onUploadImage={props.onUploadImage}
      />

      <Stack className="composer-toolbar" direction="row" spacing={1}>
        <Tooltip title="上传图片">
          <span>
            <IconButton
              aria-label="上传图片"
              className="composer-icon-button"
              disabled={!props.onUploadImage}
              onClick={() => composerRef.current?.openImagePicker()}
              size="small"
              type="button"
            >
              <ImagePlus size={18} />
            </IconButton>
          </span>
        </Tooltip>

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
  return parts.some((part) => part.type === "resource" || (part.type === "text" && part.value.trim().length > 0));
}
