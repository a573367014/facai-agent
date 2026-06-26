import { Box, IconButton, Paper, Stack, TextField, Tooltip } from "@mui/material";
import { Send, Square } from "lucide-react";
import type { FormEvent, KeyboardEvent, Ref } from "react";

interface AgentComposerProps {
  input: string;
  maxIterations: number;
  isStreaming: boolean;
  onInputChange: (value: string) => void;
  onMaxIterationsChange: (value: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function AgentComposer(props: AgentComposerProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!props.input.trim()) {
      return;
    }

    props.onSubmit();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;

    if (event.key !== "Enter" || event.shiftKey || nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();

    if (!props.input.trim()) {
      return;
    }

    props.onSubmit();
  }

  const submitButtonLabel = props.isStreaming ? "停止" : "发送";

  return (
    <Paper component="form" className="chat-composer" elevation={0} onSubmit={handleSubmit}>
      <TextField
        className="field"
        id="agent-input"
        placeholder="发消息..."
        value={props.input}
        inputRef={props.inputRef}
        onChange={(event) => props.onInputChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        multiline
        minRows={2}
        maxRows={6}
        fullWidth
        slotProps={{
          htmlInput: {
            "aria-label": "发消息"
          }
        }}
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
              disabled={!props.isStreaming && !props.input.trim()}
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
